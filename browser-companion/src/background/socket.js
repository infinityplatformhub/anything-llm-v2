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
// No cycle: pageState imports only cdp, and cdp imports nothing.
import * as pageState from "./pageState.js";

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

/**
 * EVERY TAB ID THIS MODULE HOLDS IS A CAPABILITY, NOT BOOKKEEPING.
 *
 * That changed with F1, and it changes the question to ask of any stored id.
 * It used to be "is this stale?", whose worst answer was a wasted call. It is
 * now "COULD THIS NOW NAME SOMEONE ELSE'S TAB?", whose worst answer is the
 * agent attaching a debugger to, navigating, or closing a tab the user opened.
 *
 * Chrome reuses tab ids within a session, so a held id survives the tab it
 * named. Anywhere an id is kept, that question must have an answer — and the
 * only answer that holds is dropping the id when Chrome says the tab is gone,
 * which is what `handleTabRemoved` below is for. Noticing lazily, at the next
 * `chrome.tabs.get`, is NOT an answer: by then the id may already have been
 * handed to someone else's tab, and the lookup then SUCCEEDS.
 *
 * Two handles are invalidated by that one event, and both are below.
 */

/** The tab id this module believes is the agent's. */
let agentTabId = null;
/**
 * Tabs THIS module opened, so cleanup can never close one the user opened.
 * Per-worker like everything else here: after a teardown a previously created
 * tab is simply not a cleanup candidate, which fails safe.
 *
 * Since F1 this set GRANTS: membership is what `listAgentTabs` reports and what
 * `switchToTab` requires. A stale entry is therefore not untidiness, it is an
 * authorisation for a tab that may no longer be ours.
 */
const createdTabIds = new Set();
/** The in-flight `resolveAgentTab`, so concurrent callers cannot open two tabs. */
let resolving = null;
/** The tab id `agentTabUrl` reported inside the current command scope. See `ensureAgentTab`. */
let boundTabId = null;

/**
 * Give up every claim on a tab the moment Chrome says it is gone.
 *
 * THIS IS THE INVALIDATION EVENT, so this is where the ids are dropped — the
 * same reasoning as narrowing at the set-building site rather than at each
 * consumer. Dropping them lazily, when the next `chrome.tabs.get` happens to
 * fail, is not equivalent and a review drove both ways it fails:
 *
 *   - ROUTE A, `agentTabId`. The user closes the agent's tab; Chrome recycles
 *     that id onto a tab THEY open. The next `chrome.tabs.get(agentTabId)` now
 *     SUCCEEDS, so the lazy catch never runs, and the agent treats the user's
 *     tab as its own — `page_click` attaches a debugger to it, `page_close`
 *     removes it. `listAgentTabs` is not involved at all, which is why a test
 *     that only exercises `page_switch` would miss this entirely.
 *   - ROUTE B, `createdTabIds`. The stale entry keeps granting while the worker
 *     is not holding that tab current, so `page_switch` adopts the user's
 *     recycled tab and `page_close` then removes it.
 *
 * `boundTabId` IS DELIBERATELY NOT CLEARED HERE, and that is not an oversight.
 * It is the per-command gate binding, and its entire job is to notice that the
 * tab the allowlist judged is no longer the tab about to be acted on. Clearing
 * it here would erase the evidence of exactly the event it exists to catch:
 * `ensureAgentTab` would then open a fresh tab and return it happily, and a
 * `page_close` gated on tab A would land on tab B — which is the coupling this
 * whole module was written around. The binding must go on naming the tab the
 * gate saw, precisely BECAUSE that tab is gone.
 *
 * It is also safe to leave, but the reason has to be stated exactly, because
 * the obvious version of it is FALSE. "A stale binding can only cause a
 * refusal, never an action" is what an earlier draft of this comment said, and
 * driving it disproves it: when the replacement tab this module opens is handed
 * the recycled id, `boundTabId` MATCHES, and a click gated on the old page
 * proceeds against the new one. It is an action, not a refusal.
 *
 * The invariant that actually holds, and the one worth relying on: A STALE
 * BINDING CAN NEVER REACH A TAB THE MODULE DOES NOT OWN. A user's tab taking
 * the recycled id gets a fresh id from this module's point of view, which
 * mismatches, which refuses. The only tab a stale binding can let through is
 * one this module opened itself — so the worst case is the agent acting on its
 * own fresh `about:blank`, which is inert. That is why leaving it set is safe;
 * "it can never cause an action" is not why, and was not true.
 *
 * Exported because it is the listener body, and a listener registered on a
 * global is otherwise untestable — a test would have to own `chrome` before
 * this module's top level runs, which ES module hoisting makes impossible.
 * Same shape as `cdp.handleDetach`, for the same reason.
 *
 * @param {number} tabId the id Chrome reports removed
 */
