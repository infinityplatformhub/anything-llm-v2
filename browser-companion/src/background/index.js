// Service worker entry: reads the config the popup wrote and opens the socket.
//
// Lifetime constraint everything here is shaped by, recorded because it is not
// visible from this file's contents:
//
//   - An MV3 service worker is torn down after ~30s with no events. Anything that
//     must outlive that (an open socket to AnythingLLM) has to be re-established on
//     wake, not merely opened once at load. That is why `startCompanion` runs at
//     module top level as well as from every event: a wake re-runs this file, and
//     the top-level call is what rebuilds the connection.
//   - `chrome.alarms` cannot be used to paper over this with a sub-minute tick:
//     periods under 1 minute are honoured only for UNPACKED extensions and are
//     clamped to 1 minute once the extension is packed from the Web Store. A
//     keepalive built on a 30s alarm therefore works in development and silently
//     stops working in the shipped build. See KEEPALIVE_MINUTES in socket.js,
//     which records this as a Web Store shipping blocker.
import { handle } from "./dispatch.js";
import { loadAllowlist } from "./allowlist.js";
import { record } from "./auditLog.js";
import { cdp } from "./cdp.js";
import * as pageState from "./pageState.js";
import * as socket from "./socket.js";
import * as control from "./control.js";

/**
 * The `chrome.storage.sync` keys the popup writes the server address and key
 * to. Exported so a test asserts against the real values rather than restating
 * them: reading the wrong keys makes the companion silently never connect —
 * both values arrive `undefined` and `connect` returns idle without a word.
 */
export const CONFIG_KEYS = Object.freeze(["apiBase", "apiKey"]);

/**
 * The dependency bundle `dispatch.handle` runs against.
 *
 * ALL FIVE TAB ACCESSORS ARE SUPPLIED HERE, and dispatch.js deliberately
 * defaults NONE of them: a no-op default would make a wiring mistake look like
 * a working dispatch, failing as "the agent did nothing" rather than as a
 * missing dependency. This object is the single place they are wired, so there
 * is one thing to get right rather than one per command.
 *
 * `isAllowed` and `isSameOrigin` are deliberately ABSENT. dispatch.js imports
 * the judgement directly from allowlist.js; passing it through here would make
 * the entire security boundary injectable, and a permissive value would leave
 * every test green.
 *
 * EXPORTED so `__tests__/background.test.js` can assert the wiring against this
 * object rather than restating it. A test that restated the list could not fail
 * when the list changed — and a mutation run proved that: dropping
 * `listAgentTabs` and `closeTab` here, and slipping a permissive `isAllowed`
 * in, all survived a suite that had no reference to this file at all.
 */
export const deps = {
  loadAllowlist,
  record,
  agentTabUrl: socket.agentTabUrl,
  ensureAgentTab: socket.ensureAgentTab,
  listAgentTabs: socket.listAgentTabs,
  switchToTab: socket.switchToTab,
  closeTab: socket.closeTab,
  cdp,
  pageState,
  lookup: pageState.lookup,
};

/**
 * Open (or re-open) the connection using whatever the popup last stored.
 *
 * Safe to call repeatedly and from every listener below: `socket.connect`
 * no-ops when an equivalent socket is already live, which is what keeps the
 * five call sites from leaving five sockets open.
 */
export async function startCompanion() {
  try {
    const { apiBase, apiKey } = await chrome.storage.sync.get(CONFIG_KEYS);
    await socket.connect({
      apiBase,
      apiKey,
      // WRAPPED, not called directly. `control.guardCommands` is what makes the
      // popup's pause real: a paused browser refuses here, BEFORE a tab is
      // resolved, the allowlist is consulted or a debugger is attached. Wiring
      // `handle` in bare would leave the pause button changing a flag nothing
      // reads — the popup would say "paused" and the agent would carry on
      // clicking, which is the single worst failure this control can have.
      onCommand: control.guardCommands((command) => handle(command, deps)),
    });
  } catch (error) {
    // A rejected `storage.sync.get` (offline profile, quota, a disabled sync
    // account) would otherwise be an unhandled rejection in the service worker
    // and leave no trace anywhere the user can see.
    console.error(
      "[AnythingLLM Companion] could not start the companion:",
      error
    );
  }
}

/**
 * The two listener BODIES, named and exported rather than written inline.
 *
 * A review found all three of the original inline bodies unmeasured: the suite
 * asserted each listener was REGISTERED and never invoked one, so reading the
 * wrong storage keys (never connects), listening on `local` instead of `sync`
 * (the popup's reconnect does nothing), and inverting the alarm-name guard (the
 * keepalive becomes a no-op) all survived 487 tests. Two of those are total
 * feature failures, not degradations.
 *
 * Exporting them makes each a function a test can call with the arguments
 * Chrome would pass. That is not a simulation of the MV3 lifecycle — it is a
 * function call, and it is the difference between asserting the wiring exists
 * and asserting it works.
 */
export function onStorageChanged(changes, area) {
  if (area === "sync" && (changes?.apiBase || changes?.apiKey))
    startCompanion();
}

export function onAlarm(alarm) {
  if (alarm?.name !== socket.KEEPALIVE_ALARM) return;
  // `false` means this worker woke cold and socket.js has no config to
  // reconnect with — so the config has to come from storage, which is this
  // file's job and not that module's.
  if (!socket.keepalive()) startCompanion();
}

/**
 * The popup's messages, answered by control.js.
 *
 * `startCompanion` is injected rather than imported over there: index.js
 * imports control.js, so an import back would be a cycle whose binding is still
 * uninitialised when control.js's top level runs.
 *
 * The `return` is load-bearing. `control.onMessage` answers `true` to hold the
 * message channel open for its async reply; dropping that return value makes
 * the listener answer `undefined`, Chrome closes the channel immediately, and
 * every popup request resolves `undefined` — a popup stuck on its loading state
 * with no error anywhere.
 */
export function onRuntimeMessage(message, sender, sendResponse) {
  return control.onMessage(message, sender, sendResponse, {
    restart: startCompanion,
  });
}

chrome.runtime.onStartup.addListener(startCompanion);
chrome.runtime.onInstalled.addListener(startCompanion);
chrome.runtime.onMessage.addListener(onRuntimeMessage);
chrome.storage.onChanged.addListener(onStorageChanged);
chrome.alarms.onAlarm.addListener(onAlarm);

// Not only from the listeners: a wake re-runs this module, and by then
// `onStartup`/`onInstalled` have long since fired. Without this the socket is
// only ever rebuilt when a storage change or an alarm happens to arrive.
startCompanion();
