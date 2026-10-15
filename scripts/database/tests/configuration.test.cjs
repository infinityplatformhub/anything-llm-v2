const test = globalThis.test || require("node:test").test;
const assert = require("node:assert/strict");

// Loading inside the test makes the missing implementation an explicit red case.
function resolve(env, artifact) {
  return require("../../../server/utils/prisma/configuration").resolveDatabaseConfiguration(
    env,
    artifact
  );
}

const PG = { provider: "postgresql" };
const PG_URL = "postgresql://fixture:password-sentinel@localhost:5432/fixture";
const pgEnv = (url = PG_URL) => ({
  ANYTHINGLLM_DATABASE_PROVIDER: "postgresql",
  ANYTHINGLLM_DATABASE_URL: url,
});

test("retains the default SQLite datasource", () => {
  assert.deepEqual(resolve(), { provider: "sqlite", url: null });
});

test("ignores ambient DATABASE_URL", () => {
  assert.deepEqual(resolve({ DATABASE_URL: PG_URL }), {
    provider: "sqlite",
    url: null,
  });
});

test("accepts an existing explicit SQLite file override", () => {
  assert.deepEqual(
    resolve({ ANYTHINGLLM_DATABASE_URL: "file:../storage/fixture.db" }),
    { provider: "sqlite", url: "file:../storage/fixture.db" }
  );
});

test("explicit SQLite may keep its schema-defined URL", () => {
  assert.deepEqual(resolve({ ANYTHINGLLM_DATABASE_PROVIDER: "sqlite" }), {
    provider: "sqlite",
    url: null,
  });
});

for (const scheme of ["postgresql", "postgres"]) {
  test(`accepts explicit PG config using ${scheme}`, () => {
    const url = `${scheme}://fixture:password-sentinel@localhost:5432/fixture`;
    assert.deepEqual(resolve(pgEnv(url), PG), { provider: "postgresql", url });
  });
}

const rejections = [
  ["PG URL without provider", { ANYTHINGLLM_DATABASE_URL: PG_URL }],
  ["PG artifact without explicit config", {}, PG],
  [
    "ambient URL cannot supply PG configuration",
    { ANYTHINGLLM_DATABASE_PROVIDER: "postgresql", DATABASE_URL: PG_URL },
    PG,
  ],
  ["PG configuration in SQLite artifact", pgEnv()],
  [
    "SQLite configuration in PG artifact",
    {
      ANYTHINGLLM_DATABASE_PROVIDER: "sqlite",
      ANYTHINGLLM_DATABASE_URL: "file:fixture.db",
    },
    PG,
  ],
  ["unknown artifact", {}, { provider: "mysql" }],
];
for (const provider of ["mysql", "", "POSTGRESQL", 1]) {
  rejections.push([
    `invalid provider ${JSON.stringify(provider)}`,
    {
      ANYTHINGLLM_DATABASE_PROVIDER: provider,
    },
  ]);
}
for (const url of ["file:", "https://localhost/fixture", 1]) {
  rejections.push([
    `invalid SQLite URL ${JSON.stringify(url)}`,
    {
      ANYTHINGLLM_DATABASE_URL: url,
    },
  ]);
}
for (const url of [
  "",
  "file:fixture.db",
  "https://localhost/fixture",
  "postgresql://",
  "postgresql://localhost",
  "postgresql://localhost:invalid/fixture",
  1,
]) {
  rejections.push([`invalid PG URL ${JSON.stringify(url)}`, pgEnv(url), PG]);
}
for (const [name, env, artifact] of rejections) {
  test(`rejects ${name}`, () => {
    // A missing module must not count as a successful validation rejection.
    const {
      resolveDatabaseConfiguration,
    } = require("../../../server/utils/prisma/configuration");
    assert.throws(() => resolveDatabaseConfiguration(env, artifact), Error);
  });
}

test("does not mutate caller configuration or artifact", () => {
  assert.deepEqual(resolve(Object.freeze(pgEnv()), Object.freeze(PG)), {
    provider: "postgresql",
    url: PG_URL,
  });
});

for (const [name, env, artifact] of [
  ["mismatch", pgEnv()],
  [
    "provider",
    { ...pgEnv(), ANYTHINGLLM_DATABASE_PROVIDER: "password-sentinel" },
    PG,
  ],
  [
    "malformed URL",
    pgEnv("postgresql://fixture:password-sentinel@localhost:invalid/fixture"),
    PG,
  ],
]) {
  test(`redacts sensitive input in ${name} errors`, () => {
    const {
      resolveDatabaseConfiguration,
    } = require("../../../server/utils/prisma/configuration");
    assert.throws(
      () => resolveDatabaseConfiguration(env, artifact),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!String(error).includes("password-sentinel"));
        assert.ok(!String(error).includes("postgresql://"));
        assert.equal(error.cause, undefined);
        return true;
      }
    );
  });
}
