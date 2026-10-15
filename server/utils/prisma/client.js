const artifact = require("./artifact.json");
const { resolveDatabaseConfiguration } = require("./configuration");

// Validate before loading a client: a provider URL cannot change a built client.
const configuration = resolveDatabaseConfiguration(process.env, artifact);
const client =
  configuration.provider === "postgresql"
    ? require("../../generated/prisma-postgresql")
    : require("@prisma/client");

module.exports = {
  PrismaClient: client.PrismaClient,
  Prisma: client.Prisma,
  configuration,
};
