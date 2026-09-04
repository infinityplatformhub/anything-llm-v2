const { PrismaClient } = require("@prisma/client");

// npx prisma introspect
// npx prisma generate
// npx prisma migrate dev --name init -> ensures that db is in sync with schema
// npx prisma migrate reset -> resets the db

const logLevels = ["error", "info", "warn"]; // add "query" to debug query logs
// Deliberately not DATABASE_URL: PaaS hosts inject that automatically, which
// would silently redirect the database of an existing deployment.
const databaseUrl = process.env.ANYTHINGLLM_DATABASE_URL;
const prisma = new PrismaClient({
  log: logLevels,
  ...(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : {}),
});

module.exports = prisma;
