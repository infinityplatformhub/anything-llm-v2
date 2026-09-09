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
async function startCompanion() {
  try {
    const { apiBase, apiKey } = await chrome.storage.sync.get([
      "apiBase",
      "apiKey",
    ]);
    await socket.connect({
      apiBase,
      apiKey,
      onCommand: (command) => handle(command, deps),
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

chrome.runtime.onStartup.addListener(startCompanion);
chrome.runtime.onInstalled.addListener(startCompanion);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && (changes.apiBase || changes.apiKey)) startCompanion();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name !== socket.KEEPALIVE_ALARM) return;
  // `false` means this worker woke cold and socket.js has no config to
  // reconnect with — so the config has to come from storage, which is this
  // file's job and not that module's.
  if (!socket.keepalive()) startCompanion();
});

// Not only from the listeners: a wake re-runs this module, and by then
// `onStartup`/`onInstalled` have long since fired. Without this the socket is
// only ever rebuilt when a storage change or an alarm happens to arrive.
startCompanion();
