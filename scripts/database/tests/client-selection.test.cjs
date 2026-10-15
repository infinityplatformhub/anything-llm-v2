/* eslint-env jest */
const path = require("node:path");
const modulePath = path.resolve(
  __dirname,
  "../../../server/utils/prisma/client.js"
);
const metadataPath = path.resolve(
  __dirname,
  "../../../server/utils/prisma/artifact.json"
);

function select(env, artifact = { provider: "sqlite" }) {
  jest.resetModules();
  jest.doMock(metadataPath, () => artifact, { virtual: true });
  const keys = [
    "ANYTHINGLLM_DATABASE_PROVIDER",
    "ANYTHINGLLM_DATABASE_URL",
    "DATABASE_URL",
  ];
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]])
  );
  keys.forEach((key) => delete process.env[key]);
  Object.assign(process.env, env);
  try {
    return require(modulePath);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    jest.dontMock(metadataPath);
  }
}

test("uses the existing SQLite client and schema datasource by default", () => {
  const selected = select({ DATABASE_URL: "postgresql://ignored/db" });
  const sqlite = require("../../../server/node_modules/@prisma/client");
  expect(selected.PrismaClient).toBe(sqlite.PrismaClient);
  expect(selected.Prisma).toBe(sqlite.Prisma);
  expect(selected.configuration).toEqual({ provider: "sqlite", url: null });
});

test("selects the separately generated PG client and its error namespace", () => {
  const selected = select(
    {
      ANYTHINGLLM_DATABASE_PROVIDER: "postgresql",
      ANYTHINGLLM_DATABASE_URL:
        "postgresql://fixture:fixture@127.0.0.1:1/fixture",
    },
    { provider: "postgresql" }
  );
  const pg = require("../../../server/generated/prisma-postgresql");
  expect(selected.PrismaClient).toBe(pg.PrismaClient);
  expect(selected.Prisma).toBe(pg.Prisma);
  expect(selected.configuration.provider).toBe("postgresql");
});

test("a PG artifact cannot silently start SQLite", () => {
  expect(() => select({}, { provider: "postgresql" })).toThrow(/built client/);
});

test("PG configuration cannot use a SQLite built artifact", () => {
  expect(() =>
    select({
      ANYTHINGLLM_DATABASE_PROVIDER: "postgresql",
      ANYTHINGLLM_DATABASE_URL:
        "postgresql://fixture:secret-sentinel@localhost/db",
    })
  ).toThrow(/built client/);
});

afterEach(() => jest.resetModules());
