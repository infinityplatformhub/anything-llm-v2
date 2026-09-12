import { describe, it, expect, beforeEach, jest } from "@jest/globals";

/* ===========================================================================
 * The popup's half of the extension, measured on the worker side.
 *
 * WHAT IS DOUBLED AND WHY IT IS SAFE HERE: `chrome.storage.local` (a real Map,
 * so a write can be read back and a failure can be made to happen), and
 * `chrome.debugger` (attach/detach are recorded rather than performed). What is
 * NOT doubled is the thing under test — the pause, the kill switch and the
 * message handlers all run their real code.
 *
 * The one double that would invalidate this file is a fake that always
 * succeeds, because every case below is about a failure state. So the storage
 * double can be told to reject, and the audit log's real `record` runs against
 * it.
 * ======================================================================== */

let store = new Map();
let setShouldThrow = null;
let attachedTabs = [];
let detachedTabs = [];
let tabUpdates = [];

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const out = {};
        for (const key of [].concat(keys))
          if (store.has(key)) out[key] = store.get(key);
        return out;
      },
      set: async (patch) => {
        if (setShouldThrow) throw new Error(setShouldThrow);
        for (const [key, value] of Object.entries(patch)) store.set(key, value);
      },
      remove: async (keys) => {
        for (const key of [].concat(keys)) store.delete(key);
      },
    },
    sync: { get: async () => ({}) },
    onChanged: { addListener: () => {} },
  },
  runtime: {
    onStartup: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    onMessage: { addListener: () => {} },
  },
  alarms: { create: () => {}, clear: () => {}, onAlarm: { addListener: () => {} } },
  tabs: {
    create: async () => ({ id: 7, url: "about:blank" }),
    get: async (id) => ({ id, url: "about:blank" }),
    query: async () => [],
    update: async (id, props) => {
      tabUpdates.push({ id, props });
    },
    remove: async () => {},
  },
  debugger: {
    onDetach: { addListener: () => {} },
    attach: async ({ tabId }) => {
      attachedTabs.push(tabId);
    },
    detach: async ({ tabId }) => {
      detachedTabs.push(tabId);
    },
    sendCommand: async () => ({}),
  },
};

const control = await import("../src/background/control.js");
const auditLog = await import("../src/background/auditLog.js");
const cdp = await import("../src/background/cdp.js");
const socket = await import("../src/background/socket.js");
const { MSG } = await import("../src/shared/companionMessages.js");

