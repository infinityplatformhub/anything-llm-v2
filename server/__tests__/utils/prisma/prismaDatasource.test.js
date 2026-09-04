/* eslint-env jest */
const PRISMA_MODULE = "../../../utils/prisma";

// The datasource override must key off ANYTHINGLLM_DATABASE_URL, never
// DATABASE_URL: PaaS hosts (Render/Heroku/Railway) inject DATABASE_URL
// automatically, which would silently redirect an existing deployment's
// database away from the sqlite file the schema hardcodes.
function datasourceUrlFor(env) {
  let seen = "UNSET";
  jest.resetModules();
  jest.doMock("@prisma/client", () => ({
    PrismaClient: class {
      constructor(options) {
        seen = options.datasources ? options.datasources.db.url : "UNSET";
      }
    },
  }));

  const previous = {
    DATABASE_URL: process.env.DATABASE_URL,
    ANYTHINGLLM_DATABASE_URL: process.env.ANYTHINGLLM_DATABASE_URL,
  };
  delete process.env.DATABASE_URL;
  delete process.env.ANYTHINGLLM_DATABASE_URL;
  Object.assign(process.env, env);

  try {
    require(PRISMA_MODULE);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.dontMock("@prisma/client");
  }
  return seen;
}

describe("prisma datasource override", () => {
  test("a PaaS-injected DATABASE_URL does not redirect the database", () => {
    expect(datasourceUrlFor({ DATABASE_URL: "postgres://prod/db" })).toBe(
      "UNSET"
    );
  });

  test("ANYTHINGLLM_DATABASE_URL overrides the datasource", () => {
    expect(
      datasourceUrlFor({ ANYTHINGLLM_DATABASE_URL: "file:/tmp/e2e.db" })
    ).toBe("file:/tmp/e2e.db");
  });

  test("no override when neither variable is set", () => {
    expect(datasourceUrlFor({})).toBe("UNSET");
  });
});
