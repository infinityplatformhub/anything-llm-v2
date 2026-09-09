import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
  record,
  readAll,
  clear,
  STORAGE_KEY,
  MAX_ENTRIES,
  MAX_DETAIL_CHARS,
} from "../src/background/auditLog.js";

// `chrome` is the one thing that genuinely cannot run here — it is the browser,
// not a library. So this fake is written to behave like the real API in the ways
// the code depends on, and the ways it differs are named:
//
//   - get/set/remove are async and resolve on a later microtask, which is what
//     makes read-modify-write interleave in the real service worker. A fake that
//     resolved synchronously would hide the exact race `record` chains against.
//   - values are round-tripped through JSON, because chrome.storage serialises
//     via the structured clone algorithm and does not hand back a live object.
//     Without this, a mutation bug would be invisible.
//
// It does NOT model the quota, so the truncation test asserts the size of what
// is written rather than a quota error being avoided.
function installFakeChrome() {
  const backing = new Map();
  const fake = {
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
        async remove(keys) {
          await null;
          for (const key of [].concat(keys)) backing.delete(key);
        },
      },
    },
  };
  globalThis.chrome = fake;
  return { backing, fake };
}

let backing;
beforeEach(async () => {
  ({ backing } = installFakeChrome());
  // The module holds a write chain across tests; drain it so one test's pending
  // write cannot land inside the next.
  await clear();
  backing.clear();
});

describe("record", () => {
  it("appends an entry carrying the fields an audit needs", async () => {
    await record({ cmd: "page_click", url: "https://linkedin.com/", outcome: "allowed" });
    const [entry] = await readAll();
    expect(entry).toMatchObject({
      cmd: "page_click",
      url: "https://linkedin.com/",
      outcome: "allowed",
      detail: null,
    });
    // A timestamp that does not parse is a log nobody can order.
    expect(Number.isNaN(Date.parse(entry.at))).toBe(false);
  });

  it("records a denial, not only a success", async () => {
    // A run of denials is what a compromised server probing the allowlist looks
    // like from here, so it is the more important of the two to keep.
    await record({
      cmd: "page_navigate",
      url: "https://evil.test/",
      outcome: "denied",
      detail: "not in allowlist",
    });
    expect(await readAll()).toEqual([
      expect.objectContaining({ outcome: "denied", detail: "not in allowlist" }),
    ]);
  });

  it("defaults url and detail so a command without them still records", async () => {
    // page_close takes no arguments, so it has no url to log.
    await record({ cmd: "page_close", outcome: "allowed" });
    expect(await readAll()).toEqual([
      expect.objectContaining({ cmd: "page_close", url: null, detail: null }),
    ]);
  });

  it("keeps entries in the order they happened", async () => {
    await record({ cmd: "a", outcome: "allowed" });
    await record({ cmd: "b", outcome: "allowed" });
    await record({ cmd: "c", outcome: "allowed" });
    expect((await readAll()).map((e) => e.cmd)).toEqual(["a", "b", "c"]);
  });
});

describe("concurrent writes", () => {
  it("loses no entry when commands are recorded without awaiting each one", async () => {
    // The real failure this guards: `record` is read-modify-write over one key,
    // and the service worker interleaves at every await. Fired together and
    // unchained, all ten read the same empty array and nine are overwritten.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => record({ cmd: `cmd${i}`, outcome: "allowed" }))
    );
    const entries = await readAll();
    expect(entries).toHaveLength(10);
    expect(entries.map((e) => e.cmd)).toEqual(
      Array.from({ length: 10 }, (_, i) => `cmd${i}`)
    );
  });

  it("keeps recording after a storage write fails", async () => {
    // One quota error must not poison the chain and silently end all logging.
    const realSet = chrome.storage.local.set;
    chrome.storage.local.set = jest
      .fn()
      .mockRejectedValueOnce(new Error("QUOTA_BYTES quota exceeded"));

    await expect(record({ cmd: "boom", outcome: "allowed" })).rejects.toThrow(
      "QUOTA_BYTES"
    );

    chrome.storage.local.set = realSet;
    await record({ cmd: "after", outcome: "allowed" });
    expect((await readAll()).map((e) => e.cmd)).toEqual(["after"]);
  });
});

describe("bounds", () => {
  it("keeps the newest MAX_ENTRIES and drops the oldest", async () => {
    for (let i = 0; i < MAX_ENTRIES + 5; i += 1) {
      await record({ cmd: `cmd${i}`, outcome: "allowed" });
    }
    const entries = await readAll();
    expect(entries).toHaveLength(MAX_ENTRIES);
    expect(entries[0].cmd).toBe("cmd5");
    expect(entries.at(-1).cmd).toBe(`cmd${MAX_ENTRIES + 4}`);
  });

  it("truncates an oversized detail so one entry cannot crowd out the history", async () => {
    // `detail` can carry page-derived text, which is attacker-influenced and of
    // no fixed size; unbounded it would eat the whole extension quota.
    await record({ cmd: "page_read", outcome: "allowed", detail: "x".repeat(50_000) });
    const [entry] = await readAll();
    expect(entry.detail.length).toBeLessThan(MAX_DETAIL_CHARS + 100);
    expect(entry.detail).toMatch(/\[truncated\]$/);
  });

  it("leaves a detail under the cap untouched", async () => {
    // Negative control: a truncator that truncated everything would pass the
    // test above while destroying every useful log line.
    await record({ cmd: "page_read", outcome: "allowed", detail: "short reason" });
    expect((await readAll())[0].detail).toBe("short reason");
  });

  it("serialises a non-string detail rather than storing [object Object]", async () => {
    await record({ cmd: "page_type", outcome: "denied", detail: { code: 42 } });
    expect((await readAll())[0].detail).toBe('{"code":42}');
  });
});

describe("readAll and clear", () => {
  it("returns an empty array when nothing has been recorded", async () => {
    expect(await readAll()).toEqual([]);
  });

  it("returns an empty array when storage holds a non-array", async () => {
    backing.set(STORAGE_KEY, JSON.stringify({ not: "an array" }));
    expect(await readAll()).toEqual([]);
  });

  it("empties the log", async () => {
    await record({ cmd: "page_click", outcome: "allowed" });
    await clear();
    expect(await readAll()).toEqual([]);
  });

  it("is not overtaken by a write that was already in flight", async () => {
    // Without queueing, the pending record resolves after the remove and one
    // entry survives a clear the user asked for.
    const pending = record({ cmd: "inflight", outcome: "allowed" });
    await clear();
    await pending;
    expect(await readAll()).toEqual([]);
  });
});

describe("storage key", () => {
  it("names the key the popup reads the log from", () => {
    expect(STORAGE_KEY).toBe("companionAuditLog");
  });

  it("does not share a key with the allowlist", async () => {
    const { STORAGE_KEY: allowlistKey } = await import(
      "../src/background/allowlist.js"
    );
    // A collision would have the audit log overwrite the user's allowlist —
    // which fails open in the sense that matters: the list becomes junk.
    expect(STORAGE_KEY).not.toBe(allowlistKey);
  });
});
