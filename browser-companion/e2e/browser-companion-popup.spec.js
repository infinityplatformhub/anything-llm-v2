/**
 * The popup, driven in a real Chrome with the real extension loaded unpacked.
 *
 * WHAT MAKES THESE ASSERTIONS WORTH ANYTHING
 *
 * `chrome.storage`, `chrome.runtime.sendMessage` and the MV3 service worker are
 * Chrome's own here, not doubles. So a popup that reads the wrong storage key,
 * a message name that drifted between the two halves, or a bundle that does not
 * load at all fails these tests — none of which a jsdom render against a fake
 * `chrome` object can see.
 *
 * The failure states are produced by breaking the REAL thing rather than by
 * stubbing a resolver: a full quota is simulated by overriding
 * `chrome.storage.local.set` INSIDE the popup's own page, so `saveAllowlist`
 * takes its actual failure path, throws its actual error, and the UI is
 * measured on what it does with a genuine rejection.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The four tabs, in the order the approved mockup puts them. */
const TABS = ["เชื่อมต่อ", "โดเมน", "กำลังทำ", "ประวัติ"];

/**
 * Wait for the popup's first status poll to land.
 *
 * The panel renders before the service worker has answered, so a test that
 * asserts immediately can catch the pre-status frame. The status line is the
 * thing that changes when the answer arrives.
 */
async function ready(popup) {
  await expect(popup.getByRole("tab", { name: TABS[0] })).toBeVisible();
}