export function handleTabRemoved(tabId) {
  if (typeof tabId !== "number") return;
  createdTabIds.delete(tabId);
  if (agentTabId === tabId) agentTabId = null;
  // The element map is keyed by tab id, so a surviving map resolves element
  // coordinates for a RECYCLED id — the agent asks for element [3] and gets a
  // point from a page that is gone, on a tab that is now someone else's.
  // Dropped here because this is the event that invalidates it, the same reason
  // the ids are dropped here.
  pageState.invalidate(tabId);
}

/**
 * Refuse a tab id that is no longer one the agent owns.
 *
 * WHY THIS EXISTS ON TOP OF THE LISTENER. `handleTabRemoved` fixes STORED ids.
 * It cannot reach an id already captured in a local — and `dispatch.handle`
 * captures one: `const tabId = await d.ensureAgentTab()`, then awaits
 * `cdp.attach(tabId)` and `spec.run({tabId})`. Those are real IPC round trips,
 * so a removal AND a `tabs.create` can both land inside them. Driving it shows
 * a recycle inside `cdp.detach` CLOSING the user's tab and one inside
 * `cdp.attach` CLICKING it.
 *
 * WHY MEMBERSHIP AND NOT A GENERATION COUNTER. A counter answers "has anything
 * been removed since this id was read?", which is a proxy. This answers the
 * actual question — "is this id still ours?" — and the difference is not
 * academic: with a counter, the user closing ANY unrelated tab mid-command
 * aborts a command that was never in danger, and on a busy browser that is a
 * steady drip of failures with no cause the user can see. Membership has no
 * such false positives, and it is already maintained correctly by the listener,
 * so it needs no second source of truth to drift from the first.
 *
 * A third reason was given when this was written and it does NOT survive being
 * driven, so it is recorded as withdrawn rather than quietly deleted: "a
 * counter lets a captured id through whenever the removal preceded the read".
 * That case cannot arise — if the removal came first, the listener had already
 * nulled `agentTabId`, so the read returns a FRESH id and there is nothing
 * stale to let through. Membership is not strictly stronger than a counter; it
 * is correctly scoped, which is what the two reasons above actually say.
 *
 * Called immediately before an act, with no await between the check and the
 * call it guards — a check with an await after it is the bug, not the fix.
 *
 * @param {number} tabId
 * @throws {Error} when the tab is no longer the agent's
 */
export function assertStillOwned(tabId) {
  if (createdTabIds.has(tabId)) return;
  throw new Error(
    "The agent's tab was closed while this command was running, and the id now belongs to a different tab. Nothing was done; call page_state and try again."
  );
}

/**
 * The methods whose FIRST ARGUMENT is a tab id, and which therefore act on a
 * specific tab. Exported so a test can hold it against the real `cdp` surface.
 *
 * `detach` is absent on purpose, and `detachAll` and `attachedTabIds` are
 * absent because they name no tab. See `guardTabActs` for both reasons and for
 * what a method missing from this set gets.
 *
 * `evaluate` is NOT here even though it takes a tab id first: `cdp.js` exports
 * it, but the frozen `cdp` surface that reaches `deps` does not carry it, so
 * nothing this module wraps can reach it. Listing it would have been a name
 * that guards nothing — caught by the test that holds this set against the real
 * surface, which is the point of having that test rather than trusting the
 * list. Its one caller, `fetchInPage`, IS on the surface and IS guarded.
 */
const TAB_ID_ACTS = new Set([
  "attach",
  "click",
  "type",
  "key",
  "scroll",
  "navigate",
  "fetch",
  "closeTab",
  // pageState. These reach `Runtime.evaluate` through pageState's OWN direct
  // import of cdp.js, bypassing the frozen `cdp` surface entirely — which is
  // exactly how they escaped a set that was only ever checked against that
  // surface. `capture` and `read` return the page's text and its control
  // layout, so an unguarded one discloses an arbitrary non-allowlisted page to
  // the server, which is the one thing the allowlist exists to bound.
  "capture",
  "read",
  // `lookup` touches no page — it reads a local Map. It is guarded anyway
  // because of what its RETURN VALUE is used for: the coordinates the next
  // click lands on. A map surviving on a recycled id would hand `page_click`
  // a point derived from a page that is gone, aimed at a tab that is now
  // someone else's. Guarding it costs one Set lookup and removes the need to
  // reason about whether the map and the tab can ever disagree.
  "lookup",
]);

