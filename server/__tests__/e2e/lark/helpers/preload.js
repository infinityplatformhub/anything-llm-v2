/**
 * Test-only preload for every process in the E2E suite. The server child gets it
 * through `node --require`; the Jest worker requires it as the first line of the
 * suite, before any product module is loaded.
 *
 * 1. Node >= 24 removed buffer.SlowBuffer, which jsonwebtoken's
 *    buffer-equal-constant-time still reads at require time.
 *    ponytail: drop when jsonwebtoken drops buffer-equal-constant-time.
 * 2. schema.prisma hardcodes `file:../storage/anythingllm.db` and exposes no
 *    DATABASE_URL, so the generated client is repointed at the throwaway
 *    database named by E2E_DATABASE_URL.
 *
 * The database URL is read lazily, per client construction, because the Jest
 * worker only learns the temp path in beforeAll. Without the variable the
 * subclass is a pass-through, so this file can never redirect a production boot.
 *
 * Every Lark host now derives from LARK_BASE_URL / LARK_ACCOUNTS_URL, so the
 * mock is reached through configuration alone and no fetch patching is needed.
 */
const buffer = require("buffer");
if (!buffer.SlowBuffer) buffer.SlowBuffer = buffer.Buffer;

const client = require("@prisma/client");
const OriginalPrismaClient = client.PrismaClient;
class E2EPrismaClient extends OriginalPrismaClient {
  constructor(options = {}) {
    const url = process.env.E2E_DATABASE_URL;
    super(url ? { ...options, datasources: { db: { url } } } : options);
  }
}
Object.defineProperty(client, "PrismaClient", {
  value: E2EPrismaClient,
  writable: true,
  enumerable: true,
  configurable: true,
});

// Jest treats every JavaScript file under __tests__ as a suite.
if (typeof expect !== "undefined" && expect.getState().testPath === __filename)
  test("is a preload module, not a suite", () => {
    expect(buffer.SlowBuffer).toBeDefined();
  });