/** Let the audit log's write chain drain. */
const settle = async () => {
  for (let i = 0; i < 5; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

beforeEach(async () => {
  store = new Map();
  setShouldThrow = null;
  attachedTabs = [];
  detachedTabs = [];
  tabUpdates = [];
  control.__reset();
  auditLog.resetWriteFailure();
  socket.__reset();
  await cdp.detachAll();
});

describe("the pause actually refuses commands", () => {
  it("runs the handler when nothing is paused", async () => {
    // NEGATIVE CONTROL. Without this, a `guardCommands` that refused
    // EVERYTHING would pass every other case in this describe block — the
    // refusal assertions cannot tell "refuses when paused" from "refuses
    // always".
    const handler = jest.fn(async () => ({ requestId: "r1", ok: true }));
    const guarded = control.guardCommands(handler);

    await expect(guarded({ requestId: "r1", cmd: "page_click" })).resolves.toEqual(
      { requestId: "r1", ok: true }
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("never reaches the handler once paused", async () => {
    const handler = jest.fn(async () => ({ requestId: "r1", ok: true }));
    const guarded = control.guardCommands(handler);
    await control.setPaused(true);

    const reply = await guarded({ requestId: "r1", cmd: "page_click" });

    // NOT REACHED, not merely refused. The whole design claim is that a paused
    // browser answers before a tab is resolved, before the allowlist is read
    // and before a debugger is attached — which is only true if the wrapped
    // handler never runs.
    expect(handler).not.toHaveBeenCalled();
    expect(reply.ok).toBe(false);
    expect(reply.requestId).toBe("r1");
    expect(reply.error).toMatch(/paused/i);
  });

  it("runs the handler again after resume", async () => {
    const handler = jest.fn(async () => ({ requestId: "r1", ok: true }));
    const guarded = control.guardCommands(handler);
    await control.setPaused(true);
    await control.setPaused(false);

    await guarded({ requestId: "r1", cmd: "page_click" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // @edge — a frame with no requestId. The server keys its pending table on
  // that id, so a reply built without one settles nothing and is noise on the
  // wire. `dispatch.handle` answers null for the same reason, and the pause
  // path must not diverge.
  it("answers nothing for a frame carrying no requestId", async () => {
    const guarded = control.guardCommands(async () => ({ ok: true }));
    await control.setPaused(true);
    await expect(guarded({ cmd: "page_click" })).resolves.toBeNull();
  });

  // @edge — the pause must survive an audit log that cannot write. Recording is
  // best-effort; refusing is not. A `record` rejection propagating here would
  // turn "your history is incomplete" into "your stop button did nothing".
  it("still refuses when the audit log cannot be written", async () => {
    const handler = jest.fn(async () => ({ requestId: "r1", ok: true }));
    const guarded = control.guardCommands(handler);
    await control.setPaused(true);

    setShouldThrow = "QUOTA_BYTES quota exceeded";
    const reply = await guarded({ requestId: "r1", cmd: "page_click" });

    expect(handler).not.toHaveBeenCalled();
    expect(reply.ok).toBe(false);
  });

  it("records the refusal so the user can see it happened", async () => {
    const guarded = control.guardCommands(async () => ({ ok: true }));
    await control.setPaused(true);
    await guarded({ requestId: "r1", cmd: "page_click" });
    await settle();

    const entries = await auditLog.readAll();
    expect(
      entries.some(
        (entry) => entry.cmd === "page_click" && entry.outcome === "denied"
      )
    ).toBe(true);
  });
});

describe("the kill switch", () => {
  it("pauses and hands back every debugger attachment", async () => {
    await cdp.attach(11);
    await cdp.attach(12);
    expect(cdp.attachedTabIds()).toEqual([11, 12]);

    const result = await control.killSwitch();

    expect(result.paused).toBe(true);
    expect(result.detached).toBe(2);
    // Detaching is the half that matters: a pause alone refuses the NEXT
    // command while leaving the agent attached to pages already open.
    expect(detachedTabs.sort()).toEqual([11, 12]);
    expect(cdp.attachedTabIds()).toEqual([]);
  });

  // @edge — a kill switch with nothing attached must still pause, and must not
  // throw. This is the state it is pressed in most often: something looks
  // wrong and the user hits stop before knowing what is happening.
  it("pauses even when the agent holds no tabs", async () => {
    const result = await control.killSwitch();
    expect(result).toEqual({ paused: true, detached: 0 });
    expect(control.isPaused()).toBe(true);
  });

  // @edge — the ordering guarantee. If recording the kill fails, the browser
  // must be left in the MORE restrictive state, never the less.
  it("stays paused when the audit write fails", async () => {
    setShouldThrow = "QUOTA_BYTES quota exceeded";
    await control.killSwitch();
    expect(control.isPaused()).toBe(true);
  });
});

describe("the messages the popup sends", () => {
  /** Call the listener the way Chrome does, and await its reply. */
  const send = (message, deps = {}) =>
    new Promise((resolve) => {
      const async_ = control.onMessage(message, {}, resolve, deps);
      if (!async_) resolve(undefined);
    });

  it("keeps the channel open for its own messages", () => {
    expect(control.onMessage({ type: MSG.GET_STATUS }, {}, () => {}, {})).toBe(
      true
    );
  });

  // NEGATIVE CONTROL for the guard above: a handler that claimed every message
  // would make a second listener added later silently unreachable.
  it("declines a message that is not the companion's", () => {
    expect(control.onMessage({ type: "other:thing" }, {}, () => {}, {})).toBe(
      false
    );
    expect(control.onMessage(undefined, {}, () => {}, {})).toBe(false);
  });

  it("reports the pause, the socket and the attachments together", async () => {
    await cdp.attach(3);
    await control.setPaused(true);

    const reply = await send({ type: MSG.GET_STATUS });

    expect(reply.ok).toBe(true);
    expect(reply.data.paused).toBe(true);
    expect(reply.data.attachedTabs).toBe(1);
    expect(reply.data.socket.status).toBe("idle");
  });

  // @edge — THE STICKY AUDIT FAILURE, which is the whole reason the popup can
  // say "this log is short because writes failed" rather than showing an empty
  // list as if nothing had happened.
  it("surfaces a failed audit write, with when and why", async () => {
    setShouldThrow = "QUOTA_BYTES quota exceeded";
    await auditLog
      .record({ cmd: "page_click", outcome: "ok" })
      .catch(() => {});
    setShouldThrow = null;

    const reply = await send({ type: MSG.GET_STATUS });

    expect(reply.data.auditWriteFailure).not.toBeNull();
    expect(reply.data.auditWriteFailure.message).toMatch(/quota/i);
    expect(typeof reply.data.auditWriteFailure.at).toBe("string");
  });

  // NEGATIVE CONTROL for the case above: a healthy log must report null, or
  // "surfaces a failure" would pass against a field that is always populated.
  it("reports no audit failure when writes are working", async () => {
    await auditLog.record({ cmd: "page_click", outcome: "ok" });
    await settle();
    const reply = await send({ type: MSG.GET_STATUS });
    expect(reply.data.auditWriteFailure).toBeNull();
  });

  it("pauses and resumes on request", async () => {
    await expect(send({ type: MSG.SET_PAUSED, paused: true })).resolves.toEqual({
      ok: true,
      data: { paused: true },
    });
    expect(control.isPaused()).toBe(true);

    await send({ type: MSG.SET_PAUSED, paused: false });
    expect(control.isPaused()).toBe(false);
  });

  // @edge — THE WAY BACK FROM AN EVICTION. 4409 is terminal by design and is
  // remembered across a worker teardown, so without this the user's only
  // recovery is reinstalling the extension.
  it("clears a stored terminal verdict and reconnects", async () => {
    store.set("companionTerminalClose", {
      key: "0".repeat(32),
      status: "evicted",
      error: "taken over",
      at: new Date().toISOString(),
    });
    const restart = jest.fn(async () => {});

    const reply = await send({ type: MSG.RECONNECT }, { restart });

    expect(reply.ok).toBe(true);
    // BOTH halves. Clearing without reconnecting leaves a popup that looks
    // fixed and is not; reconnecting without clearing is refused again by the
    // stored verdict.
    expect(store.has("companionTerminalClose")).toBe(false);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  // @edge — when the verdict cannot be cleared, reconnecting would be refused
  // again. Saying so beats a button that silently achieves nothing.
  it("refuses to claim a reconnect it could not perform", async () => {
    const restart = jest.fn(async () => {});
    chrome.storage.local.remove = async () => {
      throw new Error("storage unavailable");
    };

    const reply = await send({ type: MSG.RECONNECT }, { restart });

    expect(reply.ok).toBe(false);
    expect(restart).not.toHaveBeenCalled();
    chrome.storage.local.remove = async (keys) => {
      for (const key of [].concat(keys)) store.delete(key);
    };
  });

  it("focuses the agent's tab when there is one", async () => {
    // Created through the real accessor, so the id the popup focuses is the one
    // the agent actually holds.
    await socket.agentTabUrl();
    const reply = await send({ type: MSG.FOCUS_AGENT_TAB });

    expect(reply.ok).toBe(true);
    expect(tabUpdates).toEqual([{ id: 7, props: { active: true } }]);
  });

  // @edge — no agent tab is an ordinary state of this browser, not an error,
  // and the popup says so in words rather than showing a button that does
  // nothing.
  it("says so plainly when the agent has no tab", async () => {
    const reply = await send({ type: MSG.FOCUS_AGENT_TAB });
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/no tab/i);
    expect(tabUpdates).toEqual([]);
  });

  it("names an unknown companion message rather than hanging", async () => {
    const reply = await send({ type: "companion:doesNotExist" });
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/doesNotExist/);
  });
});