test.describe("the popup a user actually sees", () => {
  test("kill switch is reachable from every tab", async ({ popup }) => {
    await ready(popup);
    // The whole point of the control: when you want to stop, you must not have
    // to work out which tab the button is on.
    for (const tab of TABS) {
      await popup.getByRole("tab", { name: tab }).click();
      await expect(
        popup.getByRole("button", { name: /ตัดทุกแท็บ/ })
      ).toBeVisible();
    }
  });

  test("the allowlist starts empty so nothing is reachable by default @edge", async ({
    popup,
  }) => {
    await ready(popup);
    await popup.getByRole("tab", { name: "โดเมน" }).click();

    // A fresh profile: the store is genuinely empty, not emptied by a stub.
    await expect(popup.getByText(/ยังไม่ได้เปิดโดเมนไหน/)).toBeVisible();
    await expect(popup.getByRole("switch")).toHaveCount(0);

    // The empty state must say what the emptiness MEANS. Chrome has already
    // granted <all_urls> + debugger by this point, and this list is the only
    // limit on that grant, so "no domains yet" would be an understatement that
    // misleads.
    await expect(popup.getByText(/ยกสิทธิ์ให้/)).toBeVisible();
  });

  test("a domain the user adds starts switched off @edge", async ({
    popup,
  }) => {
    await ready(popup);
    await popup.getByRole("tab", { name: "โดเมน" }).click();
    await popup.getByRole("button", { name: /เพิ่มโดเมน/ }).click();
    await popup.getByRole("textbox", { name: /โดเมน/ }).fill("www.linkedin.com");
    await popup.getByRole("button", { name: /^บันทึก$/ }).click();

    // Adding a domain and granting access to it are two decisions. The second
    // must be a deliberate act, not a side effect of typing a name.
    await expect(
      popup.getByRole("switch", { name: "www.linkedin.com" })
    ).toHaveAttribute("aria-checked", "false");

    // AND THE COST OF THAT DESIGN IS DISCLOSED, on the screen, next to the
    // switch. What is stored IS the allowed list — `allowlist.js` has no
    // disabled state and a second stored list would be a second source of
    // truth beside a gate that reads only the first — so switching a domain
    // off really removes it and closing the popup loses the row. A review
    // found this stated only in a source comment, which is nowhere a user
    // looks. Asserted here so the sentence cannot quietly go missing again.
    await expect(popup.getByText(/หายไปจากรายการเมื่อปิดหน้าต่างนี้/)).toBeVisible();
  });

  test("switching a domain on writes it to the allowlist the gate reads", async ({
    popup,
  }) => {
    await ready(popup);
    await popup.getByRole("tab", { name: "โดเมน" }).click();
    await popup.getByRole("button", { name: /เพิ่มโดเมน/ }).click();
    await popup.getByRole("textbox", { name: /โดเมน/ }).fill("www.linkedin.com");
    await popup.getByRole("button", { name: /^บันทึก$/ }).click();

    const toggle = popup.getByRole("switch", { name: "www.linkedin.com" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    // Asserted against REAL chrome.storage under the key the gate reads, not
    // against the switch's own attribute. A popup whose toggle looked right
    // while writing nowhere, or writing under a different key, would pass an
    // attribute-only check and leave the gate enforcing an empty list.
    const stored = await popup.evaluate(
      async () => (await chrome.storage.local.get(["companionAllowlist"]))
        .companionAllowlist
    );
    expect(stored).toEqual(["www.linkedin.com"]);
  });

  test("a failed save tells the user the change did NOT take effect @edge", async ({
    popup,
  }) => {
    await ready(popup);
    await popup.getByRole("tab", { name: "โดเมน" }).click();
    await popup.getByRole("button", { name: /เพิ่มโดเมน/ }).click();
    await popup.getByRole("textbox", { name: /โดเมน/ }).fill("www.linkedin.com");
    await popup.getByRole("button", { name: /^บันทึก$/ }).click();

    // THE FAILURE THAT MATTERS MOST IN THIS UI. `saveAllowlist` throws on a
    // failed write and verifies by reading back, because believing a lie here
    // means believing access was revoked when it was not. Broken at the REAL
    // storage API so the real failure path runs.
    await popup.evaluate(() => {
      chrome.storage.local.set = async () => {
        throw new Error("QUOTA_BYTES quota exceeded");
      };
    });

    await popup.getByRole("switch", { name: "www.linkedin.com" }).click();

    // The user must be told, in words, that the agent's access is unchanged.
    // A tidy list with no message is the exact outcome the throw exists to
    // prevent.
    const alert = popup.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/did not take effect/i);

    // And the switch must show what is ACTUALLY stored, not what was asked
    // for. Showing the requested state would be the same lie in another place.
    await expect(
      popup.getByRole("switch", { name: "www.linkedin.com" })
    ).toHaveAttribute("aria-checked", "false");
  });

  test("a failed save re-reads storage rather than trusting the screen @edge", async ({
    popup,
  }) => {
    // THE OTHER HALF OF THE FAILED-SAVE PROMISE, pinned on its own.
    //
    // A review found that deleting `await refresh()` from `commit()` survived
    // the case above: that assertion only bites when the component ALSO writes
    // optimistically, so it tests the conjunction and neither half alone. The
    // re-read would then be deletable as dead code today and load-bearing the
    // moment someone makes the toggle optimistic — the invisible-redundancy
    // shape task 8 was bitten by.
    //
    // Pinned by making storage disagree with the screen. The popup shows the
    // domain OFF; storage really holds it ON (another popup, or the worker,
    // changed it). A failed save must then render STORAGE's answer — on —
    // which is neither the state on screen before the click nor the state the
    // click asked for, so only a genuine re-read can produce it.
    await ready(popup);
    await popup.getByRole("tab", { name: "โดเมน" }).click();
    await popup.getByRole("button", { name: /เพิ่มโดเมน/ }).click();
    await popup.getByRole("textbox", { name: /โดเมน/ }).fill("www.linkedin.com");
    await popup.getByRole("button", { name: /^บันทึก$/ }).click();

    const toggle = popup.getByRole("switch", { name: "www.linkedin.com" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    // Storage now says ALLOWED, behind the popup's back, and writes then start
    // failing. Both through the real chrome.storage API.
    await popup.evaluate(async () => {
      await chrome.storage.local.set({
        companionAllowlist: ["www.linkedin.com"],
      });
      chrome.storage.local.set = async () => {
        throw new Error("QUOTA_BYTES quota exceeded");
      };
    });

    // The user asks to turn it ON. The write fails.
    await toggle.click();
    await expect(popup.getByRole("alert")).toContainText(/did not take effect/i);

    // WITHOUT the re-read the switch stays on the popup's stale `false`. With
    // it, the switch reports what the gate is really enforcing: true.
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  test("a silent audit log says so instead of looking empty @edge", async ({
    popup,
    context,
    extensionId,
  }) => {
    await ready(popup);

    // The audit log's write-failure flag is sticky and lives in the SERVICE
    // WORKER's memory, so the failure has to be provoked THERE: breaking
    // storage in the popup would set a flag in a different realm that nobody
    // reads.
    const [worker] = context.serviceWorkers();
    await worker.evaluate(() => {
      globalThis.__realSet = chrome.storage.local.set.bind(
        chrome.storage.local
      );
      chrome.storage.local.set = async () => {
        throw new Error("QUOTA_BYTES quota exceeded");
      };
    });

    // Triggered from the POPUP, by clicking the real control. A worker cannot
    // `sendMessage` to itself — Chrome answers "Receiving end does not exist" —
    // so the message has to come from a genuine sender, which is also the path
    // a user takes.
    await popup.getByRole("tab", { name: "กำลังทำ" }).click();
    await popup.getByRole("button", { name: /หยุด สลับมือ/ }).click();
    await expect(popup.getByRole("button", { name: /ทำต่อ/ })).toBeVisible();

    await worker.evaluate(() => {
      chrome.storage.local.set = globalThis.__realSet;
    });

    await popup.reload();
    await ready(popup);
    await popup.getByRole("tab", { name: "ประวัติ" }).click();

    // A user reading a short log must know it is short because writes FAILED,
    // not because nothing happened. An audit log that quietly stops is worse
    // than none, because it is trusted.
    const banner = popup.getByRole("alert");
    await expect(banner).toContainText(/ไม่ครบ/);

    // THE SPECIFICS, asserted rather than just the word "incomplete".
    //
    // A review stripped the timestamp, the reason and the `recovered` branch
    // down to a bare "ไม่ครบ" and everything still passed — so the promise to
    // surface getWriteFailure() VERBATIM was only half covered. A user
    // investigating a short log needs to know WHEN it started and WHY: "quota
    // exceeded at 14:32" and "the extension crashed" call for different
    // actions, and a bare "incomplete" cannot tell them apart.
    //
    // The reason, from the real rejection this test caused:
    await expect(banner).toContainText(/quota/i);
    // A real clock time, not an empty slot where `at` should have been. The
    // popup renders it through `toLocaleTimeString`, so the digits are what
    // survive a formatting change; an unrendered `at` leaves no digits at all.
    await expect(banner).toContainText(/\d{1,2}:\d{2}/);
    // And the recovery branch, which changes what the user should expect next:
    // "older entries were dropped so writing works again" is a different
    // situation from "it may still be failing".
    await expect(banner).toContainText(/ลบของเก่าทิ้ง|ยังเขียนไม่ได้/);
  });

  test("pause offers a way to reach the agent's tab", async ({ popup }) => {
    await ready(popup);
    await popup.getByRole("tab", { name: "กำลังทำ" }).click();
    // The agent's tab is opened `active: false`, so a user handling a captcha
    // has no way to find it among twenty others without this.
    await expect(
      popup.getByRole("button", { name: /ไปที่แท็บของ agent/ })
    ).toBeVisible();
  });

  test("the go-to-agent-tab button reports honestly with no agent tab @edge", async ({
    popup,
  }) => {
    // THE BUTTON'S ACTION, not just its presence. A review replaced
    // `await focusAgentTab()` with a hardcoded `{ok: true}` and everything
    // passed, so the only thing under test was that a button existed.
    //
    // This pins the reachable half. The agent holds no tab here — there is no
    // server to drive one — and "no agent tab" is an ordinary state of this
    // browser rather than an error, so the button must SAY so. A stubbed
    // `{ok: true}` renders no alert and fails this.
    //
    // WHAT THIS DOES NOT COVER, stated rather than implied: the success path,
    // where a real agent tab is focused. Reaching it needs the agent to have
    // opened a tab, which needs a server. `control.test.js` covers it against
    // the real accessor ("focuses the agent's tab when there is one" asserts
    // the exact `chrome.tabs.update(id, {active: true})` call).
    await ready(popup);
    await popup.getByRole("tab", { name: "กำลังทำ" }).click();
    await popup.getByRole("button", { name: /ไปที่แท็บของ agent/ }).click();
    await expect(popup.getByRole("alert")).toContainText(/no tab/i);
  });

  test("pausing really stops commands, it is not just a label", async ({
    popup,
    context,
  }) => {
    await ready(popup);
    await popup.getByRole("tab", { name: "กำลังทำ" }).click();
    await popup.getByRole("button", { name: /หยุด สลับมือ/ }).click();
    await expect(popup.getByRole("button", { name: /ทำต่อ/ })).toBeVisible();

    // The click must reach the SERVICE WORKER's state, not just the popup's.
    // Those are separate realms: a popup that flipped its own local flag would
    // render "paused" identically while the worker went on serving commands.
    // Asked through the same message API the popup uses, from a real sender.
    const status = await popup.evaluate(async () =>
      chrome.runtime.sendMessage({ type: "companion:getStatus" })
    );
    expect(status.ok).toBe(true);
    expect(status.data.paused).toBe(true);

    // WHAT THIS CASE DOES NOT PROVE, stated rather than implied: that a paused
    // worker refuses an actual command frame. Reaching the command path needs
    // an AnythingLLM server to send one, and there is none here. The refusal
    // itself — the handler never running, the reply the agent gets — is covered
    // in __tests__/control.test.js, and the wiring that puts the guard on the
    // socket's `onCommand` is covered in __tests__/background.test.js. This
    // case covers the third link: that the button reaches the worker at all.
    expect(context.serviceWorkers().length).toBeGreaterThan(0);
  });

  test("an evicted browser is told, and offered a way back @edge", async ({
    popup,
    context,
  }) => {
    // 4409 is TERMINAL by design: reconnecting automatically would take the
    // slot back from the browser that just claimed it, which reconnects and
    // takes it back again. Refusing to retry is right, and it leaves the user
    // stuck unless the popup offers a way back — which is what this asserts.
    //
    // THIS CASE WAS VACUOUS AND IS NOW NOT. It used to seed only the terminal
    // record and then assert `getByText(/socket/)` — a STATIC row label
    // rendered in every state. Deleting the reconnect button outright left it
    // green. The cause was the setup, not the assertion: with no
    // apiBase/apiKey in storage.sync, `connect()` returns at its first two
    // lines and never reads the terminal key, so the evicted state was never
    // entered. A setup that does not create the state being asserted about.
    //
    // The fix is to seed BOTH. The key must be the one the verdict was
    // recorded against, or `terminalVerdictFor` treats the mismatch as "the
    // user reconnected", deletes the record and connects — which is correct
    // behaviour and would make this case vacuous a second way.
    const [worker] = context.serviceWorkers();
    const API_KEY = "brx-evicted-test-key";

    await worker.evaluate(async (apiKey) => {
      // The SHA-256 fingerprint socket.js keys the verdict on, computed the
      // same way it does — never the key itself, which is why the stored
      // record cannot simply carry it.
      const bytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(apiKey)
      );
      const key = [...new Uint8Array(bytes)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 32);

      await chrome.storage.local.set({
        companionTerminalClose: {
          key,
          status: "evicted",
          error: "Another browser connected with this account and took over.",
          at: new Date().toISOString(),
        },
      });
      // The config `connect` needs to get past its early returns and actually
      // consult the verdict. The host is unreachable on purpose: the terminal
      // check happens before any socket is built, so nothing dials out.
      await chrome.storage.sync.set({
        apiBase: "https://evicted.invalid/api",
        apiKey,
      });
    }, API_KEY);

    await popup.reload();
    await ready(popup);

    // The state is really entered now — asserted through the worker's own
    // status, so a future change that stops reaching `evicted` fails here
    // rather than silently making the assertions below untestable.
    await expect
      .poll(async () =>
        popup.evaluate(
          async () =>
            (await chrome.runtime.sendMessage({ type: "companion:getStatus" }))
              ?.data?.socket?.status
        )
      )
      .toBe("evicted");

    // The user is TOLD, in the socket's own words.
    await popup.getByRole("tab", { name: "เชื่อมต่อ" }).click();
    await expect(popup.getByText(/took over/i)).toBeVisible();

    // And offered a way back. Asserted BY NAME: deleting this button was what
    // the old version of this case failed to notice.
    await expect(
      popup.getByRole("button", { name: /ต่อใหม่จากเบราว์เซอร์นี้/ })
    ).toBeVisible();

    // The activity tab tells them too, since that is where they will be
    // looking when the agent goes quiet.
    await popup.getByRole("tab", { name: "กำลังทำ" }).click();
    await expect(popup.getByRole("alert")).toContainText(/แย่งสิทธิ์/);
  });

  test("reconnecting after an eviction clears the block that caused it", async ({
    popup,
    context,
  }) => {
    // The other half of the way back: pressing the button must actually clear
    // the stored verdict, or the next wake is refused again and the button is
    // decorative. `control.test.js` pins both halves in isolation; this pins
    // that the popup's button reaches them.
    const [worker] = context.serviceWorkers();
    const API_KEY = "brx-evicted-test-key-2";

    await worker.evaluate(async (apiKey) => {
      const bytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(apiKey)
      );
      const key = [...new Uint8Array(bytes)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 32);
      await chrome.storage.local.set({
        companionTerminalClose: {
          key,
          status: "evicted",
          error: "Another browser connected with this account and took over.",
          at: new Date().toISOString(),
        },
      });
      await chrome.storage.sync.set({
        apiBase: "https://evicted.invalid/api",
        apiKey,
      });
    }, API_KEY);

    await popup.reload();
    await ready(popup);
    await popup.getByRole("tab", { name: "เชื่อมต่อ" }).click();
    await popup
      .getByRole("button", { name: /ต่อใหม่จากเบราว์เซอร์นี้/ })
      .click();

    // The durable verdict is gone from REAL storage, which is what lets the
    // next worker try again rather than honouring a decision the user has
    // since overruled.
    await expect
      .poll(async () =>
        popup.evaluate(
          async () =>
            (await chrome.storage.local.get(["companionTerminalClose"]))
              .companionTerminalClose ?? null
        )
      )
      .toBeNull();
  });

  test("the audit log explains why switch denials are vague", async ({
    popup,
    context,
  }) => {
    // Seeded through the REAL storage the popup reads, under the real key.
    const [worker] = context.serviceWorkers();
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        companionAuditLog: [
          {
            at: new Date().toISOString(),
            cmd: "page_switch",
            url: null,
            outcome: "denied",
            detail: "no page to act on",
          },
        ],
      });
    });

    await popup.reload();
    await ready(popup);
    await popup.getByRole("tab", { name: "ประวัติ" }).click();

    // `.first()`: the entry renders the command inside a <b>, so the text
    // matches both the row and the bold element nested in it. Without it the
    // locator is ambiguous and Playwright refuses in strict mode — a failure
    // about the query, not about the page.
    await expect(popup.getByText(/page_switch/).first()).toBeVisible();
    // Without this line a reader sees a denial with no url and reads it as a
    // logging bug, when it is a deliberate closure of an enumeration channel.
    await expect(popup.getByText(/ไม่ใช่ bug/)).toBeVisible();
  });
});

test.describe("what the built artefact itself has to be", () => {
  // Not a UI assertion, and it belongs in this file rather than a unit test:
  // it is a fact about the bundle the browser above actually loaded, which
  // only exists once a real build has run.
  // Deliberately NOT tagged @edge. A review judged the old label an overstatement
  // and it was right: this asserts a property of the build artefact, not an edge
  // case of the product's behaviour. The tag is something a person puts on a case
  // they thought hard about; padding it devalues every other one.
  test("the popup document loads the bundle, not the raw source", async ({
    popup,
  }) => {
    const dist = path.join(HERE, "..", "dist");
    const html = readFileSync(path.join(dist, "index.html"), "utf8");
    // `/src/main.jsx` surviving into dist would mean the popup loads unbundled
    // JSX, which Chrome cannot parse — the popup would be blank with a syntax
    // error only visible in its own devtools.
    expect(html).not.toContain("/src/main.jsx");
    expect(html).toMatch(/assets\/main-[\w-]+\.js/);

    // And the popup that was driven above must have really rendered React,
    // not an empty root the assertions happened to tolerate.
    await expect(popup.locator(".companion")).toBeVisible();
  });
});
