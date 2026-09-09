import { describe, it, expect, beforeEach } from "@jest/globals";
import { readFileSync, readdirSync } from "node:fs";
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

const listeners = {
  startup: [],
  installed: [],
  storage: [],
  alarm: [],
  message: [],
};
// Seeded here rather than reassigned lower down: the module's top-level
// `startCompanion()` reads this during its own import, so anything written
// after that import is too late for it. See the L2 case.
let syncStore = { apiBase: "https://boot.test/api", apiKey: "brx-boot" };

/**
 * Every socket index.js caused to be constructed.
 *
 * A stub that recorded nothing would make "did this listener connect?"
 * unanswerable, which is the question this whole file now exists to ask.
 */
let sockets = [];

globalThis.WebSocket = class {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    sockets.push(this);
  }
  send(frame) {
    if (this.readyState !== 1) return; // Matches the browser: discard, no throw.
    this.sent.push(frame);
  }
  close() {
    this.readyState = 3;
  }
};

globalThis.chrome = {
  runtime: {
    onStartup: { addListener: (fn) => listeners.startup.push(fn) },
    onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
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

const {
  deps,
  CONFIG_KEYS,
  startCompanion,
  onStorageChanged,
  onAlarm,
  onRuntimeMessage,
} = await import("../src/background/index.js");

/**
 * Sockets built by the module's own top-level call, captured before any test
 * clears the list.
 *
 * L2: deleting that top-level `startCompanion()` — the line whose comment says
 * it is the only thing that rebuilds the socket on a wake — survived the whole
 * suite. It is only observable at module load, so the evidence has to be taken
 * here and asserted later.
 */
// Several macrotasks, not one: the load-time connect awaits storage and
// `crypto.subtle` before it builds anything, so a single turn captures an empty
// list and the case fails saying the module never connected.
for (let i = 0; i < 20 && sockets.length === 0; i += 1)
  await new Promise((resolve) => setImmediate(resolve));
const socketsAtLoad = [...sockets];
const socket = await import("../src/background/socket.js");
const { cdp } = await import("../src/background/cdp.js");
const control = await import("../src/background/control.js");

/**
 * Let a real async chain (crypto.subtle, storage) settle.
 *
 * `setTimeout`, not `setImmediate`, and more turns than seem necessary.
 * `connect` awaits `crypto.subtle.digest` on its cold path, and that resolves
 * off the microtask queue entirely — spinning `setImmediate` cannot drain it.
 * Three turns was enough when this file ran alone and NOT enough once the full
 * suite ran in parallel: "reconnects when only the server address changes"
 * failed with `sockets` still empty, which reads as a broken listener when the
 * truth is that the assertion ran too early.
 */
const settle = async () => {
  for (let i = 0; i < 12; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
};

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
  });

  // `closeTab` and the cdp acts are WRAPPED, so identity is the wrong
  // assertion for them — but "not identical" must not be allowed to mean
  // "wired to something else entirely", which is what the identity check was
  // protecting against. So it is checked by behaviour instead: the wrapper
  // refuses a tab the agent does not own, which nothing but the real
  // ownership-guarded path does.
  // The guard throws SYNCHRONOUSLY, before the wrapped call is made — that is
  // the point: there must be no await between the check and the act. Both
  // shapes are caught by `handle`'s try/catch, which is what turns it into a
  // recorded refusal the agent reads.
  it("wraps the destructive acts in the ownership check", () => {
    expect(typeof deps.closeTab).toBe("function");
    expect(deps.closeTab).not.toBe(socket.closeTab);
    expect(() => deps.closeTab(4242)).toThrow(/closed while this command/);
    for (const name of [
      "attach",
      "click",
      "type",
      "key",
      "scroll",
      "navigate",
      "fetch",
    ])
      expect(() => deps.cdp[name](4242)).toThrow(/closed while this command/);
  });

  // @edge — `detach` is deliberately NOT wrapped: page_close detaches before
  // closing, and refusing that would leave a debugger attachment on a tab that
  // is going away. It cannot harm a recycled tab either, because cdp.detach
  // returns early for an id it never attached.
  it("leaves detach unwrapped, so a closing tab can still be released", () => {
    expect(deps.cdp.detach).toBe(cdp.detach);
  });

  // @edge — `detachAll` takes NO arguments, so wrapping it made
  // `assertStillOwned(undefined)` run, which is false for every state of
  // `createdTabIds` — the guarded copy could never execute at all. That is the
  // kill switch's sweep, and it survived only because control.js imports
  // detachAll straight from cdp.js rather than through deps.cdp. One import
  // style away from the user's stop button always throwing.
  it("leaves detachAll unwrapped, and it actually runs", async () => {
    expect(deps.cdp.detachAll).toBe(cdp.detachAll);
    // Not just identity: it must be callable, which is the property that was
    // broken. Identity alone would pass on a wrapper that happened to be the
    // same object.
    await expect(deps.cdp.detachAll()).resolves.toBeUndefined();
  });

  // The kill switch's own path, asserted end to end: it must sweep whatever
  // attachments exist without depending on how it imports detachAll.
  it("lets the kill switch sweep attachments", async () => {
    const control = await import("../src/background/control.js");
    // `attachedTabIds` is not on the frozen `cdp` surface, so it is imported
    // directly — the same way control.js reaches `detachAll`, which is the
    // import style this whole finding turned on.
    const { attachedTabIds } = await import("../src/background/cdp.js");

    await cdp.attach(4242);
    expect(attachedTabIds()).toContain(4242);

    // `killSwitch`, not `setPaused` — the sweep is what makes the stop button a
    // stop button. A pause alone leaves every tab attached, with Chrome's
    // debugging bar still up, which reads to the user as "it did not stop".
    const result = await control.killSwitch();

    expect(attachedTabIds()).toEqual([]);
    expect(result.detached).toBe(1);
    expect(result.paused).toBe(true);
    await control.setPaused(false);
  });

  /**
   * THE WIRING IS THE SOURCE OF TRUTH FOR WHICH DEPS EXIST.
   *
   * A `cdp`-only version of this check passed while `pageState` was wired raw
   * and `page_read` disclosed a non-allowlisted page — `pageState` imports
   * `evaluate` straight from cdp.js, so it never appears on the frozen surface
   * a cdp-only test inspects. The fix for that was to name `pageState` here
   * too, and THAT WAS THE SAME BUG WITH A LONGER FUSE: a hand-written list of
   * two mirrors the wiring today and misses the third dep the day someone adds
   * it. A reviewer's probe proved it — `shots: { grab: async (tabId) => ... }`
   * added to the real `deps`, and the whole suite stayed green.
   *
   * So what is written below is no longer a list of deps. It is a list of
   * RULINGS, and the deps themselves come from `Object.entries(deps)`.
   * Judgement — which methods are knowingly unguarded, and why — is written
   * down because it cannot be derived. Existence is derived, because it can be.
   *
   * TOP-LEVEL FUNCTION DEPS GET THEIR OWN MAP rather than being folded into
   * the object walk: they have no surface to enumerate, and which of them take
   * a tab id cannot be derived from arity — `fn.length` lies for rest and
   * default parameters, the same reason `guardTabActs` refuses a shape check.
   * So they are ruled by name too, and the same existence check applies.
   */
  const DEP_OBJECT_RULINGS = {
    cdp: {
      // detach: page_close detaches before closing, and refusing it would
      // strand an attachment on a tab that is going away. detachAll: takes no
      // tab id at all — it is the kill switch's sweep. attachedTabIds: reports
      // our own bookkeeping and names no tab to act on.
      knowinglyUnguarded: ["detach", "detachAll", "attachedTabIds"],
    },
    pageState: {
      // invalidate: cleanup that must never be refused — a refused
      // invalidation strands a stale map, which is the exact failure the map's
      // own existence is designed to prevent. hasMap: a boolean about our own
      // bookkeeping, touching no page and naming no act.
      knowinglyUnguarded: ["invalidate", "hasMap"],
    },
  };

  const TOP_LEVEL_DEP_RULINGS = {
    // Takes a tab id and acts on it. Both must be wrapped.
    closeTab: "guarded",
    lookup: "guarded",
    // Not guarded, and each for its own reason — none of them "it looked
    // harmless".
    //
    // agentTabUrl / ensureAgentTab RESOLVE an id rather than acting on one.
    // They take no tab id, they return one, and what they return is fresh by
    // construction; guarding them would be guarding the wrong end of the very
    // window this check exists to close.
    agentTabUrl: "takes no tab id — it produces one",
    ensureAgentTab: "takes no tab id — it produces one",
    listAgentTabs: "takes no tab id",
    // switchToTab DOES take a tab id, and is deliberately not wrapped: since
    // F1 it carries its OWN ownership refusal at its set-building site, where
    // it used to adopt whatever it focused. Wrapping it would duplicate a
    // check it already makes and would replace its specific refusal message
    // with the wrapper's generic one.
    switchToTab: "refuses unowned tabs itself, at its own set-building site",
    loadAllowlist: "takes no tab id",
    record: "takes no tab id",
  };

  const isFn = (v) => typeof v === "function";
  /** Every dep that is an object of functions, taken from the real wiring. */
  const depObjects = () =>
    Object.entries(deps).filter(
      ([, v]) => v && typeof v === "object" && Object.values(v).some(isFn)
    );

  // THE ASSERTION THAT WOULD HAVE CAUGHT ALL FOUR ROUNDS OF THIS. Every one of
  // them was a name that existed in the wiring and not in a list beside it.
  it("has a ruling for every dep object in the real wiring", () => {
    expect(depObjects().map(([name]) => name).sort()).toEqual(
      Object.keys(DEP_OBJECT_RULINGS).sort()
    );
  });

  it("has a ruling for every top-level function dep in the real wiring", () => {
    const wired = Object.entries(deps)
      .filter(([, v]) => isFn(v))
      .map(([name]) => name)
      .sort();
    expect(wired).toEqual(Object.keys(TOP_LEVEL_DEP_RULINGS).sort());
  });

  it("guards every top-level dep whose ruling says guarded", () => {
    const guarded = Object.entries(TOP_LEVEL_DEP_RULINGS)
      .filter(([, ruling]) => ruling === "guarded")
      .map(([name]) => name);
    expect(guarded.length).toBeGreaterThan(0);
    for (const name of guarded)
      expect(() => deps[name](4242, 1)).toThrow(/closed while this command/);
  });

  it("guards every tab-taking method on every dep object", () => {
    for (const [depName, surface] of depObjects()) {
      const ruling = DEP_OBJECT_RULINGS[depName];
      // The existence test above owns a missing ruling; without this guard the
      // same failure would surface here as a confusing TypeError instead.
      if (!ruling) continue;

      const methods = Object.keys(surface).filter((n) => isFn(surface[n]));
      expect(methods.length).toBeGreaterThan(0);

      for (const name of methods) {
        expect(
          socket.TAB_ID_ACTS.has(name) ||
            ruling.knowinglyUnguarded.includes(name)
        ).toBe(true);
        // Named in the set is not the same as WIRED through the wrapper —
        // `pageState` was wired raw while every one of its names was already
        // in the set. Called with an id we do not own, it must refuse.
        if (socket.TAB_ID_ACTS.has(name))
          expect(() => surface[name](4242, 1)).toThrow(
            /closed while this command/
          );
      }
    }
  });

  // @edge — the WIRING, not the wrapper. Two mutations survived here: wiring
  // `pageState` raw again, and reaching `lookup` around the wrapper. The socket
  // suite's disclosure tests inject their own wrapped pageState — deliberately,
  // so they test the fix rather than the bug — which means nothing there can
  // see index.js hand over the raw module. This is the only place that can.
  it.each([
    ["capture"],
    ["read"],
    ["lookup"],
  ])("routes pageState.%s through the ownership check", async (name) => {
    const raw = await import("../src/background/pageState.js");
    expect(deps.pageState[name]).not.toBe(raw[name]);
    expect(() => deps.pageState[name](4242, 1)).toThrow(
      /closed while this command/
    );
  });

  // `deps.lookup` is the same reference dispatch reaches as
  // `deps.pageState.lookup`; two wrappers would behave alike while being a
  // wiring bug nobody could see.
  it("hands dispatch one lookup, guarded, by both routes", () => {
    expect(deps.lookup).toBe(deps.pageState.lookup);
    expect(() => deps.lookup(4242, 1)).toThrow(/closed while this command/);
  });

  // The cleanup half stays unwrapped: a refused invalidation strands a stale
  // map, which is the failure the map's existence is designed to prevent.
  it.each([["invalidate"], ["hasMap"]])(
    "leaves pageState.%s unwrapped, so cleanup can never be refused",
    async (name) => {
      const raw = await import("../src/background/pageState.js");
      expect(deps.pageState[name]).toBe(raw[name]);
      expect(() => deps.pageState[name](4242)).not.toThrow();
    }
  );

  // The other direction: no name in the set may be one that guards nothing.
  // This caught `evaluate` in the set's first draft — cdp.js exports it, but
  // the frozen surface does not carry it, so it would have been dead weight
  // that read as protection.
  //
  // Built from the WIRING for the same reason the forward check is: a
  // hand-listed pair of surfaces would stop covering a name the day a third
  // dep supplies it, and the set would quietly go back to being unchecked.
  it("lists no name that is not on some guarded surface", () => {
    const everywhere = new Set([
      ...depObjects().flatMap(([, surface]) => Object.keys(surface)),
      ...Object.entries(deps)
        .filter(([, v]) => isFn(v))
        .map(([name]) => name),
    ]);
    for (const name of socket.TAB_ID_ACTS) expect([...everywhere]).toContain(name);
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

  // Registration is not behaviour. The listener REGISTERED is the exported
  // body, so the cases below invoke that same function with the arguments
  // Chrome passes.
  it("answers the popup's messages", () => {
    expect(listeners.message).toHaveLength(1);
  });

  it("registers the exported bodies, not anonymous copies", () => {
    expect(listeners.startup[0]).toBe(startCompanion);
    expect(listeners.installed[0]).toBe(startCompanion);
    expect(listeners.storage[0]).toBe(onStorageChanged);
    expect(listeners.alarm[0]).toBe(onAlarm);
    expect(listeners.message[0]).toBe(onRuntimeMessage);
  });

  // @edge — THE RETURN VALUE, which is the whole message channel.
  //
  // `control.onMessage` answers `true` so Chrome holds the port open for its
  // async reply. index.js's wrapper must PASS THAT BACK: a wrapper written as a
  // statement rather than a return answers `undefined`, Chrome closes the
  // channel at once, and every popup request resolves `undefined` — a popup
  // stuck on its loading state with no error anywhere and nothing in any log.
  // Asserted through the REGISTERED listener, because that is the function
  // Chrome actually calls.
  it("keeps the message channel open for the popup's async reply", () => {
    expect(
      listeners.message[0]({ type: "companion:getStatus" }, {}, () => {})
    ).toBe(true);
  });

  // The other half: a message that is not ours must be declined, so a second
  // listener added later can answer it. A handler claiming every message would
  // make that one silently unreachable.
  it("declines a message belonging to some other listener", () => {
    expect(listeners.message[0]({ type: "somethingElse" }, {}, () => {})).toBe(
      false
    );
  });

  // @edge — L2. A wake RE-RUNS this module, and by then onStartup/onInstalled
  // have long since fired, so the top-level call is the only thing that
  // rebuilds the socket. Deleting it survived the entire suite, because its
  // effect exists only at module load — which is why this asserts on evidence
  // captured there rather than on anything a test can trigger.
  it("connects at module load, not only from the listeners", () => {
    expect(socketsAtLoad).toHaveLength(1);
    expect(socketsAtLoad[0].url).toBe(
      "wss://boot.test/api/browser-companion/agent-socket"
    );
  });
});

/* ===========================================================================
 * M2 — the listener BODIES, invoked.
 *
 * A review found three mutations surviving a 487-test suite: reading the wrong
 * storage keys (the companion NEVER connects — both values arrive `undefined`
 * and `connect` returns idle without a word), listening on `local` instead of
 * `sync` (saving a key in the popup does nothing), and inverting the alarm-name
 * guard (the keepalive becomes a no-op while every OTHER alarm reconnects). Two
 * of those are total feature failures, not degradations, and the suite asserted
 * only that each listener EXISTED.
 *
 * Invoking a captured listener is not an MV3 lifecycle simulation — it is a
 * function call, and it is the whole difference between "the wiring is there"
 * and "the wiring works". What is still NOT modelled: whether Chrome delivers
 * these events at all, and when.
 * ======================================================================== */
describe("the listener bodies actually do their job", () => {
  beforeEach(async () => {
    await settle();
    sockets = [];
    syncStore = {};
    socket.__reset();
    // The pause is module state in the worker, so a case that leaves it set
    // would silently pause every case after it — and the "lets a command
    // through" negative control would then be asserting against a paused
    // browser and pass for the wrong reason.
    control.__reset();
  });

  it("reads the storage keys the popup actually writes", async () => {
    // Asserted against the exported constant AND against behaviour, so a
    // rename that misses one of the two cannot pass.
    expect([...CONFIG_KEYS]).toEqual(["apiBase", "apiKey"]);

    syncStore.apiBase = "https://x.test/api";
    syncStore.apiKey = "brx-abc";
    await startCompanion();
    await settle();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe(
      "wss://x.test/api/browser-companion/agent-socket"
    );
  });

  it("stays idle, without throwing, when nothing is configured yet", async () => {
    await startCompanion();
    await settle();
    expect(sockets).toHaveLength(0);
    expect(socket.state().status).toBe("idle");
  });

  // @edge — a rejected `storage.sync.get` (offline profile, disabled sync
  // account) would otherwise be an unhandled rejection in the service worker,
  // leaving no trace anywhere the user can see.
  it("survives storage.sync being unavailable", async () => {
    const realGet = globalThis.chrome.storage.sync.get;
    globalThis.chrome.storage.sync.get = async () => {
      throw new Error("sync unavailable");
    };
    await expect(startCompanion()).resolves.toBeUndefined();
    globalThis.chrome.storage.sync.get = realGet;
    expect(sockets).toHaveLength(0);
  });

  it("reconnects when the popup writes a key to sync", async () => {
    syncStore.apiBase = "https://x.test/api";
    syncStore.apiKey = "brx-abc";
    onStorageChanged({ apiKey: { newValue: "brx-abc" } }, "sync");
    await settle();
    expect(sockets).toHaveLength(1);
  });

  it("reconnects when only the server address changes", async () => {
    syncStore.apiBase = "https://x.test/api";
    syncStore.apiKey = "brx-abc";
    onStorageChanged({ apiBase: { newValue: "https://x.test/api" } }, "sync");
    await settle();
    expect(sockets).toHaveLength(1);
  });

  // @edge — the area check. `local` is where the allowlist and the audit log
  // live, and both change constantly during ordinary agent work; reconnecting
  // on those would rebuild the socket on every recorded command.
  it("ignores changes in the local area", async () => {
    syncStore.apiBase = "https://x.test/api";
    syncStore.apiKey = "brx-abc";
    onStorageChanged({ apiKey: { newValue: "brx-abc" } }, "local");
    await settle();
    expect(sockets).toHaveLength(0);
  });

  it("ignores a sync change to some unrelated key", async () => {
    syncStore.apiBase = "https://x.test/api";
    syncStore.apiKey = "brx-abc";
    onStorageChanged({ theme: { newValue: "dark" } }, "sync");
    await settle();
    expect(sockets).toHaveLength(0);
  });

  // @edge — L3. `keepalive()` returning false is its documented cold-wake
  // signal: the worker woke with no config, so the config has to come from
  // storage, which is index.js's job and not socket.js's.
  it("re-reads storage when the alarm wakes a cold worker", async () => {
    syncStore.apiBase = "https://x.test/api";
    syncStore.apiKey = "brx-abc";
    expect(socket.keepalive()).toBe(false); // cold: no config in the module
    onAlarm({ name: socket.KEEPALIVE_ALARM });
    await settle();
    expect(sockets).toHaveLength(1);
  });

  // @edge — the alarm-name guard, inverted, made the keepalive a no-op while
  // every other alarm triggered a reconnect. Both halves are asserted.
  it("does nothing for an alarm that is not the keepalive", async () => {
    syncStore.apiBase = "https://x.test/api";
    syncStore.apiKey = "brx-abc";
    onAlarm({ name: "someOtherExtensionAlarm" });
    await settle();
    expect(sockets).toHaveLength(0);
  });

  it("does nothing for a malformed alarm", async () => {
    syncStore.apiBase = "https://x.test/api";
    syncStore.apiKey = "brx-abc";
    onAlarm(undefined);
    onAlarm({});
    await settle();
    expect(sockets).toHaveLength(0);
  });

  // @edge — THE PAUSE MUST BE ON THE SOCKET'S OWN COMMAND PATH.
  //
  // Found by a mutation, not by reading: replacing
  // `control.guardCommands((command) => handle(command, deps))` with a bare
  // `(command) => handle(command, deps)` SURVIVED a green suite. That single
  // edit makes the popup's stop button decorative — it still flips the
  // worker's flag, the popup still renders "paused", and the agent keeps
  // clicking, because nothing on the command path reads the flag any more.
  // Nothing in control.test.js can catch it: `guardCommands` is correct there
  // in isolation. Only this file sees the wiring.
  //
  // Driven through the REAL socket path — a frame delivered to `ws.onmessage`,
  // exactly as the server would — rather than by inspecting what `connect` was
  // handed, so the assertion is about what a command actually does.
  it("routes the socket's commands through the pause", async () => {
    syncStore.apiBase = "https://x.test/api";
    syncStore.apiKey = "brx-abc";
    await startCompanion();
    await settle();
    expect(sockets).toHaveLength(1);
    const ws = sockets[0];
    ws.readyState = 1; // OPEN, so a reply is actually written.

    await control.setPaused(true);
    ws.onmessage({
      data: JSON.stringify({ requestId: "r_paused", cmd: "page_click" }),
    });
    await socket.__commandQueue();
    await settle();

    const replies = ws.sent.map((raw) => JSON.parse(raw));
    expect(replies).toHaveLength(1);
    expect(replies[0].requestId).toBe("r_paused");
    expect(replies[0].ok).toBe(false);
    expect(replies[0].error).toMatch(/paused/i);

    await control.setPaused(false);
  });

  // NEGATIVE CONTROL for the case above. Without it, a `guardCommands` that
  // refused unconditionally — or any wiring that broke the command path
  // outright — would satisfy the paused assertion while the browser did
  // nothing at all. An unpaused command must reach dispatch and be answered on
  // its own terms.
  it("lets a command through when nothing is paused", async () => {
    syncStore.apiBase = "https://x.test/api";
    syncStore.apiKey = "brx-abc";
    await startCompanion();
    await settle();
    const ws = sockets[0];
    ws.readyState = 1;

    ws.onmessage({
      data: JSON.stringify({ requestId: "r_live", cmd: "page_click" }),
    });
    await socket.__commandQueue();
    await settle();

    const replies = ws.sent.map((raw) => JSON.parse(raw));
    expect(replies).toHaveLength(1);
    expect(replies[0].requestId).toBe("r_live");
    // It is DENIED — the allowlist is empty in this double, which is the
    // correct default-deny — but denied by the GATE, not by the pause. The two
    // are told apart by the message, which is the only thing distinguishing
    // "the user stopped me" from "that domain is not allowed".
    expect(replies[0].ok).toBe(false);
    expect(replies[0].error).not.toMatch(/paused/i);
  });

  // @edge — a warm worker must be PINGED, not reconnected: rebuilding a live
  // socket on every keepalive tick would drop the connection every 15 seconds.
  it("pings instead of reconnecting when the socket is already live", async () => {
    syncStore.apiBase = "https://x.test/api";
    syncStore.apiKey = "brx-abc";
    await startCompanion();
    await settle();
    expect(sockets).toHaveLength(1);
    sockets[0].readyState = 1; // OPEN

    onAlarm({ name: socket.KEEPALIVE_ALARM });
    await settle();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent.map((raw) => JSON.parse(raw))).toEqual([
      { event: "ping" },
    ]);
  });
});

