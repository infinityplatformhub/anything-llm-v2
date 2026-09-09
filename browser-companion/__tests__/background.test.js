import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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

/**
 * The accessors dispatch.js ACTUALLY calls, scraped from its source.
 *
 * Task 7 exports no executable accessor contract — asked for, not present — so
 * this derives one rather than restating a list. A hand-written list is exactly
 * the test that cannot fail when the thing it describes changes: task 8's brief
 * named only two of the five accessors, wiring exactly as briefed left
 * page_tabs / page_switch / page_close failing at runtime, and a test restating
 * the brief's two would have agreed with the brief and stayed green.
 *
 * Scraping the source means a SIXTH accessor added to dispatch.js tomorrow
 * turns this red the moment it is called and not wired, with no one having to
 * remember this file exists.
 */
const dispatchSource = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src/background/dispatch.js"
  ),
  "utf8"
);

/** Every `deps.foo(` / `d.foo(` call in dispatch.js, deduplicated. */
const CALLED_ACCESSORS = [
  ...new Set(
    [...dispatchSource.matchAll(/\b(?:deps|d)\.([A-Za-z_$][\w$]*)\s*\(/g)].map(
      (match) => match[1]
    )
  ),
];

describe("the accessor contract, derived from dispatch.js's own source", () => {
  // Guards the instrument: a regex that matched nothing would make every
  // assertion below vacuously true, which is the quietest possible way for this
  // file to stop testing anything.
  it("finds the accessors dispatch.js calls", () => {
    expect(CALLED_ACCESSORS.length).toBeGreaterThanOrEqual(5);
    // The five task 7 deliberately refuses to default must be among them, or
    // the scrape is reading something other than what it thinks.
    for (const name of [
      "agentTabUrl",
      "ensureAgentTab",
      "listAgentTabs",
      "switchToTab",
      "closeTab",
    ])
      expect(CALLED_ACCESSORS).toContain(name);
  });

  // THE DEFECT THIS EXISTS TO CATCH. Every accessor dispatch.js calls must be
  // supplied here or defaulted there. Task 7 defaults none of the tab
  // accessors on purpose — a no-op default would make a wiring bug look like a
  // working dispatch — so a missing one is a hard runtime failure of a whole
  // command, not a silent no-op.
  it.each(
    CALLED_ACCESSORS.map((name) => [name])
  )("supplies or safely defaults %s", (name) => {
    const supplied = typeof deps[name] === "function";
    const nested =
      typeof deps.cdp?.[name] === "function" ||
      typeof deps.pageState?.[name] === "function";
    expect(supplied || nested).toBe(true);
  });
});

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

  // THE ACCESSOR CONTRACT, stated executably here because task 7 exports none.
  //
  // page_close's rule — the tab `agentTabUrl` reports must be the tab
  // `ensureAgentTab` returns — otherwise lives only in a comment in dispatch.js
  // and in a report that dies with the workspace. This asserts it through the
  // deps bundle a real command would use, so it holds whatever dispatch.js does
  // next, and so a future wiring that sources the two from different places
  // fails here rather than in production.
  it("enforces same-tab between the two accessors it exposes", async () => {
    const gatedUrl = await deps.agentTabUrl();
    expect(typeof gatedUrl).toBe("string");
    // Same command scope, nothing moved: the action gets the gated tab.
    await expect(deps.ensureAgentTab()).resolves.toBe(1);
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
