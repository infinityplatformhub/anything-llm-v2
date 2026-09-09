/**
 * The popup's half of the extension, answered from the service worker.
 *
 * WHY THE POPUP CANNOT JUST IMPORT socket.js AND auditLog.js
 *
 * The popup document and the MV3 service worker are separate JavaScript
 * realms. Importing `socket.js` from the popup does not reach the worker's
 * module state — it constructs a SECOND, empty copy: `state()` would answer
 * `idle` forever and `getWriteFailure()` would answer `null` forever, no matter
 * what the worker had actually seen. Both would look like a working popup
 * showing reassuring values, which is the worst shape this UI can take, because
 * every value it exists to surface is a warning.
 *
 * So anything that lives in worker memory crosses by message. Anything that
 * lives in `chrome.storage` (the allowlist, the audit entries) the popup reads
 * directly, because storage is genuinely shared and a message would only add a
 * hop that can fail.
 *
 * WHY PAUSE LIVES HERE AND NOT IN dispatch.js
 *
 * `dispatch.handle` is where the allowlist gate is, and task 7 made that gate
 * structurally unskippable. Pausing is a SECOND, stricter refusal that happens
 * BEFORE the gate: a paused companion answers without resolving a tab, without
 * consulting the allowlist and without attaching a debugger. Adding a pause
 * branch inside `handle` would mean editing the one function whose single
 * mandatory path is the whole security argument, to add a case that can only
 * ever refuse more. Wrapping `onCommand` keeps that function untouched and
 * makes the pause fail closed by construction — if this wrapper is not applied,
 * commands run; if it is, a paused browser cannot reach the gate at all.
 */
import { record, getWriteFailure } from "./auditLog.js";
import { attachedTabIds, detachAll } from "./cdp.js";
import * as socket from "./socket.js";
import { MSG, okReply, errorReply } from "../shared/companionMessages.js";

/**
 * Per-worker, like every other piece of state in this extension.
 *
 * NAMED COST, because it is a real one and the popup has to tell the truth
 * about it: a pause does NOT survive the ~30s MV3 idle teardown. A user who
 * pauses to solve a captcha, then leaves the browser alone for a minute, wakes
 * a worker that starts unpaused. Storing it durably would fix that and would
 * introduce a worse failure — a stored `paused: true` that a later failed write
 * cannot clear leaves a browser that silently refuses every command with no way
 * back except reinstalling. The pause is a "hold on while I do this now"
 * control, and the honest scope for it is the burst of activity it interrupts.
 * The popup says so on screen rather than implying a durable setting.
 */
let paused = false;

/** @returns {boolean} */
export function isPaused() {
  return paused;
}

/** Test-only: drop the pause between cases. */
export function __reset() {
  paused = false;
}

/**
 * Record a control action, and let a failed write stay where it is already
 * visible.
 *
 * The `.catch` is NOT a swallow. `auditLog.record` has, by the time it rejects,
 * already written to the console AND set the sticky `getWriteFailure()` flag
 * that `getStatus` reports and the popup renders as a banner. So the failure
 * reaches the user on the same screen either way, and re-throwing here would
 * take down a pause the user asked for over a logging problem — turning "your
 * history is incomplete" into "your stop button did nothing", which is strictly
 * worse.
 */
function recordControl(entry) {
  return record(entry).catch(() => {});
}

/**
 * Pause or resume.
 *
 * @param {boolean} next
 * @returns {Promise<boolean>} the state now in effect
 */
export async function setPaused(next) {
  const value = Boolean(next);
  paused = value;
  // Recorded even when it does not change the value, because "the user pressed
  // stop twice" and "the user pressed stop once" are different stories and the
  // log is the only place either is told.
  await recordControl({
    cmd: value ? "pause" : "resume",
    url: null,
    outcome: "ok",
    detail: value
      ? "the user paused the agent from the extension"
      : "the user resumed the agent from the extension",
  });
  return paused;
}

/**
 * Stop everything, now.
 *
 * TWO ACTIONS, AND THE SECOND IS THE ONE THAT MATTERS. Pausing refuses the NEXT
 * command; detaching gives back the debugger attachments this browser is
 * holding RIGHT NOW, which is what removes the agent's ability to send input
 * into pages that are already open. A pause alone would leave every attached
 * tab still attached, with Chrome's "DevTools is debugging this tab" bar still
 * up, which reads to the user as "it did not stop".
 *
 * The pause is set BEFORE the detach and is never rolled back if the detach
 * throws: a half-failed kill must leave the browser in the more restrictive
 * state, never the less. `detachAll` is documented not to reject, so the
 * `finally` is about the ordering guarantee rather than about an expected
 * throw.
 *
 * @returns {Promise<{paused: boolean, detached: number}>}
 */
export async function killSwitch() {
  paused = true;
  const detached = attachedTabIds().length;
  try {
    await detachAll();
  } finally {
    await recordControl({
      cmd: "kill_switch",
      url: null,
      outcome: "ok",
      detail: `the user cut the agent off from every tab (${detached} attached)`,
    });
  }
  return { paused, detached };
}

