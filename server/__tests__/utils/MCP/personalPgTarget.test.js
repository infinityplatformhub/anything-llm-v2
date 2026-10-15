const fs = require("fs");
const path = require("path");
const vm = require("vm");
test("PG startup preflight selects the same override datasource as application before launch", async () => {
  const options = [];
  let launched = false;
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../../scripts/personal-mcp-pg-start.cjs"),
    "utf8"
  );
  const sandbox = {
    process: {
      env: {
        DATABASE_URL: "postgres://fixture/preflight-a",
        ANYTHINGLLM_DATABASE_URL: "postgres://fixture/app-b",
      },
    },
    console: { error: jest.fn() },
    require(name) {
      if (name === "dotenv") return { config: () => {} };
      if (name === "@prisma/client")
        return {
          PrismaClient: class {
            constructor(opts) {
              options.push(opts);
            }
            async $queryRawUnsafe() {
              return [{ name: "fixture" }];
            }
            personal_mcp_grants = { count: async () => 0 };
            personal_mcp_contexts = { count: async () => 0 };
            async $disconnect() {}
          },
        };
      if (name === "../index.js") {
        launched = true;
        return {};
      }
      throw new Error(name);
    },
  };
  vm.runInNewContext(source, sandbox);
  await new Promise((resolve) => setImmediate(resolve));
  expect(options[0]).toEqual({
    datasources: { db: { url: "postgres://fixture/app-b" } },
  });
  expect(launched).toBe(true);
});
