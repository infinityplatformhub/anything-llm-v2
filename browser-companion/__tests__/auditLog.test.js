import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
  record,
  readAll,
  clear,
  getWriteFailure,
  resetWriteFailure,
  STORAGE_KEY,
  MAX_ENTRIES,
  MAX_DETAIL_BYTES,
  MAX_URL_BYTES,
  MAX_LABEL_BYTES,
  RECOVERY_ENTRIES,
} from "../src/background/auditLog.js";

// `chrome` is the one thing that genuinely cannot run here — it is the browser,
// not a library. So this fake behaves like the real API in the ways the code
// depends on, and the ways it still differs are named:
//
//   - get/set/remove are async and resolve on a later microtask, which is what
//     makes read-modify-write interleave in the real service worker. A fake that
//     resolved synchronously would hide the exact race `record` chains against.
//   - values are round-tripped through JSON, because chrome.storage serialises
//     via the structured clone algorithm and does not hand back a live object.
//     Without this, a mutation bug would be invisible.
//   - `quotaBytes` models the ONE property of the real quota the code reacts to:
//     a `set` whose stored value would exceed the budget rejects, with a message
//     matching Chrome's. That makes the quota path executable rather than
//     asserted.
//
// WHAT THE QUOTA FAKE STILL DOES NOT MODEL — it is itself a double, and these
// gaps are why it must not be read as proof the extension is quota-safe:
//   - Chrome budgets the WHOLE extension's storage, across every key and every
//     other part of the extension. This fake charges only this module's key, so
//     it cannot show the audit log being starved by someone else's data.
//   - Real byte accounting is over the serialised representation including keys
//     and internal overhead, not `JSON.stringify(value).length`; and JS string
//     length is UTF-16 units, so non-ASCII costs more bytes than counted here.
//     Sizes here are therefore indicative, not exact.
//   - `QUOTA_BYTES_PER_ITEM`, write-rate limits (MAX_WRITE_OPERATIONS_PER_HOUR),
//     and eviction are not modelled at all.
//   - The real API reports some failures via `chrome.runtime.lastError` rather
//     than a rejection, depending on call style. The code uses the promise form,
//     which does reject, so this fake matches that path only.
function installFakeChrome({ quotaBytes = Infinity } = {}) {
  const backing = new Map();
  const used = () => {
    let total = 0;
    for (const [key, value] of backing) total += key.length + value.length;
    return total;
  };
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
          const pending = new Map(backing);
          for (const [key, value] of Object.entries(items)) {
            pending.set(key, JSON.stringify(value));
          }
          let total = 0;
          for (const [key, value] of pending) total += key.length + value.length;
          if (total > quotaBytes) {
            // Chrome's real message, so a test asserting on it is asserting on
            // something the extension would actually see.
            throw new Error(
              "QUOTA_BYTES quota exceeded. Failed to set the value."
            );
          }
          for (const [key, value] of pending) backing.set(key, value);
        },
        async remove(keys) {
          await null;
          for (const key of [].concat(keys)) backing.delete(key);
        },
      },
    },
  };
  globalThis.chrome = fake;
  return { backing, fake, used };
}