/**
 * The wrapper that makes the pause real.
 *
 * @param {(command: object) => Promise<object>} handler normally
 *   `(command) => dispatch.handle(command, deps)`
 * @returns {(command: object) => Promise<object|null>}
 */
export function guardCommands(handler) {
  return async (command) => {
    if (!paused) return handler(command);

    const cmd = command?.cmd;
    await recordControl({
      cmd: typeof cmd === "string" ? cmd : "unknown",
      url: null,
      outcome: "denied",
      detail: "paused by the user",
    });

    // The same reply shape `dispatch.handle` produces, including the `null` for
    // a frame with no requestId — the server keys its pending table on that id,
    // so a reply built without one settles nothing and is noise on the wire.
    const requestId = command?.requestId;
    if (requestId === undefined || requestId === null) return null;
    return {
      requestId,
      ok: false,
      error:
        "The user has paused this browser from the AnythingLLM extension, so nothing was done. They are usually handling something themselves (a captcha or a one-time code). Wait and try again, or ask them to press resume.",
    };
  };
}

/**
 * Everything the popup renders, in one round trip.
 *
 * One message rather than five, because five would let the popup draw a status
 * assembled from five different moments — a socket reported `online` beside a
 * pause that was lifted in between.
 *
 * @returns {Promise<{ok: true, data: object}>}
 */
export async function getStatus() {
  return okReply({
    socket: socket.state(),
    paused,
    attachedTabs: attachedTabIds().length,
    hasAgentTab: socket.hasAgentTab(),
    // The sticky FIRST failure, or null. Reported verbatim rather than as a
    // boolean: the popup needs the timestamp and the reason to say anything
    // useful, and whether recovery worked changes what it tells the user.
    auditWriteFailure: getWriteFailure(),
  });
}

/**
 * The `chrome.runtime.onMessage` body, exported rather than written inline.
 *
 * Registration is not behaviour — index.js's own tests learned that when three
 * inline listener bodies turned out to be entirely unmeasured. A listener that
 * is a named export is a function a test can call with the arguments Chrome
 * would pass.
 *
 * `restart` is INJECTED rather than imported. index.js imports this module, so
 * importing `startCompanion` back from index.js would be a cycle — and under
 * ESM the cycle resolves to a binding that is still uninitialised at the moment
 * this module's top level runs, which fails at runtime only on the one path
 * that uses it. Passing it in keeps the dependency pointing one way.
 *
 * Returns `true` to keep the message channel open for the async reply, which is
 * what `chrome.runtime.onMessage` requires; without it the popup's
 * `sendMessage` resolves `undefined` before any handler has finished.
 *
 * @param {{type?: string, paused?: boolean}} message
 * @param {object} _sender
 * @param {(reply: object) => void} sendResponse
 * @param {{restart: () => Promise<void>}} deps
 * @returns {boolean} whether a reply is coming asynchronously
 */
export function onMessage(message, _sender, sendResponse, deps) {
  const type = message?.type;
  // Not ours: answer `false` so another listener in this extension can. A
  // handler that claimed every message would make a future second listener
  // silently unreachable.
  if (typeof type !== "string" || !type.startsWith("companion:")) return false;

  handleMessage(message, deps)
    .then(sendResponse)
    // Every failure becomes a reply. A handler that threw and answered nothing
    // would leave the popup's `await` pending until the port closes, and the
    // popup would render its loading state forever with no way to tell that
    // from a slow browser.
    .catch((error) => sendResponse(errorReply(error)));
  return true;
}

/**
 * @param {{type: string, paused?: boolean}} message
 * @param {{restart?: () => Promise<void>}} [deps]
 * @returns {Promise<object>}
 */
async function handleMessage(message, deps = {}) {
  switch (message.type) {
    case MSG.GET_STATUS:
      return getStatus();

    case MSG.SET_PAUSED:
      return okReply({ paused: await setPaused(message.paused) });

    case MSG.KILL_SWITCH:
      return okReply(await killSwitch());

    case MSG.RECONNECT: {
      if (typeof deps.restart !== "function") {
        // Not reachable through index.js's wiring, and deliberately loud rather
        // than a silent no-op: a popup that clears the block without
        // reconnecting looks fixed and is not.
        return errorReply(
          "This extension is wired without a way to restart the connection, so reconnecting is not possible. Reload the extension."
        );
      }
      // Clearing the stored verdict is only half of it: the verdict also lives
      // in the worker's own `status`, and a worker that has already given up
      // will not retry on its own. So the block is cleared and then a
      // connection is actually attempted, which is what the user pressed the
      // button for.
      const cleared = await socket.clearTerminalVerdict();
      if (!cleared) {
        return errorReply(
          "Could not clear the stored connection refusal, so reconnecting would be refused again. Check that the browser has storage space available."
        );
      }
      await deps.restart();
      return okReply({ socket: socket.state() });
    }

    case MSG.FOCUS_AGENT_TAB: {
      const focused = await socket.focusAgentTab();
      if (!focused) {
        return errorReply(
          "The agent has no tab open in this browser right now, so there is nothing to switch to."
        );
      }
      return okReply({ focused: true });
    }

    default:
      return errorReply(`Unknown companion message "${message.type}".`);
  }
}
