# AnythingLLM Browser Companion

Lets an AnythingLLM agent read and click in your own Chrome, on the domains you
allow, using trusted CDP input via `chrome.debugger`.

This is a separate extension from `browser-extension/` (the save-to-workspace
companion, which is a git submodule of Mintplex's repo). Both can be installed.

## Install (unpacked)

1. `yarn install && yarn build`
2. Open `chrome://extensions`, enable Developer mode
3. Load unpacked, select this folder's `dist/`
4. Click the extension, enter your AnythingLLM server URL and paste your
   browser-extension API key. The server URL is yours to supply — this extension
   ships no default host, because AnythingLLM runs wherever you put it.
5. Open the domains you want the agent to touch — everything is off by default

Chrome shows a "DevTools is debugging this tab" bar on any tab the agent drives.
That bar cannot be hidden; it is Chrome telling you the truth about what is happening.

## Service worker lifetime

The MV3 service worker is torn down after roughly 30 seconds of inactivity, so the
connection to AnythingLLM is re-established on wake rather than held open forever.
`chrome.alarms` periods below 1 minute fire only while the extension is loaded
unpacked — Chrome clamps them to 1 minute for packed builds — so no part of this
extension may depend on a sub-minute alarm to stay alive.

## Test

    yarn test

The suite runs on the repo root's jest (`../node_modules/jest`) rather than a
second copy of jest installed here, matching what `server/` does. The tests are
ESM, which jest reads only under `--experimental-vm-modules`; the `test` script
sets that flag, so run the suite through the script rather than calling jest
directly.
