/**
 * The popup's side of every boundary it talks across.
 *
 * WHY THIS IS ONE FILE AND NOT `chrome.*` CALLS SPRINKLED THROUGH THE TABS
 *
 * The popup reads from three places, and each fails in its own way:
 *   - the service worker, over `chrome.runtime.sendMessage` — which can answer
 *     `undefined` when the worker is asleep or was reloaded;
 *   - `chrome.storage.local`, for the allowlist and the audit log;
 *   - `chrome.storage.sync`, for the server address and key.
 * Handling those three shapes at each call site is how one of them ends up
 * unhandled. Everything crosses here, and everything below returns a settled
 * result rather than throwing at a React event handler where nothing catches.
 */
import { MSG } from "../../shared/companionMessages.js";

/**
 * Send one message to the service worker and normalise every failure shape.
 *
 * THREE FAILURE SHAPES, and they are not interchangeable:
 *   1. `sendMessage` REJECTS — the worker is gone and could not be woken.
 *   2. It RESOLVES `undefined` — no listener answered. This is what a wrongly
 *      wired listener looks like, and it is why it cannot be treated as an
 *      empty success.
 *   3. It resolves our own `{ok: false, error}` — the handler ran and refused.
 *
 * @param {string} type
 * @param {object} [payload]
 * @returns {Promise<{ok: true, data: object} | {ok: false, error: string}>}
 */
async function ask(type, payload = {}) {
  try {
    const reply = await chrome.runtime.sendMessage({ type, ...payload });
    if (!reply || typeof reply !== "object") {
      return {
        ok: false,
        error:
          "The extension's background worker did not answer. Reload the extension from chrome://extensions and open this again.",
      };
    }
    return reply;
  } catch (error) {
    return {
      ok: false,
      error: `Could not reach the extension's background worker: ${String(
        error?.message ?? error
      )}`,
    };
  }
}

/** @returns {Promise<object>} */
export const getStatus = () => ask(MSG.GET_STATUS);

/** @param {boolean} paused */
export const setPaused = (paused) => ask(MSG.SET_PAUSED, { paused });

export const killSwitch = () => ask(MSG.KILL_SWITCH);

export const reconnect = () => ask(MSG.RECONNECT);

export const focusAgentTab = () => ask(MSG.FOCUS_AGENT_TAB);

/**
 * The server address and key the user configured.
 *
 * Read straight from `storage.sync` rather than through the worker: it is
 * genuinely shared state, and a message would add a hop that can fail for a
 * value the popup can read itself.
 *
 * @returns {Promise<{apiBase: string, apiKey: string}>}
 */
export async function loadServerConfig() {
  try {
    const stored = await chrome.storage.sync.get(["apiBase", "apiKey"]);
    return {
      apiBase: typeof stored?.apiBase === "string" ? stored.apiBase : "",
      apiKey: typeof stored?.apiKey === "string" ? stored.apiKey : "",
    };
  } catch {
    // A profile with sync unavailable still gets a usable popup; the fields
    // simply show as unset, which is what they effectively are.
    return { apiBase: "", apiKey: "" };
  }
}

/**
 * Validate and save the connection settings the worker reads.
 *
 * `http:` remains valid for a local AnythingLLM server; everything else is
 * rejected here because the socket constructor only supports ws/wss after the
 * worker converts the scheme. The storage change event wakes the worker and
 * reconnects it, so this path does not send a second restart message.
 *
 * @param {{apiBase: string, apiKey: string}} config
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function saveServerConfig({ apiBase, apiKey }) {
  const server = String(apiBase ?? "").trim();
  let url;
  try {
    url = new URL(server);
  } catch {
    return {
      ok: false,
      error: "Server URL is invalid. Enter a complete http:// or https:// URL.",
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      error: "Server URL must start with http:// or https://.",
    };
  }

  try {
    await chrome.storage.sync.set({ apiBase: server, apiKey });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `Could not save connection settings: ${String(
        error?.message ?? error
      )}`,
    };
  }
}

/**
 * Show a key without showing the key.
 *
 * The popup is opened in front of other people, and a screen-share of a live
 * credential is a leak that no amount of care afterwards undoes. Enough of the
 * tail is kept for the user to tell two keys apart.
 *
 * @param {unknown} apiKey
 * @returns {string}
 */
export function maskKey(apiKey) {
  if (typeof apiKey !== "string" || !apiKey) return "not set";
  // Deliberately not proportional to the key's length: a mask whose width
  // tracked the secret would leak its length.
  const tail = apiKey.slice(-4);
  return `••••••••${tail}`;
}
