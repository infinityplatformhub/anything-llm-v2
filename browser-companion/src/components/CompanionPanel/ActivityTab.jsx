import { useState } from "react";
import { focusAgentTab, setPaused } from "./companionApi.js";

/**
 * What the agent is doing, and the two controls for taking over from it.
 *
 * THE HANDOVER IS THE POINT OF THIS SCREEN. A captcha or a one-time code
 * arrives, the agent cannot pass it, and the user has to act in the tab the
 * agent is working in. Two things are needed for that and neither is
 * decorative: a pause that really stops commands (not a flag nothing reads),
 * and a way to REACH the tab — which is `chrome.tabs.update(agentTabId,
 * {active: true})`, since the agent's tab is opened `active: false` and the
 * user may have no idea where it is among twenty others.
 */
export default function ActivityTab({ status, onError, onRefresh }) {
  const [busy, setBusy] = useState(false);

  const paused = Boolean(status?.paused);
  const socketStatus = status?.socket?.status ?? "idle";
  const attached = status?.attachedTabs ?? 0;

  const togglePause = async () => {
    setBusy(true);
    const reply = await setPaused(!paused);
    setBusy(false);
    onError(reply.ok ? null : reply.error);
    onRefresh();
  };

  const goToTab = async () => {
    setBusy(true);
    const reply = await focusAgentTab();
    setBusy(false);
    // A failure here is ordinary — the agent may have no tab open — so it is
    // reported in words rather than swallowed into a button that does nothing.
    onError(reply.ok ? null : reply.error);
  };

  return (
    <>
      {attached > 0 ? (
        <div className="companion-step">
          <span className="companion-step-h">
            กำลังคุมแท็บอยู่ · {attached} แท็บ
          </span>
          <span>
            Chrome จะขึ้นแถบ "DevTools is debugging this tab"
            ทุกแท็บที่ agent คุมอยู่ ซ่อนไม่ได้ — นั่นคือ Chrome
            บอกความจริงว่ากำลังเกิดอะไรขึ้น
          </span>
        </div>
      ) : (
        <div className="companion-empty">
          ไม่มีงานอยู่
          <br />
          agent ยังไม่ได้ขอคุมแท็บไหน
        </div>
      )}

      {paused ? (
        <div className="companion-note">
          แท็บยังอยู่ที่คุณ — กดเองได้ตามปกติ agent จะไม่แทรก
          <br />
          {/*
            The honest scope of the pause, stated on screen. It lives in the
            service worker's memory, and an MV3 worker is torn down after ~30s
            idle, so a pause does not survive the browser going quiet. Implying
            otherwise would be worse than the limitation itself.
          */}
          <b>
            หมายเหตุ: การหยุดนี้อยู่แค่ช่วงที่ยังทำงานต่อเนื่อง
            ถ้าปล่อยเบราว์เซอร์ทิ้งไว้เงียบ ๆ ราวครึ่งนาที ตัวส่วนขยายจะถูก
            Chrome ปิดพัก แล้วสถานะหยุดจะหายไป
          </b>
        </div>
      ) : null}

      {socketStatus === "evicted" ? (
        <div className="companion-alert" role="alert">
          เบราว์เซอร์อื่นเข้ามาใช้บัญชีนี้แล้วแย่งสิทธิ์ไป
          เครื่องนี้จึงหยุดรับคำสั่ง — ถ้าต้องการให้ agent
          คุมเครื่องนี้ ไปที่แท็บ "เชื่อมต่อ" แล้วกดต่อใหม่
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="companion-btn solid"
          disabled={busy}
          onClick={togglePause}
        >
          {paused ? "ทำต่อ" : "หยุด สลับมือ"}
        </button>
        <button
          type="button"
          className="companion-btn"
          disabled={busy}
          onClick={goToTab}
        >
          ไปที่แท็บของ agent
        </button>
      </div>
    </>
  );
}
