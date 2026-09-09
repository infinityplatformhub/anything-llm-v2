/**
 * The wire: one long-lived WebSocket to AnythingLLM, plus the tab the agent
 * acts in.
 *
 * THE KEY DOES NOT TRAVEL IN THE URL
 *
 * `server/endpoints/browserExtension.js` accepts the key two ways and says
 * plainly which one this client should choose. The upgrade request is an
 * ordinary HTTP GET, so `?key=brx-...` is written verbatim into the access log
 * of every reverse proxy, ingress and CDN in front of the server — plaintext,
 * at rest for weeks, on infrastructure this repo does not configure. So the
 * supported transport is the `Sec-WebSocket-Protocol` list, and the key is the
 * SECOND value in it:
 *
 *   new WebSocket(url, [COMPANION_SUBPROTOCOL, apiKey])
 *
 * THE ORDER IS LOAD-BEARING, NOT STYLE. `ws` selects the FIRST offered
 * subprotocol and echoes only that one back in the handshake response. With the
 * marker first, the marker is what appears on the wire. With the key first, the
 * key is echoed in a response header — which moves the leak rather than closing
 * it, and the browser `WebSocket` constructor then rejects the connection
 * anyway because it did not offer the value the server answered with.
 * `browserCompanionKeyFrom` indexes `tokens[1]` for the same reason: a client
 * offering extra subprotocols cannot shift which value is read as the
 * credential.
 *
 * `wsUrlFor` still builds the deprecated `?key=` form because the server still
 * accepts it and this module's contract names it, but nothing on the connect
 * path calls it with a key. See its own comment.
 *
 * MV3 IS THE REASON EVERYTHING HERE LOOKS DEFENSIVE
 *
 * The service worker is torn down after ~30s with no events, and the socket
 * dies with it. So:
 *   - This module's state is per-worker-lifetime, not per-session. Anything
 *     that must survive a teardown lives in `chrome.storage`, and everything
 *     here is rebuilt from it on the next wake.
 *   - `setTimeout` does NOT survive a teardown, so the reconnect timer is a
 *     best-effort fast path only. `chrome.alarms` is the durable backstop: an
 *     alarm firing is what WAKES the worker, and `keepalive()` is what it does
 *     when it gets there.
 *   - See KEEPALIVE_MINUTES for the sub-minute alarm limitation, which is a
 *     shipping blocker for the Web Store build and is recorded as such.
 */
import { record as auditRecord } from "./auditLog.js";

/**
 * Path the server mounts the agent socket on, relative to `apiBase`.
 * A wire constant: changing it is a server change, not a deployment setting.
 */
const SOCKET_PATH = "browser-companion/agent-socket";

/**
 * The marker the server matches on, verbatim from
 * `BROWSER_COMPANION_SUBPROTOCOL` in server/endpoints/browserExtension.js.
 * These two strings are one wire contract; they must not drift.
 */
const COMPANION_SUBPROTOCOL = "anythingllm-browser-companion";

/**
 * Close codes the server uses, from the same file. 4000-4999 is the range RFC
 * 6455 reserves for the application, so these are a wire protocol, not config.
 *
 * The distinction that matters is TERMINAL vs RETRYABLE. Reconnecting against a
 * terminal code is not merely useless:
 *
 *   - 4409 means a second browser took this user's registry slot. Reconnecting
 *     would take it back, whereupon the OTHER browser is evicted and reconnects,
 *     and the two fight over one slot forever — a self-inflicted denial of
 *     service that neither user can see the cause of. So 4409 stops, and the
 *     user is told to reconnect from the popup if this browser is the one they
 *     want driven.
 *   - 4401/4403 mean the key is wrong or the account may not connect. No amount
 *     of retrying makes a rejected credential valid; retrying just turns a
 *     configuration mistake into a login-attempt flood.
 *
 * 1011 is the server's own internal error and IS retryable — it is the shape a
 * transient server-side failure takes.
 */
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_FORBIDDEN = 4403;
const CLOSE_EVICTED = 4409;

const TERMINAL_CLOSES = new Map([
  [
    CLOSE_UNAUTHORIZED,
    {
      status: "unauthorized",
      error:
        "AnythingLLM rejected this API key. Open the extension and reconnect to get a new one.",
    },
  ],
  [
    CLOSE_FORBIDDEN,
    {
      status: "unauthorized",
      error:
        "This AnythingLLM account is not allowed to connect a browser. Ask an admin, then reconnect.",
    },
  ],
  [
    CLOSE_EVICTED,
    {
      status: "evicted",
      error:
        "Another browser connected with this account and took over. Reconnect from the extension if this browser should be the one the agent drives.",
    },
  ],
]);

/** ws readyState for OPEN. Named because a bare `1` at the send guard reads as a magic number. */
const WS_OPEN = 1;

const KEEPALIVE_ALARM = "companionKeepalive";

