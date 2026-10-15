function validateRecoveryKeys(provider, env) {
  if (provider === "postgresql" && (!env.SIG_KEY || !env.SIG_SALT)) {
    throw new Error(
      "PostgreSQL startup requires the preserved application encryption key pair."
    );
  }
}

async function verifyRuntimeDatabase() {
  const { configuration, Prisma } = require("./client");
  const artifact = require("./artifact.json");
  validateRecoveryKeys(configuration.provider, process.env);
  if (configuration.provider === "sqlite") return;
  await require("./preflight").preflightDatabase({
    prisma: require("./index"),
    Prisma,
    configuration,
    artifact,
  });
}

async function startAfterDatabase(start, verify = verifyRuntimeDatabase) {
  await verify();
  return start();
}

module.exports = {
  startAfterDatabase,
  verifyRuntimeDatabase,
  validateRecoveryKeys,
};
