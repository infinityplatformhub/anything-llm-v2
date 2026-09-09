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

// EVERY field of an entry is capped, because every field is server-controlled.
// `detail` is the obvious one (it carries page-derived text), but `url`, `cmd`
// and `outcome` arrive over the same socket from the same compromisable server
// -- and they are recorded on the DENIED path, before any check has passed. So
// the attacker-reachable path is the one that must be bounded: `record` runs on
// a URL that was never allowlisted, never visited, and chosen entirely by the
// peer. Capping `detail` alone left a 5MB url producing a 4.77MB stored entry.
//
// 2048 is the classic interop ceiling for a URL and is far above any real one;
// truncation here costs a little forensic detail and buys a hard bound.
const MAX_URL_CHARS = 2048;
// `cmd` and `outcome` are enum-like labels -- the longest real command is
// `page_navigate` at 13 characters. A generous cap still rejects a payload.
const MAX_LABEL_CHARS = 128;
const MAX_DETAIL_CHARS = 2000;

// With all four fields capped, one entry cannot exceed roughly
// 2048 + 128 + 128 + 2000 + timestamp + JSON overhead ~= 4.4KB, so the whole
// log is bounded at about 2.2MB against chrome.storage.local's ~10MB default.
// That arithmetic is the actual fix: it puts quota exhaustion by this module
// out of reach, rather than relying on the recovery path below to cope with it.

// Ceiling on how much history a recovery write tries to keep. It is only a
// ceiling: recovery halves from what was actually in the failed write, so it
// always shrinks. A fixed count would not -- when the store filled after 13
// entries, asking for 50 made the recovery write LARGER than the write that had
// just failed, so it failed too and no marker was stored. Caught by the durable
// marker test, which is why that test asserts on stored content and not on the
// flag alone.
const RECOVERY_ENTRIES = 50;

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

/**
 * Reduce any field to a bounded string.
 *
 * @param {unknown} value
 * @param {number} limit
 * @returns {string|null}
 */
function cap(value, limit) {
  if (value === null || value === undefined) return null;
  // JSON.stringify returns undefined for a function or a symbol, so the result
  // is re-checked rather than assumed to be a string.
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof text !== "string") return null;
  return text.length > limit ? `${text.slice(0, limit)}…[truncated]` : text;
}

/**
 * Set when a write fails, and never cleared by a later success.
 *
 * A quota error is the failure that matters: it means a hostile server has
 * filled the store and the user's only audit trail has stopped recording. That
 * must not be silent -- an audit log that quietly stops is worse than none,
 * because it is trusted. But it must also not throw the extension into a broken
 * state, so the signal is a flag the popup can read (task 9) rather than an
 * exception nobody catches.
 *
 * It is deliberately sticky. Clearing it on the next successful write would let
 * a burst of failures vanish the moment one small write succeeds, which is
 * exactly the window an attacker would aim for.
 *
 * @type {{at: string, message: string, recovered: boolean} | null}
 */
let writeFailure = null;

/**
 * @returns {{at: string, message: string, recovered: boolean} | null} the first
 *   write failure since the service worker started, or null if there was none
 */
export function getWriteFailure() {
  return writeFailure;
}

/** Test-only: forget the sticky failure so cases cannot bleed together. */
export function resetWriteFailure() {
  writeFailure = null;
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
      // Capped here rather than at the call sites: this is the trust boundary
      // for the log, and a caller that forgot would be an unbounded write.
      cmd: cap(cmd, MAX_LABEL_CHARS),
      url: cap(url, MAX_URL_CHARS),
      outcome: cap(outcome, MAX_LABEL_CHARS),
      detail: cap(detail, MAX_DETAIL_CHARS),
    });
    const trimmed = entries.slice(-MAX_ENTRIES);

    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: trimmed });
    } catch (error) {
      await handleWriteFailure(error, trimmed);
      throw error;
    }
  });

  // The chain must survive a failed write, or one storage error (quota, say)
  // would leave every later record permanently rejected -- turning a single
  // failure into a permanently dead audit log. The caller still sees this
  // write's own failure through the returned promise, and the failure is
  // recorded for the popup by `handleWriteFailure` either way.
  writeChain = append.catch(() => {});
  return append;
}

/**
 * Make a failed write observable, and try to get the log working again.
 *
 * Called with the chain still held, so the recovery write cannot interleave
 * with another record.
 *
 * @param {unknown} error
 * @param {Array<object>} entries what the failed write was trying to store
 */
async function handleWriteFailure(error, entries) {
  const message = error instanceof Error ? error.message : String(error);

  // 1. Always observable in the console, even if every write below fails. This
  //    is the last resort, not the mechanism -- it survives only as long as the
  //    devtools session, which is why it is not the only signal.
  console.error(
    "[AnythingLLM Companion] audit log write failed; " +
      "the record of agent activity may be incomplete:",
    message
  );

  // 2. Observable to the popup within this service-worker lifetime.
  if (!writeFailure) {
    writeFailure = { at: new Date().toISOString(), message, recovered: false };
  }

  // 3. Try to leave a DURABLE trace, which is the only kind that survives the
  //    ~30s worker teardown. A quota failure means the store is full, so the
  //    recovery write must be strictly SMALLER than the one that just failed,
  //    and it appends a marker saying history was dropped -- a gap the user can
  //    see beats a gap they cannot.
  const marker = {
    at: new Date().toISOString(),
    cmd: "audit_log",
    url: null,
    outcome: "write_failed",
    detail: cap(
      `storage write failed (${message}); older entries were dropped to ` +
        `recover. The audit log is incomplete before this point.`,
      MAX_DETAIL_CHARS
    ),
  };

  // Halve the kept history until it fits, because how much fits is not
  // knowable here: the real quota covers the whole extension, so the space
  // available to this key depends on data this module cannot see. Guessing a
  // fixed count is what made the first version of this fail. The last attempt
  // keeps nothing but the marker, so a trace survives as long as anything can
  // be written at all.
  let keep = Math.min(RECOVERY_ENTRIES, entries.length);
  for (;;) {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEY]: [...entries.slice(entries.length - keep), marker],
      });
      if (writeFailure) writeFailure.recovered = true;
      return;
    } catch {
      if (keep === 0) {
        // Nothing durable is possible. The console line and the flag stand
        // alone; the caller is already being told about the original failure,
        // which is the more useful of the two.
        return;
      }
      keep = Math.floor(keep / 2);
    }
  }
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

export {
  STORAGE_KEY,
  MAX_ENTRIES,
  MAX_DETAIL_CHARS,
  MAX_URL_CHARS,
  MAX_LABEL_CHARS,
  RECOVERY_ENTRIES,
};
