import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
  loadAllowlist,
  saveAllowlist,
  isAllowed,
  STORAGE_KEY,
} from "../src/background/allowlist.js";
import { record, STORAGE_KEY as AUDIT_KEY } from "../src/background/auditLog.js";

// Separate file from allowlist.test.js on purpose: the matcher tests must stay a
// pure-function suite with no `chrome` in scope, so that a global installed here
// can never be what makes them pass.
//
// The fake round-trips through JSON because chrome.storage serialises via
// structured clone and hands back a copy, and resolves on a later microtask
// because the real API is async.
//
// `quotaBytes` budgets the WHOLE storage area rather than one key — which is how
// the real quota works, and which is what makes the audit log and the allowlist
// able to starve each other. The previous fake charged only the audit-log key
// and so could not express that at all.
//
// WHAT IT STILL DOES NOT MODEL: exact byte accounting (it counts the JSON text,
// where Chrome also counts key names and internal overhead), other extension
// data outside these two keys, and eviction. Sizes here are indicative.
let backing;
function installChrome({ quotaBytes = Infinity } = {}) {
  backing = new Map();
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          await null;
          const out = {};
          for (const key of [].concat(keys)) {
            if (backing.has(key)) out[key] = JSON.parse(backing.get(key));
          }
          return out;
        },
        async set(items) {
          await null;
          const pending = new Map(backing);
          for (const [key, value] of Object.entries(items)) {
            pending.set(key, JSON.stringify(value));
          }
          let total = 0;
          for (const [key, value] of pending) total += key.length + value.length;
          if (total > quotaBytes) {
            throw new Error(
              "QUOTA_BYTES quota exceeded. Failed to set the value."
            );
          }
          backing = pending;
        },
        async remove(keys) {
          await null;
          for (const key of [].concat(keys)) backing.delete(key);
        },
      },
    },
  };
}

beforeEach(() => {
  installChrome();
});

describe("loadAllowlist", () => {
  it("returns an empty list when storage has never been written", async () => {
    // The fresh-install path. `isAllowed` reads [] as allow-nothing, so this is
    // the value the whole default-deny promise rests on.
    expect(await loadAllowlist()).toEqual([]);
  });

  it("returns the stored list", async () => {
    backing.set(STORAGE_KEY, JSON.stringify(["linkedin.com", "*.flowaccount.com"]));
    expect(await loadAllowlist()).toEqual(["linkedin.com", "*.flowaccount.com"]);
  });

  it.each([
    ["null", null],
    ["a string", "linkedin.com"],
    ["an object", { "linkedin.com": true }],
    ["a number", 7],
    ["a boolean", true],
  ])("returns [] when storage holds %s instead of an array", async (_label, value) => {
    // Corrupt or foreign storage must fail closed, not be handed to the matcher
    // as something it will try to iterate.
    backing.set(STORAGE_KEY, JSON.stringify(value));
    const list = await loadAllowlist();
    expect(list).toEqual([]);
    expect(isAllowed("https://linkedin.com/", list)).toBe(false);
  });

  it("reads only its own key", async () => {
    backing.set("companionAuditLog", JSON.stringify(["evil.test"]));
    expect(await loadAllowlist()).toEqual([]);
  });
});

describe("saveAllowlist", () => {
  it("round-trips a list through storage", async () => {
    await saveAllowlist(["linkedin.com"]);
    expect(await loadAllowlist()).toEqual(["linkedin.com"]);
  });

  it("persists a list the matcher then honours", async () => {
    // End-to-end over the two halves: what the popup saves is what the gate
    // enforces, including that an unlisted host stays denied.
    await saveAllowlist(["*.flowaccount.com"]);
    const list = await loadAllowlist();
    expect(isAllowed("https://app.flowaccount.com/x", list)).toBe(true);
    expect(isAllowed("https://flowaccount.com.evil.test/", list)).toBe(false);
  });

  it("replaces rather than merges, so removing an entry really removes it", async () => {
    await saveAllowlist(["linkedin.com", "evil.test"]);
    await saveAllowlist(["linkedin.com"]);
    const list = await loadAllowlist();
    expect(list).toEqual(["linkedin.com"]);
    expect(isAllowed("https://evil.test/", list)).toBe(false);
  });

  it("saving an empty list denies everything again", async () => {
    await saveAllowlist(["linkedin.com"]);
    await saveAllowlist([]);
    expect(isAllowed("https://linkedin.com/", await loadAllowlist())).toBe(false);
  });

  it("rejects a non-array rather than storing something isAllowed ignores", async () => {
    // `loadAllowlist` treats a non-array as absent, so storing one would empty
    // the gate while the caller believed it had saved a list.
    await expect(saveAllowlist("linkedin.com")).rejects.toThrow(TypeError);
    await expect(saveAllowlist(null)).rejects.toThrow(TypeError);
  });
});

