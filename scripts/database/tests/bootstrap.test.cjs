const test = globalThis.test || require("node:test").test;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { startAfterDatabase } = require("../../../server/utils/prisma/startup");

function boot(verify) {
  const effects = [];
  const context = {
    process: { env: {}, exit: (code) => effects.push(["exit", code]) },
    console: { error: (message) => effects.push(["error", message]) },
    require(name) {
      if (name === "dotenv") return { config: () => {} };
      if (name === "./utils/prisma/startup")
        return {
          startAfterDatabase: (start) => startAfterDatabase(start, verify),
        };
      if (name === "./app") {
        effects.push(["app"]);
        return {};
      }
      if (name === "./utils/prisma")
        return { $disconnect: async () => effects.push(["disconnect"]) };
      throw new Error("Unexpected startup import");
    },
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.resolve(__dirname, "../../../server/index.js"),
      "utf8"
    ),
    context
  );
  return effects;
}

test("real bootstrap loads no application imports until the database gate passes", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const effects = boot(() => gate);
  assert.deepEqual(effects, []);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(effects, [["app"]]);
});

test("real bootstrap fails closed and redacts gate errors", async () => {
  const effects = boot(async () => {
    throw new Error("password-sentinel");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!effects.some(([name]) => name === "app"));
  assert.ok(effects.some(([name, code]) => name === "exit" && code === 1));
  assert.ok(!JSON.stringify(effects).includes("password-sentinel"));
});