/**
 * Wrap every tab-taking method so it re-checks ownership at the moment it acts.
 *
 * THE CHOKE POINT IS WHERE THE ACT HAPPENS, NOT WHERE THE ID IS CAPTURED, and
 * that is the whole reason this is a wrapper rather than two patched call
 * sites. `dispatch.handle` resolves a tab id once and then awaits several
 * times before anything happens with it — `cdp.attach`, then `spec.run`, which
 * awaits again inside itself. Guarding the two awaits visible in `handle`
 * would leave the ones inside `run` open, which is exactly the shape of "the
 * fix looked complete" that this branch has now hit three times.
 *
 * Every act on a tab goes through a function whose FIRST ARGUMENT is the tab
 * id — `cdp.attach/detach/click/type/key/scroll/navigate/fetch` and `closeTab`.
 * Wrapping on that shape means the check lands immediately before the act with
 * no await in between, at every current call site AND at every future one,
 * without dispatch.js having to remember anything.
 *
 * DRIVEN BY AN EXPLICIT SET, NOT BY EXCLUSION. An earlier version wrapped
 * everything except one name it remembered (`detach`), which meant "every
 * method is a tab act unless I thought of it" — and `detachAll` was not thought
 * of. It takes NO arguments, so the wrapper called `assertStillOwned(undefined)`,
 * which is false for every state of `createdTabIds`: the guarded copy could
 * never run at all. That is the KILL SWITCH's sweep, and it survived only
 * because `control.js` imports `detachAll` straight from `cdp.js` rather than
 * through `deps.cdp` — one import style away from the user's stop button always
 * throwing, and invisible to the mutation harness because nothing calls the
 * guarded copy.
 *
 * WHAT AN UNLISTED METHOD GETS BY DEFAULT: passed through UNWRAPPED. The
 * conclusion stands; the reason an earlier version of this comment gave for it
 * did NOT, and the difference is worth stating because getting it wrong is what
 * let `pageState` through.
 *
 * That version said a missing method "loses one layer of a defence-in-depth
 * check while the gate, the ownership filter and the listener all still stand."
 * That is true FOR THE FROZEN `cdp` SURFACE and is NOT A GENERAL RULE. It was
 * driven and it is false on `page_read`: the gate ran before the window opened,
 * the ownership filter is not on that path, and the listener cannot reach a
 * captured local — which is the entire reason this guard exists. On that path
 * the act-time check was the ONLY layer, and a miss disclosed a
 * non-allowlisted page's text to the server.
 *
 * So the default is justified by the COST ASYMMETRY alone, not by other layers:
 * a method wrapped wrongly is DEAD — it throws on every call, as `detachAll`
 * did, and hides until whatever calls it changes — while a missing one fails in
 * a way that is recoverable and, crucially, TESTABLE. Which is why the test
 * below is the real protection and this default is only the tie-breaker: it
 * checks this set against EVERY tab-taking dep in the wiring, not just `cdp`.
 * `evaluate` is exactly the method that escaped a `cdp`-only check.
 *
 * (An argument-shape check — "wrap it if it has at least one parameter" — was
 * considered and rejected: `fn.length` lies for rest and default parameters, so
 * it would silently stop guarding a real act the day someone writes
 * `click(tabId, x, y, options = {})`. A name is checkable; an arity is not.)
 *
 * `detach` is IN the surface but deliberately absent from the set. It is the
 * one act that is safe on a tab we no longer own and unsafe to skip:
 * `page_close` detaches before closing, and refusing the detach would leave a
 * debugger attachment behind on a tab that is going away. It also cannot harm a
 * recycled tab — detaching from a tab nobody attached is a no-op inside
 * `cdp.detach`, which returns early when the id is not in its own `attached`
 * set. The CLOSE that follows it is wrapped, which is the act that actually
 * destroys something.
 *
 * @param {object} tabTakers methods to guard, keyed by name
 * @returns {object} the same shape, with the tab-taking acts ownership-checked
 */