/* ===========================================================================
 * WHO REACHES A TAB ACT WITHOUT GOING THROUGH `deps`.
 *
 * The walk above derives its deps from `deps`, so it can only see acts that
 * arrive that way. The HIGH the reviewer found did NOT: `pageState.js` imports
 * `evaluate` straight from cdp.js, so `page_read` reached `Runtime.evaluate` on
 * a captured id with no act-time check, and no test in this repo could see it.
 * That import is still there — correctly, now that its two callers are guarded
 * at the wiring — and so are three others. All four are right TODAY. So was the
 * wiring, right up until pageState grew a second caller.
 *
 * Same shape as the deps walk, one level out: the IMPORTERS are derived from
 * the source, the JUDGEMENT stays in a literal, and an importer with no ruling
 * fails.
 *
 * WHY A REGEX AND NOT A PARSER, since a source-level check is a fair thing to
 * distrust. `@babel/parser` resolves here — I checked, it imports and parses
 * under this jest config — but only as a hoisted transitive of jest: it is in
 * no package.json, and a test that depends on someone else's dependency tree
 * is a test that breaks on an unrelated upgrade. It cannot be added properly
 * without an install, and this worktree does not get one.
 *
 * What makes the regex sound enough here is the direction of its failures:
 *
 *   - ANCHORED TO THE LINE START (`^\s*import` / `^\s*export`). An import
 *     declaration must be a top-level statement, while a mention inside a
 *     comment is preceded by `//` or ` *` — which is why the four prose
 *     mentions of "cdp.js" in socket.js and index.js do not match. Driven both
 *     ways: `// import { click } from "./cdp.js";` stays green, and a BLOCK
 *     comment whose inner line starts with the bare keyword reds.
 *   - THAT FALSE POSITIVE DEMANDS A RULING, which is noisy, visible and
 *     harmless — a commented-out import is a thing worth being asked about
 *     anyway. A false negative is the dangerous direction, and reaching it
 *     needs an import written in a form this misses.
 *   - Those forms are enumerable and two are covered: `import ... from`,
 *     `export ... from`, and `import("./cdp.js")` with a literal specifier.
 *
 * WHAT IT STILL CANNOT SEE, so nobody inherits it as a guarantee:
 *   - `import(expr)` where the specifier is computed. Nothing in this codebase
 *     does that, and it would be a strange way to reach a debugger surface.
 *   - RE-EXPORT LAUNDERING: module A imports a tab act and re-exports it,
 *     module B imports A. B's edge is invisible here. That is exactly
 *     pageState's own shape, which is why pageState.js is treated as a
 *     supplier below and not only as an importer — one more hop is covered,
 *     not all of them.
 * ======================================================================== */
