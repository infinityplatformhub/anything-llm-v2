import { useEffect, useState } from "react";
import { loadServerConfig, maskKey, reconnect } from "./companionApi.js";

/**
 * Where the connection stands, and the way back when it has gone terminal.
 *
 * WHY "RECONNECT" IS NOT COSMETIC
 *
 * Two close codes are TERMINAL by design in socket.js, and both are remembered
 * across a service-worker teardown so the next wake does not undo the decision:
 *
 *   4409 — another browser took this user's slot. Reconnecting automatically
 *     would take it back, evicting the other browser, which reconnects and
 *     takes it back again: a slot fight neither user can see the cause of.
 *   4401/4403 — the key was rejected. Retrying a rejected credential turns a
 *     configuration mistake into a login-attempt flood.
 *
 * Refusing to retry is right, and it leaves the user stuck by construction:
 * without a control HERE, an evicted user has no path back short of
 * reinstalling the extension. That is what this button is.
 */
export default function ConnectionTab({ status, onError, onRefresh }) {
  const [config, setConfig] = useState({ apiBase: "", apiKey: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadServerConfig().then(setConfig);
  }, []);

  const socketStatus = status?.socket?.status ?? "idle";
  const terminal = socketStatus === "evicted" || socketStatus === "unauthorized";

  const tryAgain = async () => {
    setBusy(true);
    const reply = await reconnect();
    setBusy(false);
    onError(reply.ok ? null : reply.error);
    // Re-read rather than trusting the reply's snapshot: the connection is
    // still being established when the message returns, so the status the popup
    // shows should come from the next poll, not from this moment.
    onRefresh();
  };

  return (
    <>
      <div className="companion-field">
        <span className="companion-label">server</span>
        <div className="companion-input">{config.apiBase || "not set"}</div>
      </div>
      <div className="companion-field">
        <span className="companion-label">api key</span>
        {/* Masked: this popup gets opened during screen shares. */}
        <div className="companion-input">{maskKey(config.apiKey)}</div>
      </div>

      <div className="companion-row">
        <div>
          <div className="companion-row-t">socket</div>
          <div className="companion-row-s">
            {SOCKET_EXPLANATION[socketStatus] ?? socketStatus}
          </div>
        </div>
        <span className={`companion-flag ${SOCKET_TONE[socketStatus] ?? "warn"}`}>
          {socketStatus}
        </span>
      </div>

      {/*
        The socket's own message, shown verbatim. socket.js writes these for a
        person to read ("Another browser connected with this account and took
        over…"), and paraphrasing them here would mean two places to keep in
        step.
      */}
      {status?.socket?.lastError ? (
        <div className={terminal ? "companion-alert" : "companion-note"}>
          {status.socket.lastError}
        </div>
      ) : null}

      {terminal ? (
        <button
          type="button"
          className="companion-btn solid"
          disabled={busy}
          onClick={tryAgain}
        >
          {busy ? "กำลังต่อใหม่…" : "ต่อใหม่จากเบราว์เซอร์นี้"}
        </button>
      ) : null}
    </>
  );
}

/**
 * What each socket state means for the user, in the terms their next action
 * depends on. Reported honestly rather than collapsed to online/offline: an
 * evicted browser, a rejected key and a browser that is merely still connecting
 * all look like "not working" and call for three different responses.
 */
const SOCKET_EXPLANATION = Object.freeze({
  idle: "ไม่ได้ต่อ",
  connecting: "กำลังต่อ…",
  online: "ต่ออยู่ agent สั่งงานได้",
  evicted: "ถูกเบราว์เซอร์อื่นแย่งสิทธิ์ไป",
  unauthorized: "key ถูกปฏิเสธ",
});

const SOCKET_TONE = Object.freeze({
  idle: "warn",
  connecting: "warn",
  online: "ok",
  evicted: "crit",
  unauthorized: "crit",
});
