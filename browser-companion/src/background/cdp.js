/**
 * The Chrome DevTools Protocol layer: the only code in this extension that
 * actually touches a page.
 *
 * WHY CDP AND NOT scripting.executeScript
 *
 * Input synthesised through `Input.dispatchMouseEvent` / `Input.insertText`
 * reaches the page indistinguishable from the user's own hands: it carries
 * `isTrusted: true`, goes through the browser's real hit-testing, and is
 * therefore honoured by the many sites that ignore untrusted synthetic events.
 * That is exactly why nothing in this file may be reached before the allowlist
 * gate has run.
 *
 * This module deliberately contains NO permission logic of its own. A second,
 * partial check here would invite the belief that a caller can skip the real
 * one, and would give a future reader two places to look for the boundary.
 * `dispatch.js` is the only caller and the gate is on its path — see the
 * `pageCommand` construction there.
 *
 * ONE DEBUGGER CLIENT PER TAB
 *
 * Chrome allows a single debugger client per target. If the user has DevTools
 * open on the tab, `attach` rejects and there is nothing this code can do about
 * it but say so in words the user can act on.
 */

// The CDP revision the method names below belong to. Not a deployment knob:
// changing it would mean changing the calls too.
const CDP_VERSION = "1.3";

// Randomised gap between keystrokes. A fixed cadence is itself a bot signal,
// and a burst of instant keystrokes also outruns the debounced change handlers
// that React-style editors attach to their inputs — the text lands and the
// site's own state never updates. The range sits inside human typing speed.
const KEYSTROKE_MIN_MS = 30;
const KEYSTROKE_JITTER_MS = 60;

// One wheel notch of scroll, in CSS pixels. A gesture size, not a deployment
// detail, so it stays inline.
const SCROLL_DELTA_PX = 600;

/**
 * Tabs this module believes it holds a debugger attachment on.
 *
 * "Believes" is the operative word, and is why `handleDetach` is wired below.
 * Chrome detaches us without being asked in several ordinary cases: the tab
 * navigates somewhere the debugger may not go, the user dismisses the "…is
 * debugging this browser" infobar, the tab closes, or DevTools takes the slot.
 * Each leaves this Set claiming an attachment that no longer exists, and
 * `attach` would then early-return happily while every following `sendCommand`
 * fails with "Debugger is not attached to the tab" — which reads as a broken
 * CDP layer rather than as a lost attachment.
 *
 * @type {Set<number>}
 */
const attached = new Set();

/**
 * Forget an attachment Chrome has already torn down.
 *
 * Exported because it is the listener body, and a listener registered on a
 * global is otherwise untestable: a test would have to own `chrome` before this
 * module's top level runs, which ES module hoisting makes impossible.
 *
 * @param {{tabId?: number}} source the `chrome.debugger.onDetach` source
 */
export function handleDetach(source) {
  if (typeof source?.tabId === "number") attached.delete(source.tabId);
}

// Optional-chained the whole way: this module is imported by tests that have no
// `chrome` at all. Registered at load rather than per command, because a detach
// can happen at any moment, including while nothing is in flight.
globalThis.chrome?.debugger?.onDetach?.addListener?.(handleDetach);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {number} tabId
 * @param {string} method a CDP method name
 * @param {object} params
 * @returns {Promise<any>} the CDP result object
 */
function send(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

/**
 * Attach the debugger to a tab, once.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 * @throws {Error} when the slot is taken or the tab is gone. The reason is
 *   restated in terms the user can act on: Chrome's own text ("Another debugger
 *   is already attached to the tab with id: 391") reaches the agent transcript
 *   and from there a support conversation, and it does not say what to do.
 */
export async function attach(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
  } catch (error) {
    const reason = String(error?.message ?? error);
    if (/another debugger/i.test(reason)) {
      throw new Error(
        `Cannot control this tab: something else is already debugging it. Close DevTools on that tab, then try again. (${reason})`
      );
    }
    throw new Error(`Cannot control this tab: ${reason}`);
  }
  attached.add(tabId);
}

/**
 * @param {number} tabId
 * @returns {Promise<void>} never rejects — a tab that has already gone is the
 *   normal reason a detach fails, not a failure worth propagating.
 */