const BACKGROUND_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src/background"
);

/**
 * The modules that hand out an act on a specific tab.
 *
 * `pageState.js` is here as well as `cdp.js` because it re-exposes the same
 * capability under different names — `capture` and `read` ARE `Runtime.evaluate`
 * with a wrapper — and it is the module that produced the disclosure.
 */
const TAB_ACT_SUPPLIERS = ["cdp.js", "pageState.js"];

/** `importer.js -> supplier.js` for every direct import in src/background. */
function directImportEdges() {
  const edges = [];
  for (const file of readdirSync(BACKGROUND_DIR).filter((f) => f.endsWith(".js"))) {
    const source = readFileSync(path.join(BACKGROUND_DIR, file), "utf8");
    for (const supplier of TAB_ACT_SUPPLIERS) {
      if (file === supplier) continue; // a module importing itself is not an edge
      const spec = `\\./${supplier.replace(".", "\\.")}`;
      const statement = new RegExp(
        `^\\s*(?:import|export)\\s+([^;\'"]*?)\\s+from\\s+["']${spec}["']`,
        "gm"
      );
      const dynamic = new RegExp(`^\\s*.*\\bimport\\(\\s*["']${spec}["']`, "gm");
      for (const m of source.matchAll(statement))
        edges.push({ importer: file, supplier, clause: m[1].trim() });
      for (const _ of source.matchAll(dynamic))
        edges.push({ importer: file, supplier, clause: "<dynamic import>" });
    }
  }
  return edges;
}