/**
 * How often the alarm wakes the worker.
 *
 * THIS VALUE IS A KNOWN SHIPPING LIMITATION, NOT A TUNING CHOICE.
 *
 * An MV3 service worker is torn down after ~30s idle, so anything at or above
 * one minute cannot keep it alive — by the time the alarm fires the worker is
 * already gone and the socket with it. Chrome honours a period below one minute
 * ONLY for an UNPACKED extension; once the extension is installed from the Web
 * Store the period is clamped up to 1 minute and this keepalive silently stops
 * keeping anything alive. It will work in every dev test and fail in the
 * shipped build, which is the worst possible failure shape, so it is written
 * down here rather than discovered later.
 *
 * That is survivable for THIS round only because the distribution plan is an
 * unpacked extension (spec limitation 3). Before a Web Store release this must
 * move to a server-side WebSocket ping, which resets the idle timer from the
 * other end and needs no alarm at all.
 *
 * Derived from the teardown window rather than written as a bare fraction, so
 * the relationship between the two is visible and a future edit to one does not
 * silently invalidate the other.
 */
const MV3_IDLE_TEARDOWN_SECONDS = 30;
const KEEPALIVE_MINUTES = MV3_IDLE_TEARDOWN_SECONDS / 60 / 2;

/**
 * Reconnect backoff. Bounded and jittered, because a server that is down is
 * down for every installed extension at once: an unjittered fixed retry turns
 * a brief outage into a synchronised thundering herd the moment it recovers.
 *
 * True constants — they describe how hard this client may lean on a server that
 * is not answering, which is a property of the protocol and not of any one
 * deployment.
 */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * The tab the agent starts in. `about:blank` is deliberately NOT in any
 * allowlist (`isAllowed` refuses every scheme but http/https), so a fresh agent
 * tab can be navigated — `page_navigate` is gated on its destination — and
 * nothing else. That is the intended bootstrap and the intended default-deny.
 */
const BLANK_URL = "about:blank";

/**
 * A subprotocol token must be an RFC 7230 `token`. A key containing anything
 * else makes the `WebSocket` constructor throw a bare SyntaxError with no hint
 * about which argument was wrong, so it is checked here and named.
 */
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/* ------------------------------------------------------------------------- */
/* Per-worker state. Rebuilt on every wake; nothing here survives a teardown. */
/* ------------------------------------------------------------------------- */

let socket = null;
let status = "idle";
let lastError = null;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer = null;
/** The config the last `connect` was called with, so a wake can reconnect without re-reading storage. */
let config = null;
/** Commands run one at a time; see `enqueueCommand`. */
let commandQueue = Promise.resolve();

/** The tab id this module believes is the agent's. */
let agentTabId = null;
/**
 * Tabs THIS module opened, so cleanup can never close one the user opened.
 * Per-worker like everything else here: after a teardown a previously created
 * tab is simply not a cleanup candidate, which fails safe.
 */
const createdTabIds = new Set();
/** The in-flight `resolveAgentTab`, so concurrent callers cannot open two tabs. */
let resolving = null;
/** The tab id `agentTabUrl` reported inside the current command scope. See `ensureAgentTab`. */
let boundTabId = null;

/* ------------------------------------------------------------------------- */
/* URLs                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * The socket URL, with NO credential in it.
 *
 * @param {unknown} apiBase e.g. `https://workspace.approof.studio/api`
 * @returns {string}
 * @throws {TypeError} when apiBase is not a URL, rather than building a broken one
 */
export function socketUrlFor(apiBase) {
  // The trailing slash is re-added after stripping any the user typed, because
  // `new URL("browser-companion/...", ".../api")` without it resolves against
  // the PARENT of `/api` and silently drops the api prefix.
  const base = new URL(String(apiBase).replace(/\/+$/, "") + "/");
  // Assigning `protocol` is honoured here because ws/wss are special schemes in
  // the URL spec, like http/https. It would be a silent no-op for a
  // non-special target, which is why this is verified by a test rather than
  // assumed.
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return new URL(SOCKET_PATH, base).toString();
}

/**
 * The DEPRECATED `?key=` form.
 *
 * Kept because the server still accepts it and this module's contract names it,
 * but NOTHING on the connect path calls it with a key: see the module header
 * for why the query string is the wrong place for a long-lived credential. It
 * exists so that a caller reaching for the fallback reaches for something that
 * encodes correctly, rather than concatenating the key onto a string — and so
 * the URL-building logic itself has one home.
 *
 * @param {unknown} apiBase
 * @param {unknown} [apiKey] omitted or undefined yields the credential-free URL
 * @returns {string}
 */
export function wsUrlFor(apiBase, apiKey) {
  const url = new URL(socketUrlFor(apiBase));
  // `searchParams.set`, never string concatenation: a key is opaque and may
  // contain `&`, `#` or a space, each of which silently truncates or corrupts a
  // hand-built query string.
  if (apiKey !== undefined && apiKey !== null)
    url.searchParams.set("key", apiKey);
  return url.toString();
}

/**
 * @returns {{status: "idle"|"connecting"|"online"|"evicted"|"unauthorized", lastError: string|null}}
 *
 * `connecting` and `unauthorized` are additions to the three states the task
 * brief names, and both earn their place in the popup task 9 builds on this:
 * without `unauthorized` a rejected key is indistinguishable from `idle`, so
 * the one message the user must see ("your key is wrong") cannot be shown.
 */