export async function detach(tabId) {
  if (!attached.has(tabId)) return;
  // Deleted BEFORE the await, not after. `chrome.debugger.detach` rejects for a
  // tab that closed mid-command, and an id left behind by that rejection is
  // precisely the stale attachment this module must never hold.
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Already detached, or the tab is gone. The slot is free either way.
  }
}

/** @returns {Promise<void>} */
export async function detachAll() {
  for (const tabId of [...attached]) await detach(tabId);
}

/** @returns {number[]} which tabs this module currently believes it holds. */
export function attachedTabIds() {
  return [...attached];
}

/**
 * A left click at viewport coordinates.
 *
 * The `mouseMoved` first is load-bearing, not politeness: hover state and the
 * `mouseover` handlers that many menus hang their real click target on never
 * fire without it, so the press would land on an element that has not appeared.
 */
export async function click(tabId, x, y) {
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

/**
 * @param {number} tabId
 * @param {string} text the dispatcher has already refused a non-string; the
 *   coercion here only keeps this module safe to call on its own.
 */
export async function type(tabId, text) {
  for (const char of String(text)) {
    await send(tabId, "Input.insertText", { text: char });
    await sleep(
      KEYSTROKE_MIN_MS + Math.floor(Math.random() * KEYSTROKE_JITTER_MS)
    );
  }
}

export async function key(tabId, keyName) {
  const name = String(keyName);
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: name });
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: name });
}

/**
 * @param {number} tabId
 * @param {"up"|"down"} direction the dispatcher enforces the enum; anything
 *   else scrolls down here rather than throwing, because argument contracts are
 *   not this module's job.
 */
export async function scroll(tabId, direction) {
  const deltaY = direction === "up" ? -SCROLL_DELTA_PX : SCROLL_DELTA_PX;
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 100,
    y: 100,
    deltaX: 0,
    deltaY,
  });
}

/**
 * Point a tab at a URL.
 *
 * `chrome.tabs.update` rather than `Page.navigate`, because the rest of the
 * extension reasons about the tab through the tabs API and a CDP-driven
 * navigation does not update `tab.url`/`tab.pendingUrl` on the same schedule.
 */
export async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url });
}

/**
 * Run an expression in the page and return its value.
 *
 * CDP reports a page-side throw as a RESULT carrying `exceptionDetails`, not as
 * a rejected promise. A caller that only try/catches therefore sees a page
 * error as `undefined` — silently, and with `ok: true` all the way back to the
 * agent. Turning that into a throw is the entire reason this wrapper exists.
 */
export async function evaluate(tabId, expression) {
  const result = await send(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result?.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Runtime.evaluate failed"
    );
  }
  return result?.result?.value;
}

/**
 * GET a URL from inside the page, carrying the user's session cookies.
 *
 * READS ONLY, AND READS ONLY WHAT THIS FUNCTION DECIDES. The server-side plugin
 * records that its JSON schema is ADVISORY — aibitat runs no validation, so a
 * model can put `headers`, `body`, `credentials` or `method` on the wire beside
 * `url`. This function takes one URL and builds the request itself, so those
 * fields have nowhere to land. That must stay: accepting an options object here
 * would make the extension's read-only promise depend on a remote server
 * behaving well, and the server is the component assumed compromisable.
 *
 * `JSON.stringify` around the URL is what stops a URL containing a quote or a
 * backslash from closing the string literal and running as code in the page's
 * own origin.
 */
export async function fetchInPage(tabId, url) {
  return await evaluate(
    tabId,
    `fetch(${JSON.stringify(String(url))}, { credentials: "include", method: "GET" })
       .then((r) => r.text())`
  );
}

/**
 * The shape `dispatch.handle` expects as `deps.cdp`.
 *
 * Exported as one object rather than left for the caller to assemble, because
 * the mapping `fetch` → `fetchInPage` is the kind of hand-wiring that gets a
 * name wrong once and then fails only on the one command nobody tried.
 */
export const cdp = Object.freeze({
  attach,
  detach,
  detachAll,
  click,
  type,
  key,
  scroll,
  navigate,
  fetch: fetchInPage,
});

export { CDP_VERSION, SCROLL_DELTA_PX, KEYSTROKE_MIN_MS, KEYSTROKE_JITTER_MS };