export function guardTabActs(tabTakers) {
  const guarded = {};
  for (const [name, fn] of Object.entries(tabTakers)) {
    if (typeof fn !== "function" || !TAB_ID_ACTS.has(name)) {
      guarded[name] = fn;
      continue;
    }
    guarded[name] = (tabId, ...rest) => {
      // Synchronous, and immediately before the call it guards. A check with an
      // await between it and the act would reintroduce the window it closes.
      assertStillOwned(tabId);
      return fn(tabId, ...rest);
    };
  }
  return guarded;
}

// Optional-chained the whole way: this module is imported by tests that have no
// `chrome` at all. Registered at load rather than per command, because a tab can
// be closed at any moment, including while nothing is in flight — and the whole
// point is to learn about it WHEN IT HAPPENS rather than at the next lookup.
globalThis.chrome?.tabs?.onRemoved?.addListener?.(handleTabRemoved);

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
      // The tab is gone and `handleTabRemoved` did not run. The ONLY way that
      // happens is that the listener never registered — `chrome.tabs.onRemoved`
      // missing in a stripped environment, or a shim that does not deliver.
      //
      // An earlier version of this comment also blamed "the worker was torn
      // down between the close and now". That case is impossible and saying it
      // made the backstop look broader than it is: a teardown wipes
      // `agentTabId` along with everything else in this module, so there is no
      // stale id left for this branch to catch. Fall through and open a new one.
      //
      // A BACKSTOP, NOT THE MECHANISM, and the distinction is the whole of
      // F1-R. This only fires when the lookup FAILS, and after Chrome has
      // recycled the id the lookup SUCCEEDS — so relying on it meant the agent
      // silently adopted whatever tab now wore that number. The listener is
      // what actually keeps these ids honest; this is what is left for the case
      // where no listener ran at all, and it must not be mistaken for cover.
      handleTabRemoved(agentTabId);
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
 * Whether this worker believes the agent currently holds a tab.
 *
 * Deliberately does NOT create one. The popup calls this to decide whether to
 * offer "go to the agent's tab", and a resolver that created a tab would mean
 * merely OPENING the popup spawns a blank tab in the user's browser — an action
 * with a visible side effect, taken by a read.
 *
 * It reports this module's belief, not Chrome's truth: the tab may have been
 * closed since. `focusAgentTab` is where that is found out, because finding out
 * requires an async call the popup's render cannot make.
 *
 * @returns {boolean}
 */
export function hasAgentTab() {
  return agentTabId !== null;
}

/**
 * Focus the agent's tab, for the popup's "go to the agent's tab" button.
 *
 * Does not create a tab either, and answers `false` rather than throwing when
 * there is none — "the agent is not working in a tab right now" is an ordinary
 * state of this browser, not an error, and the popup says so in words.
 *
 * A tab id this module holds may name a tab the user has since closed, so the
 * update failing is expected rather than exceptional; it is answered as `false`
 * and the stale id is dropped, so the popup stops offering a button that goes
 * nowhere.
 *
 * @returns {Promise<boolean>} whether a tab was actually focused
 */
export async function focusAgentTab() {
  if (agentTabId === null) return false;
  try {
    await chrome.tabs.update(agentTabId, { active: true });
    return true;
  } catch {
    agentTabId = null;
    return false;
  }
}

/**
 * The tabs the AGENT opened — not every tab in the browser.
 *
 * TWO DIFFERENT FILTERS, TWO DIFFERENT OWNERS. Do not collapse them:
 *
 *   - OWNERSHIP ("is this the agent's tab?") is filtered HERE, because
 *     `createdTabIds` is this module's own record and exists nowhere else. It
 *     is a capability question: which tabs the agent may act on at all.
 *   - THE ALLOWLIST ("may the agent act on this url?") is still judged only by
 *     `dispatch`, never here. That is the security boundary, and putting any
 *     part of it in two places invites the belief that this copy can be
 *     relaxed.
 *
 * WHY THE NARROWING IS HERE AND NOT AT THE CONSUMERS. A final review drove the
 * real seam: `listAgentTabs` returned `chrome.tabs.query({})` — every tab — and
 * `switchToTab` adopts whatever it focuses, so `page_switch` could adopt a tab
 * the USER opened, after which `page_close` closed it and `page_navigate` took
 * it somewhere else. Both halves were correct alone; the pair granted something
 * neither declared, and both tool descriptions and the spec explicitly deny it
 * ("agent เปิดแท็บใหม่ของตัวเอง ไม่แตะแท็บที่ผู้ใช้เปิดอยู่").
 *
 * Filtering at the SET-BUILDING site rather than at each consumer is the same
 * shape as task 7's fix for the tab-order channel: narrow before the search, so
 * a user's tab cannot influence which tab is found, in what order, or whether
 * one is found at all. A consumer-side filter would leave the user's tabs
 * visible to the resolver, and any future selection path could still reach one.
 *
 * NAMED COST, because it is a real capability reduction and it is the one that
 * was asked for: the agent can no longer enumerate or reach tabs the user
 * opened. `page_tabs` shows only the agent's own. If the user wants the agent on
 * a page, the agent navigates its own tab there — which is gated on the
 * destination — rather than taking over the window the user is reading.
 *
 * @returns {Promise<Array<{id: number, url: string, title: string}>>}
 */