export function state() {
  return { status, lastError };
}

/* ------------------------------------------------------------------------- */
/* The agent's tab                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Resolve the agent's tab, creating it if it is gone. Serialised.
 *
 * The serialisation is not an optimisation. Two concurrent callers finding
 * `agentTabId === null` would each call `chrome.tabs.create` and the second
 * would overwrite `agentTabId`, leaving an orphan tab open in the user's
 * browser forever and — worse — leaving the two callers holding different tab
 * ids for the same logical "agent tab".
 *
 * @returns {Promise<{id: number, url: string}>}
 */
function resolveAgentTab() {
  if (!resolving) {
    resolving = doResolveAgentTab().finally(() => {
      resolving = null;
    });
  }
  return resolving;
}

async function doResolveAgentTab() {
  if (agentTabId !== null) {
    try {
      const tab = await chrome.tabs.get(agentTabId);
      if (tab && typeof tab.id === "number")
        return { id: tab.id, url: tabUrl(tab) };
    } catch {
      // The user closed it. Fall through and open a new one.
      agentTabId = null;
    }
  }

  // The agent gets its own tab so it never takes over what the user is reading,
  // and `active: false` so opening one does not yank focus mid-sentence. Same
  // profile, so it still carries the user's cookies and session — which is the
  // whole point of driving the user's own browser.
  const created = await chrome.tabs.create({ url: BLANK_URL, active: false });
  if (typeof created?.id !== "number")
    throw new Error(
      "Chrome did not return a tab id for the agent's tab; the agent has no page to act on."
    );
  agentTabId = created.id;
  createdTabIds.add(created.id);
  return { id: created.id, url: tabUrl(created) };
}

/**
 * A tab's url as the gate should see it.
 *
 * A tab that has just been created, or is mid-navigation, reports `""` or
 * `undefined` rather than a url. Falling back to `about:blank` keeps the gate
 * judging a string it will REFUSE, which is the safe reading; returning the
 * empty string would make `isAllowed` refuse it too, but via the "not a url"
 * path, which reads in the audit log as a malformed command rather than as a
 * blank page.
 */
function tabUrl(tab) {
  return typeof tab?.url === "string" && tab.url ? tab.url : BLANK_URL;
}

/**
 * Forget the per-command tab binding. Called once per inbound command frame,
 * from the message handler — NOT exported, because a binding whose reset a
 * caller has to remember is a binding that fails open the first time someone
 * forgets.
 */
function beginCommandScope() {
  boundTabId = null;
}

/**
 * The url the allowlist gate judges.
 *
 * @returns {Promise<string>}
 */
export async function agentTabUrl() {
  const tab = await resolveAgentTab();
  boundTabId = tab.id;
  return tab.url;
}

/**
 * The tab every command acts on.
 *
 * THE POINT OF THE BINDING CHECK
 *
 * `dispatch.handle` calls `agentTabUrl()` to decide whether the page is allowed
 * and then, separately, `ensureAgentTab()` to get the tab to act on. If the
 * user closes the agent's tab between those two calls, a naive implementation
 * quietly opens a NEW one — and then the allowlist judged tab A's url while the
 * action lands on tab B. For `page_close` that is the whole gate defeated: the
 * command is permitted because tab A was on an allowed page, and the tab that
 * actually gets closed is a different one. Nothing on the dispatch side can
 * detect this, because from there both calls returned successfully.
 *
 * So the two accessors are bound: within one command, if `agentTabUrl` reported
 * a tab, `ensureAgentTab` must return THAT tab or fail loudly. `handle` catches
 * the throw, records it, and answers the agent with the reason — the agent
 * retries and the second attempt is gated on the new tab's url, correctly.
 *
 * The binding is cleared per command, so `page_navigate` — the one command that
 * never asks for the current url, because it must work with no usable tab —
 * still bootstraps.
 *
 * @returns {Promise<number>}
 * @throws {Error} when the gated tab is not the tab that would be acted on
 */
export async function ensureAgentTab() {
  const tab = await resolveAgentTab();
  if (boundTabId !== null && boundTabId !== tab.id) {
    throw new Error(
      "The agent's tab was closed and replaced between the allowlist check and the action, so the page that was checked is not the page this would act on. Nothing was done; call page_state and try again."
    );
  }
  return tab.id;
}

/**
 * Every tab in the browser, for `page_tabs` and `page_switch`.
 *
 * Unfiltered ON PURPOSE: `dispatch` filters the result against the allowlist
 * itself, and it must be the one doing it. Filtering here as well would give a
 * future reader two places to look for the boundary and invite the belief that
 * this one can be relaxed.
 *
 * @returns {Promise<Array<{id: number, url: string, title: string}>>}
 */
export async function listAgentTabs() {
  const tabs = await chrome.tabs.query({});
  return (Array.isArray(tabs) ? tabs : [])
    .filter((tab) => typeof tab?.id === "number")
    .map((tab) => ({ id: tab.id, url: tabUrl(tab), title: tab.title ?? "" }));
}

