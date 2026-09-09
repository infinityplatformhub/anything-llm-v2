// Service worker entry. Task 8 wires the socket client in here; this file exists
// now so the vite build has its second input and the bundle path is proven.
//
// Lifetime constraint task 8 has to design around, recorded here because it is not
// visible from this file's contents:
//
//   - An MV3 service worker is torn down after ~30s with no events. Anything that
//     must outlive that (an open socket to AnythingLLM) has to be re-established on
//     wake, not merely opened once at load.
//   - `chrome.alarms` cannot be used to paper over this with a sub-minute tick:
//     periods under 1 minute are honoured only for UNPACKED extensions and are
//     clamped to 1 minute once the extension is packed from the Web Store. A
//     keepalive built on a 30s alarm therefore works in development and silently
//     stops working in the shipped build.
//
// The `alarms` permission is declared in the manifest for that later reconnect
// scheduling; nothing here consumes it yet.
console.info("AnythingLLM Browser Companion service worker loaded.");