let backing;
beforeEach(async () => {
  ({ backing } = installFakeChrome());
  // The module holds a write chain and a sticky failure flag across tests; drain
  // and clear both so one test's state cannot leak into the next.
  await clear();
  backing.clear();
  resetWriteFailure();
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
      .mockRejectedValue(new Error("QUOTA_BYTES quota exceeded"));

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
    expect(entry.detail.length).toBeLessThan(MAX_DETAIL_BYTES + 100);
    expect(entry.detail).toMatch(/\[truncated\]$/);
  });

  it("leaves a detail under the cap untouched", async () => {
    // Negative control: a truncator that truncated everything would pass the
    // test above while destroying every useful log line.
    await record({ cmd: "page_read", outcome: "allowed", detail: "short reason" });
    expect((await readAll())[0].detail).toBe("short reason");
  });

  // Every field is server-controlled and every one is written on the DENIED
  // path, before any check has passed — so the attacker-reachable path must be
  // the bounded one. Capping `detail` alone let a 5MB url through.
  it.each([
    ["url", "url", MAX_URL_BYTES],
    ["cmd", "cmd", MAX_LABEL_BYTES],
    ["outcome", "outcome", MAX_LABEL_BYTES],
    ["detail", "detail", MAX_DETAIL_BYTES],
  ])("caps an oversized %s", async (_label, field, limit) => {
    await record({
      cmd: "page_navigate",
      url: "https://evil.test/",
      outcome: "denied",
      [field]: "x".repeat(5_000_000),
    });
    const entry = (await readAll())[0];
    expect(entry[field].length).toBeLessThanOrEqual(limit + "…[truncated]".length);
    expect(entry[field]).toMatch(/\[truncated\]$/);
  });

  // The cap budgets SERIALISED bytes, not string length, because storage
  // charges bytes and the attacker picks the characters. A control character
  // costs 6 bytes per counted UTF-16 unit; counting units let one 2048-unit
  // field reach ~12KB and the whole log a measured 12.4MB — above the quota the
  // cap existed to stay under.
  it.each([
    ["ascii", "x", 1],
    ["quotes", '"', 2],
    ["backslashes", "\\", 2],
    ["newlines", "\n", 2],
    ["control chars", "", 6],
    ["CJK", "中", 3],
    ["astral emoji", "\u{1F600}", 2],
  ])("bounds a url of %s by bytes, not characters", async (_label, ch, _cost) => {
    await record({
      cmd: "page_navigate",
      url: ch.repeat(20_000),
      outcome: "denied",
    });
    const { url } = (await readAll())[0];
    const bytes =
      new TextEncoder().encode(JSON.stringify(url)).length - 2;
    // The marker suffix is counted outside the budget, hence the slack.
    expect(bytes).toBeLessThanOrEqual(MAX_URL_BYTES + 40);
    expect(url).toMatch(/\[truncated\]$/);
  });

  it("never splits an astral character into a lone surrogate", async () => {
    // Slicing by UTF-16 index can cut an emoji in half; JSON.stringify then
    // escapes the orphan to \udXXX — six bytes of mojibake in place of the
    // character the cap was trying to bound.
    await record({
      cmd: "page_navigate",
      url: "\u{1F600}".repeat(20_000),
      outcome: "denied",
    });
    const { url } = (await readAll())[0];
    // `\p{Surrogate}` with the `u` flag matches only UNPAIRED surrogates — a
    // well-formed emoji is a surrogate pair and must not trip this. Asserting on
    // the raw \uD800-\uDFFF range instead would flag every valid emoji and the
    // test would fail against correct code.
    expect(url).not.toMatch(/\p{Surrogate}/u);
    expect(url.startsWith("\u{1F600}")).toBe(true);
  });

  it("bounds the whole log near its stated ceiling under the worst payload", async () => {
    // The arithmetic in the module comment, checked against the payload an
    // attacker would actually choose rather than against ASCII.
    for (let i = 0; i < 20; i += 1) {
      await record({
        cmd: "".repeat(5000),
        url: "".repeat(50_000),
        outcome: "".repeat(5000),
        detail: "".repeat(50_000),
      });
    }
    const stored = JSON.stringify(await readAll());
    const bytesPerEntry =
      new TextEncoder().encode(stored).length / (await readAll()).length;
    expect(bytesPerEntry).toBeLessThan(5000);
  });

  it("bounds the whole stored entry, not just one field of it", async () => {
    // The arithmetic that actually closes the finding: with all four fields
    // capped, a maximally hostile record cannot approach the storage quota.
    await record({
      cmd: "x".repeat(5_000_000),
      url: "x".repeat(5_000_000),
      outcome: "x".repeat(5_000_000),
      detail: "x".repeat(5_000_000),
    });
    const stored = JSON.stringify(await readAll());
    expect(stored.length).toBeLessThan(10_000);
  });

  it("leaves normal-sized fields of every kind untouched", async () => {
    // Negative control for the cap table: caps that truncated everything would
    // satisfy it while destroying the log's usefulness.
    const url = "https://linkedin.com/feed/?ref=abc";
    await record({
      cmd: "page_navigate",
      url,
      outcome: "denied",
      detail: "not in allowlist",
    });
    expect(await readAll()).toEqual([
      expect.objectContaining({
        cmd: "page_navigate",
        url,
        outcome: "denied",
        detail: "not in allowlist",
      }),
    ]);
  });

  it("serialises a non-string detail rather than storing [object Object]", async () => {
    await record({ cmd: "page_type", outcome: "denied", detail: { code: 42 } });
    expect((await readAll())[0].detail).toBe('{"code":42}');
  });
});