/**
 * Make a tab both focused AND the agent's tab.
 *
 * Adopting it is the load-bearing half. Without it `page_switch` would focus a
 * tab that every following command then ignores, acting on the old agent tab
 * instead — the agent believes it is on the page it switched to and reads,
 * clicks and closes somewhere else entirely. The url was gated by the
 * `matchedTab` resolver before this runs, so the adopted tab is one the
 * allowlist admitted.
 *
 * @param {number} tabId
 */
export async function switchToTab(tabId) {
  const abandoned = agentTabId;
  await chrome.tabs.update(tabId, { active: true });
  agentTabId = tabId;
  // The gate for THIS command judged the matched tab, and the command is done;
  // leaving a binding that names the previous tab would fail the next
  // `ensureAgentTab` in this scope for no reason.
  boundTabId = tabId;

  // Clean up the tab this switch just abandoned, if it was one WE opened and
  // the agent never used. `handle` calls `ensureAgentTab()` before every
  // command's `run`, including page_switch — so on a cold worker a switch
  // creates a blank agent tab and then adopts a different one, abandoning the
  // blank. One stray tab per cold-start switch, accumulating across worker
  // restarts, and the user has no way to know where it came from.
  if (abandoned !== null && abandoned !== tabId) await discardIfUnused(abandoned);
}

/**
 * Close a tab only if this module opened it and nothing has happened in it.
 *
 * THREE CONDITIONS, and every one is load-bearing — this closes a real tab in
 * the user's browser, so a false positive destroys something they were using:
 *   1. we opened it (`createdTabIds`), so a tab the user opened is never a
 *      candidate no matter what it currently shows;
 *   2. it is still on `about:blank`, so a tab the agent navigated somewhere —
 *      and which may hold state the user can see — is left alone;
 *   3. it still exists.
 * Anything unexpected means "do not touch it": every failure path here leaves
 * the tab open, because a leaked blank tab is a cosmetic problem and a wrongly
 * closed tab is not.
 */
async function discardIfUnused(tabId) {
  if (!createdTabIds.has(tabId)) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tabUrl(tab) !== BLANK_URL) return; // The agent used it; leave it.
    await chrome.tabs.remove(tabId);
    createdTabIds.delete(tabId);
  } catch {
    // Already closed, or Chrome refused. Either way there is nothing to clean
    // up and nothing worth telling anyone about.
  }
}

/**
 * Close a tab, and forget it if it was ours.
 *
 * Without the forget, `agentTabId` names a closed tab and the next
 * `chrome.tabs.get` throws — which recovers, but only by accident. Clearing it
 * makes the next command open a fresh tab deliberately.
 *
 * @param {number} tabId
 */
export async function closeTab(tabId) {
  await chrome.tabs.remove(tabId);
  if (agentTabId === tabId) agentTabId = null;
  if (boundTabId === tabId) boundTabId = null;
  createdTabIds.delete(tabId);
}

/* ------------------------------------------------------------------------- */
/* The socket                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Run one command at a time.
 *
 * Commands drive ONE browser tab through CDP. Two running concurrently would
 * interleave clicks and navigations on the same page, and would also share the
 * per-command tab binding above — so a second command's `agentTabUrl` would
 * overwrite the first's, and the binding would be enforcing the wrong pairing.
 *
 * NAMED COST: a slow command delays the next one, and the server gives each
 * command 20s (BROWSER_COMPANION_TIMEOUT_MS) before it gives up. So a command
 * queued behind a slow one can time out having never run. That is the right
 * trade — a timeout is a visible failure, whereas interleaved input on one page
 * is a wrong answer nobody can see — but it is a real cost and it is why the
 * server's timeout is worth keeping generous.
 */
function enqueueCommand(run) {
  // No `.catch` before `.then`: the trailing catch below means `commandQueue`
  // is never a rejected promise, so a leading one could never fire. The
  // mutation harness proved it — removing it changed nothing observable — and
  // an unreachable guard is false reassurance rather than defence. The trailing
  // catch is what actually keeps a thrown handler from poisoning the queue.
  commandQueue = commandQueue
    .then(run)
    .catch((error) => {
      // `handle` is documented never to reject, so reaching this means the
      // handler itself broke. Swallowing it would leave the queue looking
      // healthy while every command silently produced nothing.
      console.error(
        "[AnythingLLM Companion] command handler threw; the server will see this command time out:",
        error
      );
    });
  return commandQueue;
}

/**
 * Where the terminal verdict is remembered ACROSS a worker teardown.
 *
 * WHY THIS EXISTS. Everything else in this module is per-worker by design, and
 * for a socket that is right — it has to be rebuilt on every wake anyway. A
 * terminal close is the one exception, and a review reproduced why: 4409 sets
 * `status = "evicted"`, the worker is torn down ~30s later, the wake reads the
 * key that is still sitting in `chrome.storage.sync`, and reconnects. Which is
 * the slot fight the terminal decision exists to prevent, restarted by the
 * lifecycle rather than by a stale alarm. Same for 4401: the rejected key is
 * retried on every wake, which is the login-attempt flood this module says it
 * refuses. Not server-triggerable and not a bypass — a durability gap.
 *
 * `local`, never `sync`: this is a verdict about THIS browser (which browser
 * lost the slot), and syncing it would evict the user's other machines too.
 */
