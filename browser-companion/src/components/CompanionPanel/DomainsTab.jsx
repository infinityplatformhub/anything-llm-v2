import { useCallback, useEffect, useState } from "react";
import {
  loadAllowlist,
  saveAllowlist,
  parseEntry,
} from "../../background/allowlist.js";

/**
 * The allowlist, which is the entire security boundary of this extension.
 *
 * WHAT THIS SCREEN IS ACTUALLY FOR
 *
 * The manifest asks Chrome for `<all_urls>` plus `debugger`, so by the time the
 * user sees this list Chrome has ALREADY granted access to every site they are
 * logged into, and CDP input is indistinguishable from their own hands. Chrome
 * will not check anything again. This list — enforced by `allowlist.js`, in
 * this extension's own code — is the only limit on that grant.
 *
 * So the empty state does not say "no domains yet". It says what is true: that
 * nothing is reachable, and that adding one is granting something. A screen
 * that made adding a domain feel like ticking a box would be lying about what
 * the click does.
 *
 * WHY EVERY WRITE IS WRAPPED IN try/catch — THE BRIEF FOR THIS TASK WAS WRONG
 *
 * `saveAllowlist` THROWS on a failed write, and verifies by reading back. That
 * design exists because believing a lie here means believing access was revoked
 * when it was not. The brief for this task named `saveAllowlist` at three
 * places and showed no catch at any of them; a popup written to that brief
 * would let a user remove a domain, see a tidy list, and leave the agent's
 * access intact — precisely the outcome the throw exists to prevent.
 *
 * So every call is caught, and on failure this component RE-READS storage and
 * renders what is actually stored. Keeping the optimistic list on screen would
 * be the same lie in a different place.
 */