export async function listAgentTabs() {
  const tabs = await chrome.tabs.query({});
  return (Array.isArray(tabs) ? tabs : [])
    .filter((tab) => typeof tab?.id === "number" && createdTabIds.has(tab.id))
    .map((tab) => ({ id: tab.id, url: tabUrl(tab), title: tab.title ?? "" }));
}

/**
 * Make one of the AGENT'S OWN tabs both focused and current.
 *
 * Adopting it is the load-bearing half. Without it `page_switch` would focus a
 * tab that every following command then ignores, acting on the old agent tab
 * instead — the agent believes it is on the page it switched to and reads,
 * clicks and closes somewhere else entirely. The url was gated by the
 * `matchedTab` resolver before this runs, so the adopted tab is one the
 * allowlist admitted.
 *
 * THE OWNERSHIP CHECK IS A SECOND LINE, and deliberately not merely a
 * consequence of `listAgentTabs` being filtered. Adoption is the step that
 * makes a tab reachable by `page_close` and `page_navigate`, so it is the step
 * that must refuse — a check that lived only in the set-building site would be
 * undone by any future caller that obtains a tab id some other way. Refusing
 * here means there is NO PATH to owning a tab the agent did not open, which is
 * a stronger statement than "the current selection path cannot find one".
 *
 * Throws rather than returning false: `handle` catches, records it in the audit
 * log, and answers the agent with the reason. A silent no-op would leave the
 * agent believing it had switched.
 *
 * @param {number} tabId
 * @throws {Error} when the tab is not one the agent opened
 */