const TERMINAL_STORAGE_KEY = "companionTerminalClose";

/**
 * The stored verdict is keyed to a FINGERPRINT of the key it was reached with,
 * never the key itself.
 *
 * Storing the key would put a live, long-lived credential in a second place at
 * rest for no gain — `storage.local` is not encrypted, and the whole point of
 * the subprotocol transport is that this credential stays out of places it does
 * not need to be. A digest answers the only question asked of it: "is this the
 * same key that was already rejected?"
 *
 * Truncated to 32 hex characters (128 bits). Far past collision relevance here,
 * and short enough to keep the record small.
 */
const KEY_FINGERPRINT_CHARS = 32;

/**
 * How much of a thrown message may be echoed back to the server.
 *
 * The same bound `dispatch.js` applies for the same reason: an error message
 * can carry page-derived or server-derived text, so it is untrusted by origin
 * even though it arrives as an exception. Applied again here because THIS path
 * is the one that runs when dispatch's own bounding did not — the throw escaped
 * it.
 */
const MAX_ECHOED_CHARS = 2048;

/**
 * Turn a rejected command into the reply the server is waiting for.
 *
 * WHY `ok: false` AND NOT A SUCCESS. The audit log exists so a user can later
 * see what the agent did in their browser. A command whose audit write failed
 * is a command the extension cannot vouch for, so reporting it as a plain
 * success would be the extension asserting something it does not know. The
 * agent reasons over these strings and acts on them.
 *
 * WHY THE OUTCOME IS CALLED UNKNOWN, not "failed". By the time `handle` records
 * anything the action has usually already happened — the click landed, the page
 * navigated. Telling the agent it FAILED invites a retry, and retrying a click
 * that already landed clicks twice. "May or may not have taken effect" is the
 * only honest thing this layer can say, and it is what stops the retry.
 *
 * @returns {object|null} the reply, or null when the frame carried no
 *   requestId. The server keys its pending table on requestId and
 *   `pending.get(undefined)` is a miss, so a reply built from an id-less frame
 *   settles nothing and is noise on the wire.
 */
function replyForFailedCommand(message, error) {
  const requestId = message?.requestId;
  if (requestId === undefined || requestId === null) {
    console.error(
      "[AnythingLLM Companion] a command with no requestId failed, so there is nobody to answer:",
      error
    );
    return null;
  }
  const reason = String(error?.message ?? error).slice(0, MAX_ECHOED_CHARS);
  return {
    requestId,
    ok: false,
    error: `The browser extension could not complete "${String(
      message?.cmd ?? "unknown"
    ).slice(
      0,
      MAX_ECHOED_CHARS
    )}" and could not record it in the audit log: ${reason}. The action may or may not have taken effect — check the page with page_state before retrying, rather than repeating the command.`,
  };
}

/**
 * A stable, non-reversible fingerprint of an API key.
 *
 * @param {string} apiKey
 * @returns {Promise<string|null>} null when no digest is available, which is
 *   the caller's signal to fall back to per-worker behaviour rather than to
 *   invent a weaker fingerprint.
 */
async function fingerprint(apiKey) {
  const digest = globalThis.crypto?.subtle?.digest;
  if (typeof digest !== "function") return null;
  try {
    const bytes = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(apiKey)
    );
    return [...new Uint8Array(bytes)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, KEY_FINGERPRINT_CHARS);
  } catch {
    return null;
  }
}

/**
 * Remember a terminal verdict so the next worker does not undo it.
 *
 * WHAT HAPPENS IF THE WRITE FAILS, stated because task 6 learned the hard way
 * that a storage write is not a thing to assume: the failure is logged and
 * SWALLOWED, and this connection stays terminal for the life of this worker.
 * The cost of the failure is precisely the M1 behaviour — the verdict does not
 * survive the teardown and the next wake reconnects — so a failed write leaves
 * the code no worse than it was before this function existed, and never worse
 * than that. It deliberately does NOT throw: this runs inside `onclose`, and a
 * throw there would take out the state assignment the popup reads, trading a
 * durability gap for an immediate visible failure. There is nothing for a
 * caller to do about it either, which is the other half of why it is not
 * raised.
 *
 * No read-back verification, unlike `saveAllowlist`. That one verifies because
 * believing a lie there means believing access was revoked when it was not —
 * a security claim. Here a lost write costs a redundant reconnect attempt,
 * which the server answers by closing again with the same code.
 */
async function rememberTerminal(apiKey, status, error) {
  const key = await fingerprint(apiKey);
  if (!key) return;
  try {
    await chrome.storage.local.set({
      [TERMINAL_STORAGE_KEY]: { key, status, error, at: new Date().toISOString() },
    });
  } catch (failure) {
    console.error(
      "[AnythingLLM Companion] could not remember that this connection was refused; it may be retried after the extension restarts:",
      failure
    );
  }
}

