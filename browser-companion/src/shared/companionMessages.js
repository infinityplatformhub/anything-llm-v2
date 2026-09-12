/**
 * The message names the popup and the service worker speak to each other with.
 *
 * WHY THIS FILE EXISTS RATHER THAN TWO SETS OF STRING LITERALS
 *
 * The popup document and the MV3 service worker are separate JavaScript
 * contexts. The popup cannot read the worker's module state — `socket.state()`,
 * `auditLog.getWriteFailure()` and the CDP attachments all live over there — so
 * every one of those answers arrives through `chrome.runtime.sendMessage`, and
 * a name that drifts on one side produces a popup that silently shows nothing
 * rather than an error anybody can see. One module, imported by both sides, is
 * what makes a rename a compile-time-visible change instead of a runtime shrug.
 *
 * These are a local protocol between two halves of one extension, not a
 * deployment setting, so they are constants rather than configuration.
 */

export const MSG = Object.freeze({
  /** Everything the popup needs to render its status line, in one round trip. */
  GET_STATUS: "companion:getStatus",
  /** Pause or resume the agent. `{ paused: boolean }`. */
  SET_PAUSED: "companion:setPaused",
  /** Pause AND drop every debugger attachment this browser holds. */
  KILL_SWITCH: "companion:killSwitch",
  /** Forget a stored terminal refusal (4409 eviction / 4401 auth) and retry. */
  RECONNECT: "companion:reconnect",
  /** Focus the tab the agent is working in, if it has one. */
  FOCUS_AGENT_TAB: "companion:focusAgentTab",
});

/**
 * The shape every handler answers with.
 *
 * Uniform on purpose: the popup has ONE place that decides whether a reply is
 * an error, so a handler that forgets to report a failure is a visible gap in
 * this file rather than a silent success in the UI.
 *
 * @typedef {{ok: true, data?: object} | {ok: false, error: string}} CompanionReply
 */

/** @returns {{ok: true, data: object}} */
export function okReply(data = {}) {
  return { ok: true, data };
}

/**
 * @param {unknown} error
 * @returns {{ok: false, error: string}}
 */
export function errorReply(error) {
  return { ok: false, error: String(error?.message ?? error) };
}
