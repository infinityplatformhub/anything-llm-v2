const test = globalThis.test || require("node:test").test;
const assert = require("node:assert/strict");

test("PG startup requires both effective application keys before database access", () => {
  const {
    validateRecoveryKeys,
  } = require("../../../server/utils/prisma/startup");
  for (const env of [{}, { SIG_KEY: "fixture" }, { SIG_SALT: "fixture" }]) {
    assert.throws(() => validateRecoveryKeys("postgresql", env));
  }
  assert.doesNotThrow(() =>
    validateRecoveryKeys("postgresql", {
      SIG_KEY: "fixture-key",
      SIG_SALT: "fixture-salt",
    })
  );
});

test("does not change legacy SQLite key-generation behavior", () => {
  const {
    validateRecoveryKeys,
  } = require("../../../server/utils/prisma/startup");
  assert.doesNotThrow(() => validateRecoveryKeys("sqlite", {}));
});

test("key errors do not disclose supplied values", () => {
  const {
    validateRecoveryKeys,
  } = require("../../../server/utils/prisma/startup");
  assert.throws(
    () => validateRecoveryKeys("postgresql", { SIG_KEY: "secret-sentinel" }),
    (error) => !String(error).includes("secret-sentinel")
  );
});