/**
 * The stored verdict, if it applies to THIS key.
 *
 * A verdict for a different fingerprint is not merely ignored, it is DELETED:
 * that is the mechanism by which an evicted user gets back in. They reconnect
 * in AnythingLLM, the popup writes a new key to `storage.sync`, the storage
 * listener calls `connect`, the fingerprints differ, and the block is gone. No
 * reinstall, and nothing for the user to find or clear by hand.
 *
 * @returns {Promise<{status: string, error: string}|null>}
 */
async function terminalVerdictFor(apiKey) {
  const key = await fingerprint(apiKey);
  if (!key) return null;
  let stored;
  try {
    stored = (await chrome.storage.local.get([TERMINAL_STORAGE_KEY]))?.[
      TERMINAL_STORAGE_KEY
    ];
  } catch {
    // A read failure must not block a connection: failing OPEN is right here,
    // because the alternative is an extension that cannot connect at all when
    // storage is unhealthy, and the server refuses the connection again anyway
    // if the verdict was real.
    return null;
  }
  if (!stored || typeof stored !== "object") return null;
  if (stored.key !== key) {
    // A different key: the user has reconnected. Clear the block.
    try {
      await chrome.storage.local.remove(TERMINAL_STORAGE_KEY);
    } catch {
      // The mismatch check above already makes this verdict inert for the new
      // key, so a failed cleanup costs a stale record, not a blocked user.
    }
    return null;
  }
  return { status: stored.status, error: stored.error };
}

/** Forget any terminal verdict. Exported for the popup's "try again". */
export async function clearTerminalVerdict() {
  try {
    await chrome.storage.local.remove(TERMINAL_STORAGE_KEY);
    return true;
  } catch (error) {
    console.error(
      "[AnythingLLM Companion] could not clear the stored connection refusal:",
      error
    );
    return false;
  }
}

/**
 * Write one frame, only if the socket can still carry it.
 *
 * The browser `WebSocket` does NOT throw when `send` is called on a CLOSING or
 * CLOSED socket — per spec it discards the data silently, and only CONNECTING
 * throws. So without this guard a reply written to a socket that closed while
 * the command was running vanishes with no error anywhere, and the server waits
 * out its full timeout for an answer that was already computed.
 *
 * There is nothing useful to do about it but say so: the server's `drainSocket`
 * settles the command as soon as the close reaches it.
 *
 * @returns {boolean} whether the frame was actually written
 */
function sendOn(ws, payload) {
  if (!ws || ws.readyState !== WS_OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (error) {
    // A CONNECTING socket throws, and so does an unstringifiable payload.
    console.error("[AnythingLLM Companion] could not send frame:", error);
    return false;
  }
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

/**
 * Schedule the next attempt, with exponential backoff and jitter.
 *
 * Half-to-full jitter rather than none: every installed extension sees the same
 * outage at the same moment, so an unjittered backoff has them all retrying in
 * lockstep and hitting a recovering server as one burst.
 *
 * `setTimeout` does not survive an MV3 teardown, so this is the fast path only.
 * The keepalive alarm is the durable backstop and is deliberately NOT cleared
 * on a retryable close for exactly that reason.
 */
function scheduleReconnect() {
  clearReconnectTimer();
  const ceiling = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  const delay = ceiling / 2 + Math.random() * (ceiling / 2);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (config) connect(config);
  }, delay);
}

function armKeepalive() {
  // Created before the socket opens, not in `onopen`: a worker torn down while
  // the handshake is still in flight would otherwise have no alarm to wake it
  // and would stay dead until the user clicked something.
  chrome.alarms.create(KEEPALIVE_ALARM, {
    periodInMinutes: KEEPALIVE_MINUTES,
  });
}

function disarmKeepalive() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
}

/**
 * Open the socket, or do nothing if an equivalent one is already live.
 *
 * The idempotency guard is required, not defensive dressing: `index.js` starts
 * the companion at module load (every worker wake re-runs it), from
 * `onStartup`, from `onInstalled`, from a storage change and from the keepalive
 * alarm. Without the guard those overlap and leave several sockets open, of
 * which the server routes to exactly one — so commands land in a browser whose
 * replies come back on a socket the server discards.
 *
 * @param {{apiBase: string, apiKey: string, onCommand: (command: object) => Promise<object>}} args
 * @returns {Promise<void>}
 */
