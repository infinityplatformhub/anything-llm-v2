/**
 * The record of what the agent actually did in this browser.
 *
 * This is the user's only way to audit a grant that Chrome does not police for
 * them (see `allowlist.js`), so a denied command is as important to record as
 * an allowed one -- a run of denials is what a compromised server probing the
 * allowlist looks like from here.
 */

const STORAGE_KEY = "companionAuditLog";

// Enough to review a full agent run without letting extension storage grow
// without bound. A true constant, not environment-dependent, so it is inline.
const MAX_ENTRIES = 500;

// A single stored `detail` must not be able to crowd out the history around it.
// chrome.storage.local's default quota is a few megabytes for the whole
// extension, and `detail` can carry a page-derived string, which is attacker-
// influenced content of no fixed size.
const MAX_DETAIL_CHARS = 2000;

/**
 * Writes are serialised through this chain.
 *
 * `record` is read-modify-write over one storage key, and the service worker
 * interleaves at every `await`. Two commands recorded in the same turn would
 * otherwise both read the same array and the second write would overwrite the
 * first -- silently dropping exactly the entry a burst of activity most needs
 * kept. Chaining makes each record see the previous one's write.
 *
 * This is per-service-worker, and the worker is torn down after ~30s idle. That
 * is sufficient here because the races being prevented are between commands in
 * one agent run, which share a live worker; storage itself is the handoff
 * across a teardown.
 */
let writeChain = Promise.resolve();

/** @param {unknown} value @returns {string|null} */
function truncateDetail(value) {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof text !== "string") return null;
  return text.length > MAX_DETAIL_CHARS
    ? `${text.slice(0, MAX_DETAIL_CHARS)}…[truncated]`
    : text;
}

/**
 * Append one entry, oldest dropped first once the cap is reached.
 *
 * @param {{cmd: string, url?: string|null, outcome: string,
 *   detail?: unknown}} entry
 * @returns {Promise<void>} resolves once this entry is durably written
 */
export async function record({ cmd, url = null, outcome, detail = null }) {
  const append = writeChain.then(async () => {
    const stored = await chrome.storage.local.get([STORAGE_KEY]);
    const entries = Array.isArray(stored?.[STORAGE_KEY])
      ? stored[STORAGE_KEY]
      : [];
    entries.push({
      at: new Date().toISOString(),
      cmd,
      url,
      outcome,
      detail: truncateDetail(detail),
    });
    await chrome.storage.local.set({
      [STORAGE_KEY]: entries.slice(-MAX_ENTRIES),
    });
  });

  // The chain must survive a failed write, or one storage error (quota, say)
  // would leave every later record permanently rejected. The caller still sees
  // this write's own failure through the returned promise.
  writeChain = append.catch(() => {});
  return append;
}

/** @returns {Promise<Array<object>>} */
export async function readAll() {
  const stored = await chrome.storage.local.get([STORAGE_KEY]);
  return Array.isArray(stored?.[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
}

/** @returns {Promise<void>} */
export async function clear() {
  // Queued behind pending writes so a clear cannot be overtaken by a record
  // already mid-flight, which would leave one entry behind after the clear.
  const wipe = writeChain.then(() =>
    chrome.storage.local.remove([STORAGE_KEY])
  );
  writeChain = wipe.catch(() => {});
  return wipe;
}

export { STORAGE_KEY, MAX_ENTRIES, MAX_DETAIL_CHARS };
