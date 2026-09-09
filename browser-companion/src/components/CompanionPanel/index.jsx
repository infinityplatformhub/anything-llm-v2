import { useCallback, useEffect, useState } from "react";
import ConnectionTab from "./ConnectionTab.jsx";
import DomainsTab from "./DomainsTab.jsx";
import ActivityTab from "./ActivityTab.jsx";
import HistoryTab from "./HistoryTab.jsx";
import { getStatus, killSwitch } from "./companionApi.js";
import "./companion.css";

/**
 * The popup shell: the status line, the four tabs, and the kill switch.
 *
 * WHY THE KILL SWITCH IS RENDERED HERE AND NOT IN EACH TAB
 *
 * The mockup's own note says it: the button belongs on every tab, because when
 * you want to stop you should not have to work out which tab it is on. Putting
 * it in the shell makes that structural — a fifth tab added later cannot forget
 * it — rather than a rule four components each have to remember.
 */

/** The tab labels, in the mockup's order. */
const TABS = Object.freeze(["เชื่อมต่อ", "โดเมน", "กำลังทำ", "ประวัติ"]);

/**
 * How often the popup re-reads the worker's state.
 *
 * The popup cannot observe worker memory changing — there is no event for
 * "the socket went online" — so it polls while it is open. A popup is open for
 * seconds at a time, so this costs a handful of messages; the interval is short
 * enough that a state change during a handover does not go unnoticed.
 */
const POLL_MS = 1500;

export default function CompanionPanel() {
  const [tab, setTab] = useState(0);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [killing, setKilling] = useState(false);

  const refresh = useCallback(async () => {
    const reply = await getStatus();
    if (reply.ok) {
      setStatus(reply.data);
      return;
    }
    // A worker that cannot be reached is shown, not hidden behind a stale
    // status: every value on this screen is a claim about what the agent can
    // currently do, and a stale one is a claim that may no longer be true.
    setStatus(null);
    setError(reply.error);
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const cutEverything = useCallback(async () => {
    setKilling(true);
    const reply = await killSwitch();
    setKilling(false);
    if (!reply.ok) {
      setError(reply.error);
    } else {
      setError(null);
      setNotice(
        reply.data.detached > 0
          ? `หยุดแล้ว — ถอน agent ออกจาก ${reply.data.detached} แท็บ`
          : "หยุดแล้ว — agent ไม่ได้คุมแท็บไหนอยู่"
      );
    }
    refresh();
  }, [refresh]);

  const socketStatus = status?.socket?.status ?? "idle";
  const paused = Boolean(status?.paused);

  const tabProps = {
    status,
    onError: setError,
    onNotice: setNotice,
    onRefresh: refresh,
  };

  return (
    <div className="companion">
      <div className="companion-bar">
        <span className={`companion-dot ${dotFor(socketStatus, paused)}`} />
        <span className="companion-name">AnythingLLM Companion</span>
        <span className="companion-state">
          {paused ? `${socketStatus} · paused` : socketStatus}
        </span>
      </div>

      <div className="companion-tabs" role="tablist" aria-label="popup tabs">
        {TABS.map((label, index) => (
          <button
            key={label}
            type="button"
            role="tab"
            className="companion-tab"
            aria-selected={index === tab}
            onClick={() => setTab(index)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="companion-pane" role="tabpanel">
        {error ? (
          <div className="companion-alert" role="alert">
            {error}
          </div>
        ) : null}
        {notice ? <div className="companion-note">{notice}</div> : null}

        {tab === 0 ? <ConnectionTab {...tabProps} /> : null}
        {tab === 1 ? <DomainsTab {...tabProps} /> : null}
        {tab === 2 ? <ActivityTab {...tabProps} /> : null}
        {tab === 3 ? <HistoryTab {...tabProps} /> : null}

        {/*
          On every tab, by construction. See the note at the top of this file.
        */}
        <div className="companion-btns">
          <button
            type="button"
            className="companion-btn danger"
            disabled={killing}
            onClick={cutEverything}
          >
            ตัดทุกแท็บ
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The status dot's colour.
 *
 * Pause outranks the socket state: a browser that is online but paused is not
 * doing anything, and a green dot there would say the opposite of what the user
 * just asked for.
 */
function dotFor(socketStatus, paused) {
  if (socketStatus === "evicted" || socketStatus === "unauthorized")
    return "stop";
  if (paused) return "hold";
  return socketStatus === "online" ? "live" : "";
}