export async function connect({ apiBase, apiKey, onCommand } = {}) {
  if (typeof apiBase !== "string" || !apiBase) return setIdle(null);
  if (typeof apiKey !== "string" || !apiKey) return setIdle(null);
  if (typeof onCommand !== "function")
    throw new TypeError("connect requires an onCommand handler");

  if (!HTTP_TOKEN.test(apiKey)) {
    // Caught here rather than left to the WebSocket constructor, which throws a
    // bare SyntaxError naming neither the argument nor the reason.
    return setIdle(
      "That API key contains characters a WebSocket subprotocol cannot carry. Reconnect from AnythingLLM to get a fresh key."
    );
  }

  const sameConfig =
    config?.apiBase === apiBase && config?.apiKey === apiKey;
  const alive =
    socket && (socket.readyState === 0 || socket.readyState === WS_OPEN);
  if (sameConfig && alive) return;

  // THE DURABLE HALF OF THE TERMINAL REFUSAL. Checked before a socket is built
  // and before `config` is set, so a worker that woke after a terminal close
  // does not reconnect and restart the fight that decision refused to start.
  // The in-memory `status` guard is the same rule within one worker lifetime;
  // this is what makes it survive a teardown. A verdict for a DIFFERENT key
  // clears itself here, which is how an evicted user gets back in.
  //
  // Scoped to a COLD entry — no `config` yet, i.e. this worker has not already
  // established that this key is usable. That is not an optimisation, it is
  // required: the reconnect timer calls `connect`, and awaiting storage on that
  // path would make every retry depend on a storage round trip completing,
  // which reorders the retry relative to its own timer. A reconnect is already
  // inside a session that passed this check, and a terminal close clears
  // `config`, so a retry can never skip a verdict that applies to it.
  if (!config) {
    const verdict = await terminalVerdictFor(apiKey);
    if (verdict) {
      status = verdict.status;
      lastError = verdict.error;
      closeExisting();
      clearReconnectTimer();
      disarmKeepalive();
      return;
    }
  }

  config = { apiBase, apiKey, onCommand };
  clearReconnectTimer();
  closeExisting();

  let url;
  try {
    url = socketUrlFor(apiBase);
  } catch {
    return setIdle(
      `"${apiBase}" is not a valid AnythingLLM server address. Check it in the extension's settings.`
    );
  }

  status = "connecting";
  armKeepalive();

  // MARKER FIRST, KEY SECOND. See the module header — the order is the
  // difference between the key staying off the wire and being echoed back in
  // the handshake response.
  let ws;
  try {
    ws = new WebSocket(url, [COMPANION_SUBPROTOCOL, apiKey]);
  } catch (error) {
    // Reachable for a URL the constructor refuses even though `new URL`
    // accepted it. Without this the module is left in `connecting` with a
    // keepalive alarm and no socket — a browser that shows as busy forever.
    return setIdle(
      `Could not open a connection to ${apiBase}: ${error?.message ?? error}`
    );
  }
  socket = ws;

  ws.onopen = () => {
    // Guarded on identity throughout: a late event from a socket this module
    // has already replaced must not overwrite the live one's state.
    if (socket !== ws) return;
    status = "online";
    lastError = null;
    reconnectDelay = RECONNECT_BASE_MS;
  };

  ws.onmessage = (event) => {
    if (socket !== ws) return;

    let message;
    try {
      message = JSON.parse(
        typeof event?.data === "string" ? event.data : String(event?.data)
      );
    } catch {
      return; // A frame we cannot read is not a frame we can answer.
    }

    if (message?.event === "evicted") {
      // The server sends this and then closes 4409. Handled here as well as on
      // the close code because the frame carries the server's own reason, and
      // because it arrives first — the user sees why before the socket drops.
      status = "evicted";
      lastError =
        typeof message.reason === "string" && message.reason
          ? message.reason
          : TERMINAL_CLOSES.get(CLOSE_EVICTED).error;
      return;
    }

    enqueueCommand(async () => {
      // One command at a time, so this reset cannot land between another
      // command's gate check and its action.
      beginCommandScope();

      // `handle` is DOCUMENTED never to reject, and as of de8cf157 it wraps
      // every `auditLog.record` call so a full store cannot break that. This
      // does not depend on either fact. The socket is the last line: a
      // rejection escaping here would take the connection down and every
      // command in flight with it, so the guarantee has to hold on this side
      // even if a future edit to dispatch.js reintroduces a rejecting path.
      //
      // Surviving it is not sufficient. Answering NOTHING leaves the server
      // waiting out its full BROWSER_COMPANION_TIMEOUT_MS for a reply that can
      // never arrive, and it then reports "timed out after 20000ms" — which
      // reads as a slow page when the truth is that the extension broke. So a
      // rejection becomes a reply.
      let result;
      try {
        result = await onCommand(message);
      } catch (error) {
        result = replyForFailedCommand(message, error);
        if (!result) return; // No requestId: see `replyForFailedCommand`.
      }
      // `ws`, never the module-level `socket`: if a reconnect replaced it while
      // this command ran, the reply must NOT go out on the new socket. The
      // server matches a reply to its command by socket identity and would log
      // it as a cross-connection echo and drop it — so the reply would be lost
      // either way, but on the new socket it is lost noisily and looks like an
      // attack.
      if (!sendOn(ws, result)) {
        console.warn(
          "[AnythingLLM Companion] the connection closed before this command's reply could be sent; the server will settle it as disconnected."
        );
      }
    });
  };

  ws.onclose = (event) => {
    if (socket !== ws) return;
    socket = null;

    const terminal = TERMINAL_CLOSES.get(event?.code);
    if (terminal) {
      status = terminal.status;
      lastError = terminal.error;
      // No reconnect, and no alarm: a worker woken to re-fail is waste, and for
      // 4409 it is worse than waste — it would take the slot back from the
      // browser that just claimed it, which then reconnects and takes it back
      // again. Recovery is the user reconnecting from the popup, which calls
      // `connect` and re-arms everything.
      disarmKeepalive();
      clearReconnectTimer();
      // Dropped so nothing can reconnect with a key the server just refused:
      // `keepalive()` reconnects from `config`, and `connect`'s cold-entry
      // check is gated on `config` being absent. Leaving it set would let this
      // worker rebuild the very connection this branch is refusing.
      config = null;
      // Durable, so the next worker honours this verdict too. Fire-and-forget
      // for the same reason as the audit write below: this is a close handler,
      // and a storage failure must not stop the state above from being set.
      // See `rememberTerminal` for exactly what a failed write costs.
      void rememberTerminal(apiKey, terminal.status, terminal.error);
      // Written to the log the user reads, because a browser that has gone
      // quiet with no window open is otherwise indistinguishable from a broken
      // extension. Fire-and-forget: this is a close handler, and a storage
      // failure here must not stop the state above from being set.
      //
      // The `.catch` is NOT decoration. `record` rejects on a failed write (a
      // full store), and an un-caught rejection in a service worker surfaces as
      // an unhandled rejection with no context — in tests it lands on whichever
      // case happens to be running when the microtask drains, which is exactly
      // the sort of false signal that sends a debugging session at the wrong
      // module. auditLog already makes the failure observable in the console
      // and through `getWriteFailure`, so there is nothing to add here.
      auditRecord({
        cmd: "socket",
        url: null,
        outcome: "denied",
        detail: `closed ${event.code}: ${terminal.error}`,
      }).catch(() => {});
      return;
    }

    if (status === "evicted" || status === "unauthorized") return;

    status = "idle";
    scheduleReconnect();
  };

  ws.onerror = () => {
    if (socket !== ws) return;
    // The browser deliberately gives no detail here, to avoid becoming a port
    // scanner. `onclose` follows and decides what happens next; this only
    // supplies text for the popup.
    lastError = "Could not reach the AnythingLLM server.";
  };
}