const edgeKey = (e) => `${e.importer} -> ${e.supplier}`;

/**
 * Why each importer is allowed to bypass `deps`, and WHAT it may take.
 *
 * `clause` is the import clause verbatim, so a ruled importer that grows a
 * SECOND tab-taking import fails here too. That distinction is the whole
 * finding: pageState.js's edge was fine when `evaluate` had one caller and
 * became a disclosure when it had two.
 */
const BYPASS_RULINGS = {
  // The wiring itself. index.js is where `guardTabActs` is applied, so it must
  // hold the raw surfaces to wrap them — an index.js that could not import
  // cdp.js could not guard it.
  "index.js -> cdp.js": {
    clause: "{ cdp }",
    why: "the wiring: it imports the raw surface in order to wrap it",
  },
  "index.js -> pageState.js": {
    clause: "* as pageState",
    why: "the wiring: wrapped once into guardedPageState and used for both routes",
  },
  // dispatch.js fills in real implementations for anything a caller did not
  // inject, and merges rather than replaces, so an injected `deps.cdp` wins.
  // In production index.js injects the guarded surfaces, so these defaults are
  // reached only by tests that supply none.
  "dispatch.js -> cdp.js": {
    clause: "{ cdp as realCdp }",
    why: "withDefaults: a fallback the real wiring always overrides by injection",
  },
  "dispatch.js -> pageState.js": {
    clause: "* as realPageState",
    why: "withDefaults: same fallback, same override",
  },
  // THE ONE THAT PRODUCED THE HIGH, stated plainly rather than softened.
  // pageState.js reaches `Runtime.evaluate` through this import instead of
  // through the frozen `cdp` surface, which is precisely why `capture` and
  // `read` were invisible to a set checked against that surface, and why
  // `page_read` returned a non-allowlisted page's text to the server.
  //
  // The import is not the fix's target and was never removed: pageState needs
  // evaluate. What changed is that its two callers are now guarded AT THE
  // WIRING, where index.js runs them through guardTabActs. So this edge is
  // allowed on the condition that it takes `evaluate` AND NOTHING ELSE — a
  // second tab-taking name here would be a second unguarded path, and the
  // clause comparison below is what makes that condition executable rather
  // than a hope.
  "pageState.js -> cdp.js": {
    clause: "{ evaluate }",
    why: "the disclosure's origin: allowed only because its callers are guarded at the wiring, and only for evaluate",
  },
  // FOUND BY THIS CHECK ON ITS FIRST RUN, which is the point of writing it.
  // socket.js reaches pageState for ONE call: `handleTabRemoved` invalidates
  // the element map when a tab goes away. That is cleanup on a tab that is
  // already gone — the same name ruled knowingly-unguarded on the pageState
  // surface above, for the same reason: a refused invalidation strands a stale
  // map, which is the exact failure the map's existence prevents. Routing it
  // through `deps` would also be a cycle, since index.js imports socket.js to
  // build them.
  "socket.js -> pageState.js": {
    clause: "* as pageState",
    why: "handleTabRemoved's invalidate only: cleanup on a tab already gone, and never refusable",
  },
  // control.js is the kill switch. `detachAll` takes no tab id at all and
  // `attachedTabIds` names none — neither is an act on a specific tab, which
  // is the same reason both are ruled knowingly-unguarded on the cdp surface
  // above. Routing them through `deps` would put the user's stop button behind
  // the socket wiring, which is the thing most likely to be broken when
  // someone reaches for it.
  "control.js -> cdp.js": {
    clause: "{ attachedTabIds, detachAll }",
    why: "the kill switch: neither name takes a tab id, and it must work when the wiring does not",
  },
};