describe("a full store — the failure that must not be silent", () => {
  // These run against the fake's quota model, so the failure path EXECUTES
  // rather than being asserted about. See the fake's header for what it still
  // does not model: whole-extension budgeting, exact byte accounting,
  // per-item limits, write-rate limits and eviction.
  let quotaChrome;
  beforeEach(async () => {
    resetWriteFailure();
    // Room for a handful of entries, so the store fills within a short test.
    quotaChrome = installFakeChrome({ quotaBytes: 3000 });
    backing = quotaChrome.backing;
  });

  /** Fill until a write is rejected. Returns how many succeeded. */
  async function fillUntilFull(limit = 200) {
    for (let i = 0; i < limit; i += 1) {
      try {
        await record({
          cmd: "page_click",
          url: `https://linkedin.com/${"p".repeat(100)}/${i}`,
          outcome: "allowed",
        });
      } catch {
        return i;
      }
    }
    throw new Error("store never filled; the quota fake is not applying");
  }

  it("rejects the write rather than pretending it stored", async () => {
    const written = await fillUntilFull();
    // If this were 0 the test would be vacuous — nothing was ever stored, so a
    // later failure would prove nothing about a FULL store.
    expect(written).toBeGreaterThan(0);
  });

  it("reports the failure through getWriteFailure instead of swallowing it", async () => {
    expect(getWriteFailure()).toBeNull();
    await fillUntilFull();
    const failure = getWriteFailure();
    // The finding was not the size — it was that `writeChain.catch` made a full
    // store indistinguishable from a working one. This is the observable signal.
    expect(failure).not.toBeNull();
    expect(failure.message).toMatch(/QUOTA_BYTES/);
    expect(Number.isNaN(Date.parse(failure.at))).toBe(false);
  });

  it("logs the failure to the console, the one signal that needs no storage", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    await fillUntilFull();
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0].join(" ")).toMatch(/audit log write failed/i);
    spy.mockRestore();
  });

  it("leaves a durable marker in the log saying history was dropped", async () => {
    // The flag above dies with the ~30s service-worker teardown, so a user
    // investigating later would see a silently short log. This marker is the
    // part that survives: a visible gap beats an invisible one.
    await fillUntilFull();
    const entries = await readAll();
    const marker = entries.at(-1);
    expect(marker.outcome).toBe("write_failed");
    expect(marker.detail).toMatch(/incomplete/i);
  });

  it("keeps recent history rather than dropping the whole log", async () => {
    const written = await fillUntilFull();
    const entries = await readAll();
    // More than just the marker survived, so recovery is not a disguised wipe.
    expect(entries.length).toBeGreaterThan(1);
    expect(entries.length).toBeLessThanOrEqual(RECOVERY_ENTRIES + 1);
    // And it genuinely SHRANK. Recovery halves until it fits rather than
    // trusting a fixed count: asking for RECOVERY_ENTRIES when only 13 fit made
    // the recovery write bigger than the one that had just failed, so it failed
    // too and nothing durable was stored.
    expect(entries.length).toBeLessThan(written + 1);
    // The surviving entries are the most recent ones — the part a user
    // investigating an incident actually wants. `written` is the index of the
    // record whose write was rejected, and it is retained: recovery re-writes
    // the entry list the failed write was carrying, so that record is not lost
    // just because the write that would have stored it failed.
    expect(entries.at(-2).url).toContain(`/${written}`);
  });

  it("marks the failure as recovered when the marker was stored", async () => {
    // F-M2c: `recovered` is what distinguishes "history dropped but a trace
    // survives" from "nothing could be written at all", and TASK 9 CONSUMES IT.
    // Nothing pinned it at true, so a mutation fixing it at false survived.
    await fillUntilFull();
    expect(getWriteFailure().recovered).toBe(true);
    expect((await readAll()).at(-1).outcome).toBe("write_failed");
  });

  it("can record again after recovering space", async () => {
    await fillUntilFull();
    // Recovery is only worth having if the log actually resumes.
    await record({ cmd: "page_read", outcome: "allowed" });
    expect((await readAll()).map((e) => e.cmd)).toContain("page_read");
  });

  it("keeps the failure sticky, so a later success cannot hide the gap", async () => {
    await fillUntilFull();
    const first = getWriteFailure();
    await record({ cmd: "page_read", outcome: "allowed" });
    // Clearing on success would let a burst of failures vanish the moment one
    // small write lands — precisely the window an attacker would aim for.
    expect(getWriteFailure()).toEqual(first);
  });

  it("keeps the FIRST failure, not the most recent one", async () => {
    // The first failure is the one that marks where the log stopped being
    // trustworthy. Overwriting it on each later failure would keep moving the
    // timestamp forward, hiding how long the gap has been open.
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    resetWriteFailure();
    chrome.storage.local.set = jest
      .fn()
      .mockRejectedValue(new Error("QUOTA_BYTES first"));
    await expect(record({ cmd: "one", outcome: "allowed" })).rejects.toThrow();
    const first = getWriteFailure();

    chrome.storage.local.set = jest
      .fn()
      .mockRejectedValue(new Error("QUOTA_BYTES second"));
    await expect(record({ cmd: "two", outcome: "allowed" })).rejects.toThrow();

    expect(getWriteFailure()).toEqual(first);
    expect(getWriteFailure().message).toMatch(/first/);
    spy.mockRestore();
  });

  it("does not report a failure when writes are succeeding", async () => {
    // Negative control for this whole block. A flag that was always set would
    // pass every test above while telling the user nothing.
    installFakeChrome();
    resetWriteFailure();
    await record({ cmd: "page_click", outcome: "allowed" });
    expect(getWriteFailure()).toBeNull();
  });

  it("still surfaces the failure when even the recovery write fails", async () => {
    // The worst case: nothing durable is possible. The flag and the console
    // line must still fire, or the log goes dark in total silence.
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    resetWriteFailure();
    chrome.storage.local.set = jest
      .fn()
      .mockRejectedValue(new Error("QUOTA_BYTES quota exceeded"));

    await expect(record({ cmd: "boom", outcome: "allowed" })).rejects.toThrow(
      "QUOTA_BYTES"
    );
    expect(getWriteFailure()).not.toBeNull();
    expect(getWriteFailure().recovered).toBe(false);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
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