export async function switchToTab(tabId) {
  if (!createdTabIds.has(tabId)) {
    throw new Error(
      "That tab was not opened by the agent, and the agent only acts on its own tabs. Use page_navigate to open the page in the agent's own tab instead."
    );
  }
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
 * FOUR CONDITIONS, and every one is load-bearing — this closes a real tab in
 * the user's browser, so a false positive destroys something they were using:
 *   1. we opened it (`createdTabIds`), so a tab the user opened is never a
 *      candidate no matter what it currently shows. `closeTab` removes the id
 *      here, which is what stops a RECYCLED id — Chrome reuses tab ids within a
 *      session — from making a user's new tab look like one of ours;
 *   2. it is not mid-navigation. `chrome.tabs.update({url})` — which is how
 *      `cdp.navigate` moves a tab — sets `pendingUrl` to the destination while
 *      `url` still reads `about:blank`, so without this check a tab the agent
 *      navigated one instant ago is indistinguishable from an unused blank one
 *      and gets closed out from under the navigation;
 *   3. it has not already gone somewhere, so a tab holding state the user can
 *      see is left alone;
 *   4. it still exists.
 * Anything unexpected means "do not touch it": every failure path here leaves
 * the tab open, because a leaked blank tab is a cosmetic problem and a wrongly
 * closed tab is not.
 */
async function discardIfUnused(tabId) {
  // KEPT DELIBERATELY THOUGH CURRENTLY UNREACHABLE, and said plainly because
  // this branch has twice found a comment over-claiming what a line does.
  //
  // Since F1 the only caller is `switchToTab`, which refuses a tab it does not
  // own BEFORE reaching here — so `abandoned` is always owned and a mutation
  // removing this line survives. It is not redundancy with a second live
  // guard; it is this function refusing to assume its caller checked.
  //
  // The reason it stays rather than being deleted as dead code: this function
  // CLOSES A TAB, and the cost of the two errors is wildly asymmetric. An
  // unreachable check costs one comparison; a future second caller that
  // forgets the ownership check costs the user a tab. The `createdTabIds`
  // membership is also the only thing here that distinguishes our blank tab
  // from an identical one the user opened, so a caller-side check is not a
  // substitute for it.
  if (!createdTabIds.has(tabId)) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    // Checked before `url`, because during a navigation `url` is the stale
    // value and `pendingUrl` is the true one.
    const pending = tab?.pendingUrl;
    if (typeof pending === "string" && pending && pending !== BLANK_URL) return;
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
  // `handleTabRemoved` has almost certainly already done the first two: Chrome
  // fires `onRemoved` for EVERY removal, including one the extension asked for.
  // Two mutations proved that by surviving — deleting these lines changes
  // nothing observable while the listener is registered.
  //
  // They stay, and not as decoration. This function's contract is that after it
  // returns, the module holds no claim on that tab — and delivery of the
  // listener is Chrome's business, not this function's. Depending on it here
  // would make an ordinary close correct only as a side effect of an event
  // handler somewhere else. `boundTabId` in particular is NOT touched by the
  // listener at all (see `handleTabRemoved` for why), so that line is the only
  // thing that clears it and is not redundant with anything.
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
      }

      // `null` MEANS "DO NOT REPLY", ON THE SHARED PATH AND NOT ONLY IN ONE
      // BRANCH. Handlers return it for a frame that carried no requestId — a
      // paused browser's guard does, and so does `replyForFailedCommand` — and
      // a reply with no id settles nothing on the server, whose `pending` map is
      // keyed by it. Without this the value reached `sendOn` and
      // `JSON.stringify(null)` wrote the literal string "null" onto the wire.
      // The server drops it harmlessly, so it was cosmetic; the reason it is
      // fixed here rather than in each handler is that the convention was
      // honoured by one branch's own early return and by nothing else, so the
      // next handler to return null would have inherited the same bug.
      if (result === null || result === undefined) return;

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
      // A THIRD LAYER, not a co-equal guard — stated precisely because an
      // earlier version of this comment over-credited it, and the half whose
      // necessity cannot be demonstrated is the half a later reader deletes as
      // dead code. Removing this line alone changes nothing observable: it
      // survives the whole suite, including the case where a timer really is
      // armed (1011 schedules one, a config change opens a second socket, 4409
      // then closes the live one), because `connect` clears the timer
      // unconditionally on its live path before building anything. So this
      // covers a window `connect` has already closed. It is kept because it is
      // one correct line and it makes this branch self-contained: a terminal
      // close leaves no timer behind regardless of what any other function
      // happens to do today.
      clearReconnectTimer();
      // THIS is the guard. Both the reconnect timer's callback and `keepalive`
      // reconnect FROM `config`, and `connect`'s cold-entry verdict check is
      // gated on its absence — so dropping it is what stops this worker
      // rebuilding the very connection this branch is refusing. Pinned by
      // `__hasConfig`, and removing it is killed.
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

/**
 * Test-only: drop the handle on the current tab WITHOUT closing it or giving up
 * ownership.
 *
 * Exists because `ensureAgentTab` reuses the one tab the module holds, so after
 * F1 there is no path that gives the agent two live tabs at once — and the
 * ownership rules for the two-tab case still have to be right before anyone
 * adds one. This produces exactly that state and nothing else: the tab stays
 * open and stays in `createdTabIds`.
 */
export function __forgetCurrentTab() {
  agentTabId = null;
  boundTabId = null;
}

/** Test-only: the queue, so a test can await the command it just delivered. */
export function __commandQueue() {
  return commandQueue;
}

/**
 * Test-only: whether this worker still holds a config it could reconnect with.
 *
 * `config = null` is THE guard that makes a terminal close terminal: both the
 * reconnect timer's callback and `keepalive` require a config, so dropping it
 * is what stops either from rebuilding the connection. Removing it is KILLED.
 *
 * It is exposed rather than asserted through behaviour because the terminal
 * path also calls `clearReconnectTimer()`, which hides it: with no timer armed
 * there is nothing to observe a live config through. Asserting the mechanism
 * directly is the only way to tell the two apart. See the terminal branch in
 * `onclose` for what that second call is actually worth — less than an earlier
 * version of this comment claimed.
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
  // Exported for one assertion: that this set and the real `cdp` surface agree
  // about which methods take a tab id. A set that drifts from the surface is
  // how `detachAll` got wrapped and became unrunnable.
  TAB_ID_ACTS,
};