function setIdle(error) {
  status = "idle";
  lastError = error;
  closeExisting();
  clearReconnectTimer();
  disarmKeepalive();
  config = null;
}

function closeExisting() {
  if (!socket) return;
  const stale = socket;
  socket = null; // Cleared first, so `stale`'s own close handler no-ops.
  try {
    stale.close();
  } catch {
    // Already gone. There is nothing to clean up and nothing to report.
  }
}

/**
 * Send a ping if there is a live socket to send it on.
 *
 * Any traffic resets the MV3 idle timer, which is the entire mechanism.
 *
 * @returns {boolean} whether a ping was actually written
 */
export function ping() {
  return sendOn(socket, { event: "ping" });
}

/**
 * What the keepalive alarm does when it wakes the worker.
 *
 * Two jobs, and the second is the one that matters. Pinging keeps a live socket
 * alive; but if the worker was torn down, the socket died with it, and the
 * alarm firing is the ONLY thing that brings the worker back — so this must
 * also re-open the connection, not merely ping a socket that is gone.
 *
 * @returns {boolean} false when this module has no config to reconnect with,
 *   which happens on a cold wake — `index.js` reads storage and starts from
 *   scratch in that case. Returned rather than handled here so this module
 *   keeps no opinion about where the config is stored.
 */
export function keepalive() {
  if (status === "evicted" || status === "unauthorized") {
    // Terminal. The alarm should already be cleared; clearing again is harmless
    // and covers an alarm that survived a teardown from before the close.
    disarmKeepalive();
    return true;
  }
  if (ping()) return true;
  if (!config) return false;
  void connect(config);
  return true;
}

/** Test-only: drop every scrap of per-worker state between cases. */
export function __reset() {
  closeExisting();
  clearReconnectTimer();
  status = "idle";
  lastError = null;
  reconnectDelay = RECONNECT_BASE_MS;
  config = null;
  commandQueue = Promise.resolve();
  agentTabId = null;
  resolving = null;
  boundTabId = null;
  createdTabIds.clear();
}

/** Test-only: the queue, so a test can await the command it just delivered. */
export function __commandQueue() {
  return commandQueue;
}

/**
 * Test-only: whether this worker still holds a config it could reconnect with.
 *
 * Exposed because a terminal close defends against reconnecting TWO ways — no
 * timer is scheduled, and `config` is dropped, which the timer callback and
 * `keepalive` both require. Either alone suffices, so removing either alone is
 * invisible through behaviour and a mutation run proved it: both single
 * removals survived, only the pair reconnected. Redundancy nobody can see is
 * how one half gets deleted as dead code and the other then follows as
 * harmless, so each half is asserted directly instead.
 */
export function __hasConfig() {
  return config !== null;
}

export {
  KEEPALIVE_ALARM,
  KEEPALIVE_MINUTES,
  COMPANION_SUBPROTOCOL,
  SOCKET_PATH,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  CLOSE_UNAUTHORIZED,
  CLOSE_FORBIDDEN,
  CLOSE_EVICTED,
};