describe("a failed save must never look like a successful revocation", () => {
  // The quota covers the whole extension, so a full store can make an allowlist
  // write fail while nothing else looks wrong.
  //
  // MEASURED, and it narrows the threat: a pure REMOVAL shrinks the stored JSON,
  // so if the current list fits then the shorter one fits too. At literally zero
  // headroom a revocation still succeeded. The quota therefore cannot produce
  // the "I removed it but it is still live" case on its own — that direction is
  // reachable only through a failure that is not about size (see below) or an
  // edit that removes one entry and adds a longer one.
  //
  // The protection is still required, because those paths exist and because a
  // `set` that resolves is not proof the value landed. What changes is the
  // claim: this is not "quota silently un-revokes domains", it is "no storage
  // failure of any kind may be mistaken for a successful save".
  let errorSpy;
  beforeEach(() => {
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  /**
   * Consume the shared area with data this module does not control.
   *
   * NOT by flooding the audit log, and that is worth recording: `record`'s
   * recovery path SHRINKS the log when a write fails, which frees the space
   * again — measured, the area went back to 2225/4000 and the revocation then
   * succeeded. So the audit log cannot durably starve the allowlist, which is a
   * real (and unplanned) benefit of the recovery design.
   *
   * The exposure is the quota being extension-wide: the server URL, the API key
   * and anything a later task stores share it, and none of that self-shrinks.
   * A third key is the honest model of that.
   */
  async function fillAreaWithOtherData() {
    // Grown by measurement, not by a size formula. Computing padding from a
    // budget constant means reproducing the fake's accounting (key names, JSON
    // quoting) inside the test; get it slightly wrong and the SETUP throws,
    // which is what happened on the first attempt. Doubling until it no longer
    // fits, then stepping up one byte at a time, is arithmetic-free and cannot
    // drift from the fake.
    let size = 64;
    let last = 0;
    for (;;) {
      try {
        await chrome.storage.local.set({ otherData: "x".repeat(size) });
        last = size;
        size *= 2;
      } catch {
        break;
      }
    }
    for (let extra = 1; ; extra += 1) {
      try {
        await chrome.storage.local.set({ otherData: "x".repeat(last + extra) });
      } catch {
        return;
      }
    }
  }

  it("a pure removal still succeeds in a full store, because it shrinks", async () => {
    // Recorded as measured behaviour, not assumed. This is what narrows the
    // finding: the most safety-critical operation is also the one the quota
    // cannot block.
    installChrome({ quotaBytes: 4000 });
    await saveAllowlist(["linkedin.com", "flowaccount.com"]);
    await fillAreaWithOtherData();

    await expect(saveAllowlist(["linkedin.com"])).resolves.toBeUndefined();
    const stored = await loadAllowlist();
    expect(stored).toEqual(["linkedin.com"]);
    expect(isAllowed("https://flowaccount.com/", stored)).toBe(false);
  });

  it("throws when an edit that GROWS the list cannot fit", async () => {
    // The reachable quota case: swapping an entry for a longer one, or adding.
    // Fails closed for the gate (the old list stays in force) but the caller
    // must still be told, or the user believes their change took effect.
    installChrome({ quotaBytes: 4000 });
    await saveAllowlist(["linkedin.com"]);
    await fillAreaWithOtherData();

    await expect(
      saveAllowlist(["linkedin.com", "a-much-longer-domain.example.test"])
    ).rejects.toThrow(/allowlist not saved/);
  });

  it("reports a failed save on the console too", async () => {
    installChrome({ quotaBytes: 4000 });
    await saveAllowlist(["linkedin.com"]);
    await fillAreaWithOtherData();
    await expect(
      saveAllowlist(["linkedin.com", "a-much-longer-domain.example.test"])
    ).rejects.toThrow();

    // Needs no storage of its own, so it works when the store is the problem.
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(
      /failed to save the allowlist/i
    );
  });

  it("leaves the gate honouring the list that is actually stored", async () => {
    installChrome({ quotaBytes: 4000 });
    await saveAllowlist(["linkedin.com"]);
    await fillAreaWithOtherData();
    await saveAllowlist([
      "linkedin.com",
      "a-much-longer-domain.example.test",
    ]).catch(() => {});

    // Whatever the caller believes, the gate reports the truth: the new domain
    // was never authorised. A caller that surfaces the throw can say so.
    const stored = await loadAllowlist();
    expect(stored).toEqual(["linkedin.com"]);
    expect(isAllowed("https://a-much-longer-domain.example.test/", stored)).toBe(
      false
    );
  });

  it("throws when the stored list is the same LENGTH but different", async () => {
    // A length-only read-back would pass this. It is the realistic shape of a
    // botched edit — swapping one domain for another keeps the count identical,
    // and is exactly a revocation paired with an addition.
    installChrome();
    await saveAllowlist(["linkedin.com", "flowaccount.com"]);
    chrome.storage.local.set = jest.fn().mockResolvedValue(undefined);

    await expect(
      saveAllowlist(["linkedin.com", "docs.google.com"])
    ).rejects.toThrow(/did not retain/);
  });

  it("throws when the write resolves but the value did not land", async () => {
    // A `set` that resolves is not proof the value was retained. This is the
    // one write where believing a lie means believing access was revoked.
    installChrome();
    await saveAllowlist(["linkedin.com", "evil.test"]);
    chrome.storage.local.set = jest.fn().mockResolvedValue(undefined);

    await expect(saveAllowlist(["linkedin.com"])).rejects.toThrow(
      /did not retain/
    );
  });

  it("still succeeds silently when there is room", async () => {
    // Negative control for this whole block. A saveAllowlist that always threw
    // would pass every test above while making the popup unusable.
    installChrome({ quotaBytes: 100_000 });
    await expect(saveAllowlist(["linkedin.com"])).resolves.toBeUndefined();
    expect(await loadAllowlist()).toEqual(["linkedin.com"]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("budgets the whole area, not one key — the premise of this block", async () => {
    // If the fake budgeted per key, an unrelated key could never block an
    // allowlist write and every test above would be theatre.
    installChrome({ quotaBytes: 4000 });
    await saveAllowlist(["linkedin.com"]);
    await fillAreaWithOtherData();
    // The allowlist itself is untouched; it is the WRITE that is now blocked.
    expect(await loadAllowlist()).toEqual(["linkedin.com"]);
    await expect(
      saveAllowlist(["linkedin.com", "another-domain.example.test"])
    ).rejects.toThrow();
  });

  it("the audit log cannot durably starve the allowlist, because it shrinks", async () => {
    // Recorded as behaviour rather than left as an assumption: `record`'s
    // recovery frees the space it just failed to use, so a hostile server
    // flooding the LOG does not leave the gate unchangeable. This is why the
    // tests above use a third key instead — the exposure is other data, not the
    // audit log.
    installChrome({ quotaBytes: 4000 });
    await saveAllowlist(["linkedin.com", "flowaccount.com"]);
    for (let i = 0; i < 500; i += 1) {
      try {
        await record({
          cmd: "page_click",
          url: `https://evil.test/${"p".repeat(200)}/${i}`,
          outcome: "denied",
        });
      } catch {
        break;
      }
    }
    expect(JSON.parse(backing.get(AUDIT_KEY)).length).toBeGreaterThan(0);
    // The revocation still goes through.
    await expect(saveAllowlist(["linkedin.com"])).resolves.toBeUndefined();
    expect(await loadAllowlist()).toEqual(["linkedin.com"]);
  });
});
