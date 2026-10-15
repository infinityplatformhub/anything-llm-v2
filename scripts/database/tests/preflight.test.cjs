const test = globalThis.test || require("node:test").test;
const assert = require("node:assert/strict");

for (const [name, schemaParameters, reachesDatabase] of [
  ["absent schema defaults to public", "", true],
  ["a single public schema is accepted", "&schema=public", true],
  ["a single encoded public schema is accepted", "&schema=%70ublic", true],
  ["wrong schema is rejected before effects", "&schema=other", false],
  ["empty schema is rejected before effects", "&schema=", false],
  [
    "case-mismatched schema is rejected before effects",
    "&schema=Public",
    false,
  ],
  [
    "duplicate public schemas are rejected before effects",
    "&schema=public&schema=public",
    false,
  ],
  [
    "public followed by wrong schema is rejected before effects",
    "&schema=public&schema=other",
    false,
  ],
  [
    "wrong followed by public schema is rejected before effects",
    "&schema=other&schema=public",
    false,
  ],
  [
    "empty followed by public schema is rejected before effects",
    "&schema=&schema=public",
    false,
  ],
  [
    "encoded duplicate schema keys are rejected before effects",
    "&schema=public&%73chema=public",
    false,
  ],
]) {
  test(name, async () => {
    const {
      preflightDatabase,
    } = require("../../../server/utils/prisma/preflight");
    const {
      startAfterDatabase,
    } = require("../../../server/utils/prisma/startup");
    const effects = [];
    await assert.rejects(
      startAfterDatabase(
        () => effects.push("app"),
        () =>
          preflightDatabase({
            configuration: {
              provider: "postgresql",
              url:
                "postgresql://fixture:password-sentinel@localhost/fixture?sslmode=require&sslaccept=strict&sslcert=/synthetic/ca.crt&connection_limit=5" +
                schemaParameters,
            },
            artifact: require("../provider-artifact.cjs").createArtifact(
              "postgresql"
            ),
            Prisma: { dmmf: { datamodel: { models: [{ name: "users" }] } } },
            prisma: {
              $queryRawUnsafe: async () => {
                effects.push("database");
                throw new Error("fixture database unavailable");
              },
            },
          })
      ),
      (error) => {
        assert.equal(
          error.message,
          "PostgreSQL preflight failed: check artifact, schema and runtime privileges."
        );
        assert.doesNotMatch(error.stack, /password-sentinel|postgresql:\/\//);
        assert.equal(error.cause, undefined);
        return true;
      }
    );
    assert.deepEqual(effects, reachesDatabase ? ["database"] : []);
  });
}

test("SQLite preflight does not access a database", async () => {
  const {
    preflightDatabase,
  } = require("../../../server/utils/prisma/preflight");
  let calls = 0;
  await preflightDatabase({
    configuration: { provider: "sqlite", url: null },
    artifact: { provider: "sqlite" },
    prisma: {
      $queryRawUnsafe: () => {
        calls++;
        throw new Error("unexpected");
      },
    },
  });
  assert.equal(calls, 0);
});

test("PG preflight rejects artifacts without schema and migration identity", async () => {
  const {
    preflightDatabase,
  } = require("../../../server/utils/prisma/preflight");
  await assert.rejects(
    preflightDatabase({
      configuration: {
        provider: "postgresql",
        url: "postgresql://fixture:fixture@localhost/fixture",
      },
      artifact: { provider: "postgresql" },
    }),
    /preflight/
  );
});

test("PG connection failures are redacted, including nested credential errors", async () => {
  const {
    preflightDatabase,
  } = require("../../../server/utils/prisma/preflight");
  const { createArtifact } = require("../provider-artifact.cjs");
  await assert.rejects(
    preflightDatabase({
      configuration: {
        provider: "postgresql",
        url: "postgresql://fixture:password-sentinel@localhost/fixture?sslmode=require&sslaccept=strict&sslcert=/synthetic/ca.crt&connection_limit=5",
      },
      artifact: createArtifact("postgresql"),
      prisma: {
        $queryRawUnsafe: async () => {
          throw new Error(
            "postgresql://fixture:password-sentinel@localhost/fixture"
          );
        },
      },
      Prisma: require("../../../server/generated/prisma-postgresql").Prisma,
    }),
    (error) => {
      assert.ok(!String(error).includes("password-sentinel"));
      assert.ok(!String(error).includes("postgresql://"));
      assert.equal(error.cause, undefined);
      return true;
    }
  );
});

for (const suffix of [
  "",
  "?sslmode=disable",
  "?sslmode=prefer",
  "?sslmode=require&sslaccept=accept_invalid_certs",
  "?sslmode=require&sslaccept=strict",
  "?sslmode=require&sslaccept=strict&sslcert=relative-ca.crt",
  "?sslmode=require&sslaccept=strict&sslcert=/synthetic/ca.crt",
  "?sslmode=require&sslaccept=strict&sslcert=/synthetic/ca.crt&connection_limit=50",
  "?sslmode=require&sslaccept=strict&sslcert=/synthetic/ca.crt&connection_limit=0",
]) {
  test(`rejects runtime PG without strict explicit CA trust (${suffix})`, async () => {
    const {
      preflightDatabase,
    } = require("../../../server/utils/prisma/preflight");
    let accessed = false;
    await assert.rejects(
      preflightDatabase({
        artifact: require("../provider-artifact.cjs").createArtifact(
          "postgresql"
        ),
        configuration: {
          provider: "postgresql",
          url: "postgresql://fixture:fixture@localhost/db" + suffix,
        },
        Prisma: require("../../../server/generated/prisma-postgresql").Prisma,
        prisma: {
          $queryRawUnsafe: async () => {
            accessed = true;
            throw new Error("Unexpected database access");
          },
        },
      })
    );
    assert.equal(accessed, false);
  });
}