describe("direct imports of the tab-act suppliers", () => {
  // Guards the instrument. A regex that matched nothing would make every
  // assertion below vacuously true — the quietest way for this to stop testing
  // anything — and this check exists precisely because a silent pass is what
  // the disclosure looked like.
  it("finds the direct imports that are known to exist", () => {
    const keys = directImportEdges().map(edgeKey);
    expect(keys).toContain("pageState.js -> cdp.js");
    expect(keys).toContain("control.js -> cdp.js");
    expect(keys.length).toBeGreaterThanOrEqual(6);
  });

  // Does NOT match the four prose mentions of cdp.js in socket.js/index.js.
  // If line-anchoring ever stops holding, this is where it shows.
  // socket.js mentions cdp.js four times in prose and imports it zero times.
  // A first draft of this test asserted socket.js was not an importer AT ALL,
  // which is false — it imports pageState.js — and this check caught it. The
  // narrower claim is the true one, and is what line-anchoring actually buys.
  it("does not mistake a comment mentioning cdp.js for an import", () => {
    const cdpImporters = directImportEdges()
      .filter((e) => e.supplier === "cdp.js")
      .map((e) => e.importer);
    expect(cdpImporters).not.toContain("socket.js");
  });

  it("has a ruling for every direct import of a tab-act supplier", () => {
    expect(directImportEdges().map(edgeKey).sort()).toEqual(
      Object.keys(BYPASS_RULINGS).sort()
    );
  });

  // The clause, not just the edge: a ruled importer that grows a second
  // tab-taking import is the pageState shape repeating.
  it("takes from each supplier exactly what its ruling allows", () => {
    for (const edge of directImportEdges()) {
      const ruling = BYPASS_RULINGS[edgeKey(edge)];
      if (!ruling) continue; // owned by the test above
      expect(edge.clause).toBe(ruling.clause);
    }
  });

  // A ruling is judgement, and judgement about an import that no longer exists
  // is a comment that reads as protection. Same both-directions discipline as
  // the deps walk.
  it("keeps no ruling for an import that no longer exists", () => {
    const keys = new Set(directImportEdges().map(edgeKey));
    for (const ruled of Object.keys(BYPASS_RULINGS)) expect(keys).toContain(ruled);
  });

  it("gives every ruling a stated reason", () => {
    for (const [key, ruling] of Object.entries(BYPASS_RULINGS)) {
      expect(typeof ruling.why).toBe("string");
      expect(ruling.why.length).toBeGreaterThan(20);
      expect(key).toMatch(/^[\w.]+\.js -> [\w.]+\.js$/);
    }
  });
});
