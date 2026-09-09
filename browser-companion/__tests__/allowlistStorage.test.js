import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  loadAllowlist,
  saveAllowlist,
  isAllowed,
  STORAGE_KEY,
} from "../src/background/allowlist.js";

// Separate file from allowlist.test.js on purpose: the matcher tests must stay a
// pure-function suite with no `chrome` in scope, so that a global installed here
// can never be what makes them pass.
//
// The fake round-trips through JSON because chrome.storage serialises via
// structured clone and hands back a copy, and resolves on a later microtask
// because the real API is async. It does not model the quota.
let backing;
beforeEach(() => {
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
          for (const [key, value] of Object.entries(items)) {
            backing.set(key, JSON.stringify(value));
          }
        },
      },
    },
  };
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
});
