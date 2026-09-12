import { useCallback, useEffect, useState } from "react";
import { readAll } from "../../background/auditLog.js";

/**
 * The record of what the agent actually did in this browser.
 *
 * TWO THINGS THIS SCREEN OWES THE USER BEYOND LISTING ROWS
 *
 * 1. WHEN THE LOG HAS GONE SILENT, SAY SO. `auditLog` sets a sticky flag on the
 *    first failed write (a full store, usually — the quota covers the whole
 *    extension). A user reading a short log needs to know it is short because
 *    writes FAILED, not because nothing happened. An audit log that quietly
 *    stops is worse than none, because it is trusted.
 *
 * 2. EXPLAIN THE VAGUE DENIALS. `page_switch` denials are coarse BY DESIGN:
 *    they do not record which url matched, because looking at the url was
 *    itself the leak — the ordinary denial quoted the offending url, so probing
 *    substrings recovered the full url of every tab the user had open. Without
 *    a line saying so, a reader sees a denial with no url and reads it as a bug
 *    in the logging.
 */
export default function HistoryTab({ status, onError }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setRows(await readAll());
    } catch (error) {
      onError(
        `Could not read the activity log: ${String(error?.message ?? error)}.`
      );
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const failure = status?.auditWriteFailure ?? null;

  /**
   * Download the log as JSON.
   *
   * JSON rather than the rendered lines: this is the artefact someone attaches
   * to a support conversation or reads months later, and the rendering here is
   * lossy on purpose (it truncates urls to fit 376px). The download is the
   * whole entry.
   */
  const download = useCallback(() => {
    try {
      const blob = new Blob([JSON.stringify(rows, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `anythingllm-companion-log-${new Date()
        .toISOString()
        .slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoked after the click, or the blob is held for the life of the
      // document — which for a popup is short, but this popup is opened many
      // times a session.
      URL.revokeObjectURL(url);
    } catch (error) {
      onError(
        `Could not prepare the log for download: ${String(
          error?.message ?? error
        )}`
      );
    }
  }, [rows, onError]);

  if (loading) return <div className="companion-empty">Loading…</div>;

  return (
    <>
      {failure ? (
        <div className="companion-alert" role="alert">
          บันทึกกิจกรรมเขียนไม่สำเร็จตั้งแต่ {formatTime(failure.at)} (
          {failure.message}) — รายการด้านล่างจึง<b>ไม่ครบ</b>
          {failure.recovered
            ? " ระบบลบของเก่าทิ้งบางส่วนเพื่อให้เขียนต่อได้"
            : " และอาจยังเขียนไม่ได้อยู่"}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="companion-empty">
          ยังไม่มีอะไรถูกบันทึก
          <br />
          ทุกคำสั่งที่เข้าเบราว์เซอร์นี้จะขึ้นที่นี่ ทั้งที่ผ่านและที่ถูกปฏิเสธ
        </div>
      ) : (
        <div className="companion-log">
          {rows
            .slice()
            .reverse()
            .map((row, index) => (
              <span
                // The index is part of the key on purpose: two entries can share
                // a millisecond timestamp and a command, and a key that is not
                // unique makes React reuse the wrong row.
                key={`${row.at}-${index}`}
                className={row.outcome === "denied" ? "denied" : undefined}
              >
                {formatTime(row.at)} <b>{row.cmd}</b>
                {row.url ? ` ${row.url}` : ""} → {row.outcome}
                {row.detail ? ` (${row.detail})` : ""}
              </span>
            ))}
        </div>
      )}

      {/*
        Shown whenever there is anything to read, not only when a switch denial
        happens to be on screen: the reader who needs this line is the one
        puzzling over a denial with no url, and the log is capped at 500 entries
        so the relevant one may already be several screens up.
      */}
      {rows.length > 0 ? (
        <div className="companion-note">
          คำสั่งที่ถูกปฏิเสธของ <b>page_switch</b> จะไม่บอกว่าไปตรงกับ URL ไหน
          — ตั้งใจให้เป็นแบบนั้น เพราะการบอกว่าตรงกับอะไร
          คือการเปิดเผยแท็บที่คุณเปิดอยู่ให้ฝั่งที่ถูกปฏิเสธรู้ ไม่ใช่ bug
        </div>
      ) : null}

      <button
        type="button"
        className="companion-btn"
        disabled={rows.length === 0}
        onClick={download}
      >
        ดาวน์โหลด log
      </button>
    </>
  );
}

/**
 * `14:32:09` from an ISO timestamp.
 *
 * Falls back to the raw value rather than rendering "Invalid Date": the entries
 * are written by this extension, but the log is also the place a corrupted
 * store shows up, and showing what is actually stored is more useful there.
 */
function formatTime(at) {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return String(at ?? "");
  return parsed.toLocaleTimeString();
}
