const test = globalThis.test || require("node:test").test;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(
  path.resolve(__dirname, "../../../server/prisma/schema.prisma"),
  "utf8"
);

function build(sourceSchema) {
  return require("../postgresql-schema.cjs").buildPostgresqlSchema(
    sourceSchema
  );
}

test("preserves every fork model and logical attribute unchanged", () => {
  const result = build(source);
  const models = source.slice(source.indexOf("model "));
  assert.equal(
    result
      .slice(result.indexOf("model "))
      .replace(/ @db\.Timestamptz\(3\)/g, ""),
    models
  );
});

test("uses explicit PG configuration and an isolated generated client", () => {
  const result = build(source);
  assert.match(result, /provider\s*=\s*"postgresql"/);
  assert.match(result, /url\s*=\s*env\("ANYTHINGLLM_DATABASE_URL"\)/);
  assert.match(
    result,
    /output\s*=\s*"\.\.\/\.\.\/generated\/prisma-postgresql"/
  );
  assert.doesNotMatch(result, /env\("DATABASE_URL"\)/);
  assert.doesNotMatch(result, /provider\s*=\s*"sqlite"/);
});

test("stores every DateTime as an instant with original millisecond precision", () => {
  const result = build(source);
  const sourceDates = source
    .split("\n")
    .filter((line) => /^\s*\w+\s+DateTime\??(?:\s|$)/.test(line));
  const targetDates = result
    .split("\n")
    .filter((line) => /^\s*\w+\s+DateTime\??(?:\s|$)/.test(line));
  assert.ok(sourceDates.length > 0);
  assert.equal(targetDates.length, sourceDates.length);
  for (const line of targetDates) assert.match(line, /@db\.Timestamptz\(3\)/);
});

test("does not invent relations for intentionally unrelated IDs", () => {
  const result = build(source);
  assert.match(result, /router_id\s+Int\? \/\/ No relation/);
  assert.match(result, /thread_id\s+Int\? \/\/ No relation/);
  assert.match(
    result,
    /memoryProcessed\s+Boolean\? @map\("memory_processed"\)/
  );
  assert.match(result, /model lark_oauth_states \{\s+state\s+String\s+@id/);
});

test("rejects a source that is not the expected SQLite schema", () => {
  const { buildPostgresqlSchema } = require("../postgresql-schema.cjs");
  assert.throws(() =>
    buildPostgresqlSchema(
      source.replace('provider = "sqlite"', 'provider = "postgresql"')
    )
  );
  assert.throws(() => buildPostgresqlSchema(""));
});

test("rejects existing provider-specific annotations instead of erasing them", () => {
  const { buildPostgresqlSchema } = require("../postgresql-schema.cjs");
  assert.throws(() =>
    buildPostgresqlSchema(
      source.replace(
        "username                     String?",
        "username                     String? @db.VarChar(32)"
      )
    )
  );
});

test("checked-in PG schema matches the reviewed derivation of the fork", () => {
  const target = fs.readFileSync(
    path.resolve(__dirname, "../../../server/prisma/postgresql/schema.prisma"),
    "utf8"
  );
  assert.equal(target, build(source));
});

test("includes personal MCP models and relations once in each provider", () => {
  const postgres = build(source);
  for (const schema of [source, postgres]) {
    assert.equal([...schema.matchAll(/^model /gm)].length, 40);
    for (const name of ["personal_mcp_grants", "personal_mcp_contexts"]) {
      assert.equal(
        [...schema.matchAll(new RegExp(`^model ${name} \\{`, "gm"))].length,
        1
      );
      assert.equal(
        [...schema.matchAll(new RegExp(`^\\s+${name}\\s+${name}\\[\\]`, "gm"))]
          .length,
        2
      );
    }
  }
});
