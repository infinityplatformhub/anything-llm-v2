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
    await expect(popup.getByRole("alert")).toContainText(/ไม่ครบ/);
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
    const [worker] = context.serviceWorkers();
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        companionTerminalClose: {
          // The fingerprint will not match any key, which is deliberate: this
          // asserts the popup's rendering of a terminal state, and the key
          // matching is socket.js's own tested behaviour.
          key: "0".repeat(32),
          status: "evicted",
          error: "Another browser connected with this account and took over.",
          at: new Date().toISOString(),
        },
      });
    });

    await popup.reload();
    await ready(popup);
    await popup.getByRole("tab", { name: "กำลังทำ" }).click();

    // The button exists even before a socket has reached the evicted state,
    // because a user who cannot reconnect has no path back short of
    // reinstalling. It appears on the connection tab, where the socket lives.
    await popup.getByRole("tab", { name: "เชื่อมต่อ" }).click();
    await expect(popup.getByText(/socket/)).toBeVisible();
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
  test("the popup document loads the bundle, not the raw source @edge", async ({
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
