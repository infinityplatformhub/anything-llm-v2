# Android control from the chat browser

Every existing user role can use **Connect Android** in the chat header. No
admin-only Agent Skills setting or Personal MCP grant is required. Each browser
tab controls only the Android it explicitly connects; devices are not shared
between users or tabs.

## Use

1. Open AnythingLLM over HTTPS in Chrome or Edge on the computer connected to the
   phone. Android 7 or newer is required.
2. Enable Developer options and USB debugging on the phone, then connect a USB
   data cable.
3. Click **Connect Android → Connect device**, select the phone in the browser's
   USB picker, and accept the USB debugging prompt on the phone.
4. Ask in the same chat to inspect the phone or operate its UI. The agent can
   inspect screen/UI, tap, swipe, type, press Back/Home/Enter/Delete/Tab/App Switch,
   and launch an installed application by package name.
5. **Stop AI** aborts the agent and pending actions while keeping the USB
   connection. **Disconnect** releases the phone. The normal Stop generation
   button also cancels pending Android actions.

The tab must stay open. Reconnecting an agent websocket after its five-minute
idle timeout keeps the USB connection and same-page conversation. Reloading the
page releases the device; click Connect device again to reconnect. If another
program holds the ADB USB interface, close that program before connecting.

A model with image input can use screenshots. Text-only models can call
`android_inspect` with `screenshot: false` to use UI labels and bounds instead.
Android and some apps can block screenshots or UI inspection; the tool reports
missing UI information rather than inventing it.

Typing supports UTF-8, including Thai, by setting and pasting the Android
clipboard. This replaces the current device clipboard. A pinned scrcpy 3.3.1
helper is pushed to `/data/local/tmp` on first text input; no APK or root access
is required. The bundled helper is checked against its SHA-256 before use and
runs with video, audio and clipboard autosync disabled. Its source, digest and
Apache-2.0 license are bundled under `frontend/public/android/`.

## Implementation and isolation

The browser implements ADB over WebUSB using pinned Tango ADB packages. A
validated, all-role chat HTTP request creates an encrypted invocation and a
bounded, 60-second handoff containing hashes of the browser capability and
login session, plus the exact workspace/user/thread scope. The agent websocket
must present both the original browser capability and login session before
the handoff is consumed. Denied viewers do not consume it. Missing/expired
handoffs fail closed, including after a server restart.

Multi-user sessions recheck JWT expiry, active user and workspace membership on
frames, outgoing emissions and tool calls. Password and no-password single-user
installations use the same browser capability without requiring a user account.
The Android RPC accepts only typed UI actions, never arbitrary shell commands.
Responses are matched to a pending request on the initiating websocket and are
bounded in size and time. Disconnect, navigation or abort cancels the pending
browser subprocesses and prevents queued actions from running.

Agent session capabilities and screenshots stay out of browser persistent storage.
Tango stores the ADB host authorization key in IndexedDB to reuse the phone's
USB debugging authorization; connecting a device still requires the USB picker.
Screen images and UI data travel to the application server and selected model
provider for inference. Device conversations are omitted from shared chat
history, private prompts are encrypted in invocation rows, and automatic thread
renaming is skipped. Same-page text replay is owner-verified; durable private
history across reloads is not part of this feature. Changing login clears the
device and its capability before another user can use it.

## Regression coverage

- `androidActualHandler.test.js`: real chat route → encrypted invocation →
  owner-verified websocket → real agent/provider request formatting; default
  role, different user/tab, single-user password/no-password, membership
  revocation, screenshot/UI payload and shared-history privacy.
- `androidBridge.test.js`: one-shot scoped handoff, expiry/restart, cross-socket
  responses, abort, unsupported actions and image attachments.
- `androidBrowser.test.js`: real React chat/client models and Android command
  mapping with fake USB/ADB boundaries; all roles, first-message transition,
  UTF-8 clipboard, screenshots, five-minute reconnect, stop, disconnect and
  login changes.

These automated tests use a disposable database and simulated Android transport.
Physical-device USB/debugging and app behavior require a connected phone.
