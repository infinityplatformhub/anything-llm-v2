const test = globalThis.test || require("node:test").test;
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

test("binds the PG artifact to exact checked-in schema and migration bytes", () => {
  const { createArtifact } = require("../provider-artifact.cjs");
  const artifact = createArtifact("postgresql");
  const root = path.resolve(__dirname, "../../../server/prisma/postgresql");
  assert.equal(artifact.provider, "postgresql");
  assert.equal(
    artifact.schemaSha256,
    crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(root, "schema.prisma")))
      .digest("hex")
  );
  assert.deepEqual(
    artifact.migrations.map((migration) => migration.name),
    ["20261008000000_initial", "20261008020000_preserve_live_personal_mcp"]
  );
  assert.equal(
    artifact.migrations[0].sha256,
    crypto
      .createHash("sha256")
      .update(
        fs.readFileSync(
          path.join(root, "migrations/20261008000000_initial/migration.sql")
        )
      )
      .digest("hex")
  );
});

test("SQLite artifact does not accidentally acquire PG identity", () => {
  assert.deepEqual(
    require("../provider-artifact.cjs").createArtifact("sqlite"),
    { provider: "sqlite" }
  );
});

test("rejects unrecognized build providers", () => {
  const { createArtifact } = require("../provider-artifact.cjs");
  assert.throws(() => createArtifact("mysql"));
});
