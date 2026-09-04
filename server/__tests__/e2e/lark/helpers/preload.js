/**
 * Test-only preload for every process in the E2E suite. The server child gets it
 * through `node --require`; the Jest worker requires it as the first line of the
 * suite, before any product module is loaded.
 *
 * 1. Node >= 24 removed buffer.SlowBuffer, which jsonwebtoken's
 *    buffer-equal-constant-time still reads at require time.
 *    ponytail: drop when jsonwebtoken drops buffer-equal-constant-time.
 * 2. `APP_ACCESS_TOKEN_URL` in utils/lark/settings.js is a hardcoded
 *    open.larksuite.com literal with no env override, so the admin
 *    test-connection route cannot be pointed at the mock the way the other Lark
 *    URLs can. E2E_LARK_HOST_REWRITE redirects that host at the fetch layer,
 *    which leaves the product code path untouched.
 * 3. schema.prisma hardcodes `file:../storage/anythingllm.db` and exposes no
 *    DATABASE_URL, so the generated client is repointed at the throwaway
 *    database named by E2E_DATABASE_URL.
 *
 * Both variables are read lazily, per construction and per request, because the
 * Jest worker only learns the temp paths in beforeAll. A missing variable makes
 * the corresponding patch a pass-through, so this file can never redirect a
 * production boot.
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

const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const rewrite = process.env.E2E_LARK_HOST_REWRITE;
  if (!rewrite) return originalFetch(input, init);
  const [fromOrigin, toOrigin] = rewrite.split("=>");
  const target =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input?.url;
  if (typeof target === "string" && target.startsWith(fromOrigin))
    return originalFetch(target.replace(fromOrigin, toOrigin), init);
  return originalFetch(input, init);
};

// Jest treats every JavaScript file under __tests__ as a suite.
if (typeof expect !== "undefined" && expect.getState().testPath === __filename)
  test("is a preload module, not a suite", () => {
    expect(buffer.SlowBuffer).toBeDefined();
  });
