/**
 * Raw sqlite reads for assertions the HTTP surface deliberately hides
 * (ciphertext columns, audit metadata). One client is reused for the whole
 * suite; Prisma warns once past ten concurrent engines.
 */
const { PrismaClient } = require("@prisma/client");

let prisma = null;

async function withDb(environment, callback) {
  if (!prisma)
    prisma = new PrismaClient({
      datasources: { db: { url: environment.env.E2E_DATABASE_URL } },
      log: ["error"],
    });
  return callback(prisma);
}

async function closeDb() {
  if (!prisma) return;
  await prisma.$disconnect();
  prisma = null;
}

module.exports = { withDb, closeDb };

// Jest treats every JavaScript file under __tests__ as a suite; this keeps the
// helper honest when it is collected directly.
if (typeof expect !== "undefined" && expect.getState().testPath === __filename)
  test("is a helper module, not a suite", () => {
    expect(module.exports).toBeDefined();
  });
