import { describe, it, expect } from "@jest/globals";

/* ===========================================================================
 * The service worker's WIRING, which is otherwise untested and was proved so:
 * a mutation run against a suite that never imported index.js let four wiring
 * mutations survive outright — dropping `listAgentTabs`, dropping `closeTab`,
 * slipping a permissive `isAllowed` into deps, and pointing `ensureAgentTab` at
 * a different tab source than `agentTabUrl`. Each of those is a live bug and
 * none of them is visible from any other file.
 *
 * WHAT IS DOUBLED: `chrome`, minimally — index.js registers four listeners and
 * calls `storage.sync.get` at module load, so it cannot be imported at all
 * without one. The doubles record what was registered.
 *
 * WHAT IS NOT: the real MV3 lifecycle. Nothing here tears a worker down, so
 * whether the top-level `startCompanion()` really runs on a wake is Chrome's
 * behaviour and is unverified by this file. The listener REGISTRATIONS are
 * asserted; what Chrome does with them is not.
 * ======================================================================== */

const listeners = { startup: [], installed: [], storage: [], alarm: [] };
let syncStore = {};

globalThis.WebSocket = class {
  constructor() {
    this.readyState = 0;
  }
  send() {}
  close() {}
};

globalThis.chrome = {
  runtime: {
    onStartup: { addListener: (fn) => listeners.startup.push(fn) },
    onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
  },
  alarms: {
    create: () => {},
    clear: () => {},
    onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
  },
  tabs: {
    create: async () => ({ id: 1, url: "about:blank" }),
    get: async (id) => ({ id, url: "about:blank" }),
    query: async () => [],
    update: async () => {},
    remove: async () => {},
  },
  debugger: {
    onDetach: { addListener: () => {} },
    attach: async () => {},
    detach: async () => {},
    sendCommand: async () => ({ result: { value: null } }),
  },
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    sync: {
      get: async (keys) => {
        const out = {};
        for (const key of [].concat(keys))
          if (key in syncStore) out[key] = syncStore[key];
        return out;
      },
    },
    onChanged: { addListener: (fn) => listeners.storage.push(fn) },
  },
};

const { deps } = await import("../src/background/index.js");
const socket = await import("../src/background/socket.js");

describe("the dependency bundle handed to dispatch", () => {
  // Task 7 deliberately defaults NONE of the five tab accessors, because a
  // no-op default would make a wiring mistake look like a working dispatch.
  // That decision only pays off if this file supplies all five.
  it.each([
    "agentTabUrl",
    "ensureAgentTab",
    "listAgentTabs",
    "switchToTab",
    "closeTab",
  ])("supplies %s, which dispatch.js deliberately does not default", (name) => {
    expect(typeof deps[name]).toBe("function");
  });

  // @edge — the sharpest coupling in this task. `handle` gates on the url
  // `agentTabUrl` reports and acts on the tab `ensureAgentTab` returns, so they
  // MUST come from the same tab manager. Two different sources would let the
  // gate judge one tab while the action hits another, and every test in
  // socket.test.js would still pass — the divergence lives here, not there.
  it("takes both tab accessors from the one tab manager", () => {
    expect(deps.agentTabUrl).toBe(socket.agentTabUrl);
    expect(deps.ensureAgentTab).toBe(socket.ensureAgentTab);
    expect(deps.listAgentTabs).toBe(socket.listAgentTabs);
    expect(deps.switchToTab).toBe(socket.switchToTab);
    expect(deps.closeTab).toBe(socket.closeTab);
  });

  // @edge — THE SECURITY BOUNDARY. dispatch.js imports `isAllowed` and
  // `isSameOrigin` directly from allowlist.js: the LIST is injectable, the
  // JUDGEMENT is not. A permissive value passed through here would evaporate
  // the entire boundary with every other test still green.
  it.each(["isAllowed", "isSameOrigin"])(
    "never passes %s through deps, so the judgement stays non-injectable",
    (name) => {
      expect(Object.prototype.hasOwnProperty.call(deps, name)).toBe(false);
    }
  );

  it("supplies the allowlist loader and the audit recorder", () => {
    expect(typeof deps.loadAllowlist).toBe("function");
    expect(typeof deps.record).toBe("function");
  });

  it("supplies the cdp surface every gated command needs", () => {
    for (const method of [
      "attach",
      "detach",
      "click",
      "type",
      "key",
      "scroll",
      "navigate",
      "fetch",
    ])
      expect(typeof deps.cdp[method]).toBe("function");
  });

  it("supplies the page-state map and its lookup", () => {
    expect(typeof deps.pageState.capture).toBe("function");
    expect(typeof deps.pageState.invalidate).toBe("function");
    expect(typeof deps.lookup).toBe("function");
  });
});

describe("the service worker's listeners", () => {
  it("re-establishes the connection on startup and on install", () => {
    expect(listeners.startup).toHaveLength(1);
    expect(listeners.installed).toHaveLength(1);
  });

  it("reconnects when the popup writes a new server or key", () => {
    expect(listeners.storage).toHaveLength(1);
  });

  it("wakes on the keepalive alarm", () => {
    expect(listeners.alarm).toHaveLength(1);
  });
});