export default function DomainsTab({ onError, onNotice }) {
  const [entries, setEntries] = useState([]);
  /** Which entries are switched on. See the note on `enabled` below. */
  const [enabled, setEnabled] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState(null);

  /**
   * The stored list is the list of ALLOWED hosts — `allowlist.js` has no notion
   * of a disabled entry, and inventing one in storage would mean this popup
   * writes a shape the gate does not read, so a "disabled" entry could still be
   * allowed. A switch that is off therefore means "not in storage", and the
   * popup keeps the host visible in its own state so turning it back on does
   * not mean retyping it.
   *
   * NAMED COST: that memory is per-popup. Close the popup with a domain
   * switched off and it is gone from the list, because it is genuinely gone
   * from the allowlist. The alternative — a second stored list of disabled
   * hosts — is a second source of truth about what is permitted, next to a gate
   * that reads only the first. The screen says so rather than implying the row
   * will still be there.
   */
  const refresh = useCallback(async () => {
    try {
      const stored = await loadAllowlist();
      setEntries((previous) => {
        // Anything already on screen but no longer stored stays visible as an
        // OFF row; anything stored is on.
        const merged = [...stored];
        for (const host of previous)
          if (!merged.includes(host)) merged.push(host);
        return merged;
      });
      setEnabled(stored);
    } catch (error) {
      onError(
        `Could not read the allowlist: ${String(
          error?.message ?? error
        )}. This screen may not be showing what the agent is actually allowed to reach.`
      );
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * Write a new allowlist, and tell the truth about whether it took effect.
   *
   * @param {string[]} next
   * @param {string} what for the message shown on failure
   */
  const commit = useCallback(
    async (next, what) => {
      try {
        await saveAllowlist(next);
        setEnabled(next);
        onError(null);
        return true;
      } catch (error) {
        // THE CASE THIS WHOLE COMPONENT IS SHAPED AROUND. The write did not
        // take effect, so the gate is still enforcing the PREVIOUS list, and
        // the user must not be shown the list they asked for.
        onError(
          `${what} did not take effect: ${String(
            error?.message ?? error
          )}. The agent's access is unchanged — what you see below is what is actually stored.`
        );
        await refresh();
        return false;
      }
    },
    [onError, refresh]
  );

  const toggle = useCallback(
    async (host) => {
      const on = enabled.includes(host);
      const next = on
        ? enabled.filter((entry) => entry !== host)
        : [...enabled, host];
      await commit(
        next,
        on ? `Removing ${host} from the allowlist` : `Allowing ${host}`
      );
    },
    [enabled, commit]
  );

  const submitDraft = useCallback(
    async (event) => {
      event.preventDefault();
      const raw = draft.trim();
      // Validated with the GATE'S OWN parser, not a second regex written here.
      // A domain this popup accepts but `isAllowed` cannot parse is a row the
      // user believes they granted and the agent can never use — and a second
      // validator is exactly how the two drift apart.
      const parsed = parseEntry(raw);
      if (!parsed) {
        setDraftError(
          "That is not a domain this extension can match. Enter a hostname such as www.linkedin.com, or *.example.com to include its subdomains."
        );
        return;
      }
      if (entries.includes(raw)) {
        setDraftError("That domain is already on the list.");
        return;
      }
      setDraftError(null);
      // ADDED SWITCHED OFF. Adding a domain and granting access to it are two
      // separate decisions, and the second one should be a deliberate act
      // rather than a side effect of typing a name.
      setEntries((previous) => [...previous, raw]);
      setDraft("");
      setAdding(false);
      onNotice(
        `${raw} was added but is switched OFF. The agent cannot touch it until you turn it on.`
      );
    },
    [draft, entries, onNotice]
  );

  if (loading) return <div className="companion-empty">Loading…</div>;

  return (
    <>
      {entries.length === 0 ? (
        <div className="companion-empty">
          <strong>ยังไม่ได้เปิดโดเมนไหน — agent แตะอะไรไม่ได้</strong>
          Chrome ให้สิทธิ์ส่วนขยายนี้เข้าทุกเว็บที่คุณ login ค้างไว้แล้ว
          รายการนี้คือสิ่งเดียวที่กั้นไว้ การเพิ่มโดเมนคือการ
          <b> ยกสิทธิ์ให้ </b> ไม่ใช่แค่ติ๊กถูก
        </div>
      ) : (
        <div>
          <p className="companion-row-s" style={{ margin: "0 0 4px" }}>
            ปิดหมดตั้งแต่แรก เปิดเองทีละอัน
          </p>
          {/*
            THE COST OF THE ONE-SOURCE-OF-TRUTH DECISION, said out loud on the
            screen rather than only in a source comment.

            What is stored IS the list of allowed hosts, because `allowlist.js`
            has no notion of a disabled entry and a second stored "disabled"
            list would be a second source of truth beside a gate that reads only
            the first. The consequence is that switching a domain off really
            removes it, and closing the popup loses the row.

            A user who does not know that switches a domain off, closes, reopens,
            and finds it gone — on the one screen whose whole job is to be
            legible about what access exists. A review found this stated nowhere
            a user could see it.
          */}
          <p className="companion-row-s" style={{ margin: "0 0 4px" }}>
            โดเมนที่ปิดสวิตช์ไว้จะหายไปจากรายการเมื่อปิดหน้าต่างนี้
            เพราะรายการที่เก็บไว้คือรายการที่<b>อนุญาตแล้ว</b>เท่านั้น
            ถ้าต้องการใช้อีกให้พิมพ์เพิ่มใหม่
          </p>
          {entries.map((host) => {
            const on = enabled.includes(host);
            return (
              <div className="companion-row" key={host}>
                <div>
                  <div className="companion-row-t">{host}</div>
                  <div className="companion-row-s">
                    {on ? "agent กดได้" : "agent แตะไม่ได้"}
                  </div>
                </div>
                <button
                  type="button"
                  className="companion-switch"
                  role="switch"
                  aria-checked={on}
                  aria-label={host}
                  onClick={() => toggle(host)}
                />
              </div>
            );
          })}
        </div>
      )}

      {adding ? (
        <form onSubmit={submitDraft} className="companion-field">
          <label className="companion-label" htmlFor="companion-domain">
            โดเมน
          </label>
          <input
            id="companion-domain"
            className="companion-input"
            value={draft}
            autoFocus
            placeholder="www.linkedin.com"
            onChange={(event) => setDraft(event.target.value)}
          />
          {draftError ? (
            <div className="companion-alert" role="alert">
              {draftError}
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" className="companion-btn solid">
              บันทึก
            </button>
            <button
              type="button"
              className="companion-btn"
              onClick={() => {
                setAdding(false);
                setDraft("");
                setDraftError(null);
              }}
            >
              ยกเลิก
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="companion-btn"
          onClick={() => setAdding(true)}
        >
          + เพิ่มโดเมน
        </button>
      )}
    </>
  );
}
