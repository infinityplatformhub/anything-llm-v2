const test = globalThis.test || require("node:test").test;
const assert = require("node:assert/strict");

test("does not start application effects before database readiness", async () => {
  const {
    startAfterDatabase,
  } = require("../../../server/utils/prisma/startup");
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  const effects = [];
  const running = startAfterDatabase(
    () => {
      effects.push("server");
    },
    () => ready
  );
  assert.deepEqual(effects, []);
  release();
  await running;
  assert.deepEqual(effects, ["server"]);
});

test("failed readiness never starts application effects", async () => {
  const {
    startAfterDatabase,
  } = require("../../../server/utils/prisma/startup");
  let started = false;
  await assert.rejects(
    startAfterDatabase(
      () => {
        started = true;
      },
      async () => {
        throw new Error("fixture failure");
      }
    )
  );
  assert.equal(started, false);
});

test("propagates application failure after a successful readiness check", async () => {
  const {
    startAfterDatabase,
  } = require("../../../server/utils/prisma/startup");
  await assert.rejects(
    startAfterDatabase(
      () => {
        throw new Error("app failure");
      },
      async () => {}
    ),
    /app failure/
  );
});
