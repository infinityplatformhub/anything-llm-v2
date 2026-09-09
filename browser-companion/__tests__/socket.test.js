import { describe, it, expect, beforeEach, jest as j } from "@jest/globals";

/* ===========================================================================
 * WHAT THIS FILE DOUBLES, AND — MORE IMPORTANTLY — WHAT IT DOES NOT
 *
 * FOUR doubles, all four hand-written in this file:
 *
 *   1. WebSocket  — FakeSocket below. It models: the readyState ladder
 *      (CONNECTING 0 / OPEN 1 / CLOSING 2 / CLOSED 3), the browser's rule that
 *      `send()` on a CLOSING or CLOSED socket SILENTLY DISCARDS the frame
 *      rather than throwing (per spec; only CONNECTING throws), close codes
 *      arriving on the close event, a server frame arriving at any moment, and
 *      a constructor that can be made to throw. Every case that matters drives
 *      these transitions by hand rather than assuming a socket that opens and
 *      stays open: a fake that always opens and never errors would make a
 *      broken client look perfect, which is the exact failure this comment
 *      exists to stop.
 *
 *   2. chrome.alarms — records create/clear calls with their periods, so the
 *      sub-minute limitation is asserted on a real value rather than trusted.
 *
 *   3. chrome.tabs — a real little tab table with ids, urls and titles, so
 *      `create`/`get`/`query`/`update`/`remove` actually change state and a
 *      closed tab actually makes `get` reject. A stub returning a fixed tab
 *      could not produce the close-between-gate-and-action race at all, which
 *      is the sharpest thing this file has to prove.
 *
 *   4. chrome.storage — local (audit log, allowlist) and sync (config), backed
 *      by a plain object, with an injectable failure so a rejected write is a
 *      state this file can actually reach.
 *
 * NOT MODELLED — a green run here is NOT evidence about any of these:
 *   * The real WebSocket HANDSHAKE. Nothing here speaks HTTP, so whether the
 *     server accepts `["anythingllm-browser-companion", key]`, whether `ws`
 *     really echoes only the first offered subprotocol, and whether a browser
 *     rejects a mismatched response are all UNVERIFIED here. What IS verified
 *     is the argument this client passes and its ORDER — which is the half this
 *     module owns. The other half is asserted against the server source
 *     (server/endpoints/browserExtension.js) by reading it, not by running it.
 *   * Whether Chrome honours a sub-minute alarm period. The test asserts the
 *     period this module REQUESTS and that it is under the documented 1-minute
 *     packed-extension floor; whether Chrome clamps it is Chrome's behaviour and
 *     is the reason the constant carries a shipping-blocker comment.
 *   * The MV3 teardown itself. A worker being killed mid-command is simulated
 *     by dropping the socket, NOT by tearing down the module — real teardown
 *     also loses `setTimeout`, the module state, and the alarm's next tick, and
 *     nothing here reproduces that.
 *   * The real CDP layer, the real allowlist storage, and the real dispatcher.
 *     `onCommand` is a spy in most cases; where the coupling with the real
 *     `dispatch.handle` is the point, the real one is imported and used.
 *   * `chrome.storage.sync` quota and cross-device propagation.
 * ======================================================================== */

/* --------------------------------------------------------------------------
 * chrome + WebSocket doubles. Installed BEFORE the import, because cdp.js —
 * reached through dispatch.js — registers a debugger listener at module load,
 * and ESM hoists static imports above every statement. Hence the dynamic
 * import at the bottom of this block.
 * ----------------------------------------------------------------------- */

/** Every socket the module has constructed, oldest first. */
let sockets = [];
/** Set to an Error to make the next `new WebSocket(...)` throw. */
let constructorThrows = null;
/** What chrome.debugger.sendCommand resolves as its evaluated value. */
let evaluateResult = null;

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, protocols) {
    if (constructorThrows) {
      const error = constructorThrows;
      constructorThrows = null;
      throw error;
    }
    this.url = url;
    this.protocols = protocols;
    this.readyState = FakeSocket.CONNECTING;
    /** Frames the client wrote AND that were not silently discarded. */
    this.sent = [];
    /** Frames the client attempted to write while not OPEN. */
    this.discarded = [];
    this.closeCalls = [];
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    sockets.push(this);
  }

  /**
   * The browser rule this fake exists to enforce: per the WHATWG spec, `send`
   * on a CLOSING or CLOSED socket discards the data and does NOT throw. Only
   * CONNECTING throws (InvalidStateError). A fake that threw on a dead socket
   * would let a client with no readyState guard pass by accident.
   */
  send(frame) {
    if (this.readyState === FakeSocket.CONNECTING) {
      throw new Error("InvalidStateError: still CONNECTING");
    }
    if (this.readyState !== FakeSocket.OPEN) {
      this.discarded.push(frame);
      return;
    }
    this.sent.push(frame);
  }

  close(code, reason) {
    this.closeCalls.push({ code, reason });
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSING;
  }

  /* ---- server-side pokes, used by the tests ---- */

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.({});
  }

  deliver(message) {
    this.onmessage?.({
      data: typeof message === "string" ? message : JSON.stringify(message),
    });
  }

  fail() {
    this.onerror?.({});
  }

  /** Close from the server's side, with a code the client must interpret. */
  serverClose(code, reason = "") {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  /** The frames the client actually got onto the wire, parsed. */
  frames() {
    return this.sent.map((raw) => JSON.parse(raw));
  }
}

/* ---- chrome.tabs: a real little tab table ---- */
let tabs;
let nextTabId;
let tabCreateCalls;
/** onRemoved listeners the module registered at load. */
const tabRemovedListeners = [];

function makeTabs() {
  tabs = new Map();
  nextTabId = 1;
  tabCreateCalls = [];
  return {
    async create({ url, active }) {
      const id = nextTabId++;
      tabCreateCalls.push({ url, active });
      tabs.set(id, { id, url, title: "" });
      return tabs.get(id);
    },
    async get(id) {
      // The real API rejects for a tab that is gone; a stub that returned
      // undefined would let a client that never checks look correct.
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
      return tabs.get(id);
    },
    async query() {
      return [...tabs.values()];
    },
    async update(id, patch) {
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
      const tab = tabs.get(id);
      // Models Chrome's real navigation shape: `update({url})` does NOT change
      // `url` synchronously — it sets `pendingUrl` to the destination and
      // leaves `url` on the old value until the navigation commits. A double
      // that swapped `url` immediately would make a mid-navigation tab
      // indistinguishable from a settled one, and no test could then see a tab
      // being closed out from under its own navigation.
      const { url, ...rest } = patch;
      Object.assign(tab, rest);
      if (url !== undefined) tab.pendingUrl = url;
      return tab;
    },
    /** Test-only: let a pending navigation commit. */
    __commit(id) {
      const tab = tabs.get(id);
      if (tab?.pendingUrl) {
        tab.url = tab.pendingUrl;
        delete tab.pendingUrl;
      }
    },
    async remove(id) {
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
      tabs.delete(id);
      // Chrome fires onRemoved for EVERY removal, including ones the extension
      // asked for. A double that fired only for user-initiated closes would
      // hide a listener that double-handles its own `closeTab`.
      fireTabRemoved(id);
    },
    onRemoved: {
      addListener: (fn) => tabRemovedListeners.push(fn),
    },
  };
}

/**
 * Close a tab the way the USER does: Chrome removes it and fires onRemoved,
 * with nothing in the extension having asked.
 *
 * Tests previously modelled this as a bare `tabs.delete(id)`, which is the
 * silent half only — and silence is precisely what F1-R was about. Going
 * through this helper means a test cannot accidentally assert against a world
 * where Chrome never told the extension anything.
 */
function userClosesTab(id) {
  tabs.delete(id);
  fireTabRemoved(id);
}

function fireTabRemoved(id) {
  for (const fn of tabRemovedListeners) fn(id, { isWindowClosing: false });
}

/* ---- chrome.alarms ---- */
let alarmCreates;
let alarmClears;

/* ---- chrome.storage ---- */
let localStore;
let syncStore;
/** Set to an Error to make every `storage.local.set` reject. */
let localSetFails;
/** Set to an Error to make every `storage.local.remove` reject. */
let localRemoveFails;
/** Set to an Error to make `storage.sync.get` reject. */
let syncGetFails;

globalThis.WebSocket = FakeSocket;
globalThis.chrome = {
  tabs: makeTabs(),
  alarms: {
    create: (name, info) => alarmCreates.push({ name, info }),
    clear: (name) => alarmClears.push(name),
    onAlarm: { addListener: () => {} },
  },
  runtime: {
    onStartup: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
  },
  debugger: {
    onDetach: { addListener: () => {} },
    attach: async () => {},
    detach: async () => {},
    // Injectable so a test can capture a real element map. Default null keeps
    // every other case exactly as it was.
    sendCommand: async () => ({ result: { value: evaluateResult } }),
  },
  storage: {
    local: {
      async get(keys) {
        const out = {};
        for (const key of [].concat(keys))
          if (key in localStore) out[key] = localStore[key];
        return out;
      },
      async set(patch) {
        if (localSetFails) throw localSetFails;
        Object.assign(localStore, patch);
      },
      async remove(keys) {
        if (localRemoveFails) throw localRemoveFails;
        for (const key of [].concat(keys)) delete localStore[key];
      },
    },
    sync: {
      async get(keys) {
        if (syncGetFails) throw syncGetFails;
        const out = {};
        for (const key of [].concat(keys))
          if (key in syncStore) out[key] = syncStore[key];
        return out;
      },
    },
    onChanged: { addListener: () => {} },
  },
};

const socket = await import("../src/background/socket.js");
const { handle } = await import("../src/background/dispatch.js");
const auditLog = await import("../src/background/auditLog.js");
const { STORAGE_KEY: ALLOWLIST_KEY } = await import(
  "../src/background/allowlist.js"
);

/** Let every already-resolved promise settle. */
/**
 * Let every already-resolved promise settle.
 *
 * `setImmediate`, not a spin of `await Promise.resolve()`. The durable terminal
 * write goes through `crypto.subtle.digest`, which is a REAL async primitive
 * resolving on a later macrotask — spinning microtasks cannot drain it however
 * many turns you spin, and the write silently had not happened yet. That
 * produced a failure reading as "the module never wrote the verdict" when the
 * truth was "the assertion ran too early", which is exactly the kind of false
 * signal that sends a debugging session at the wrong file.
 */
const flush = async () => {
  for (let i = 0; i < 3; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

/**
 * Wait for a condition rather than for a fixed number of turns.
 *
 * Used where the thing being awaited is a real async chain of unspecified
 * length (`crypto.subtle.digest` and the storage write behind it). A fixed
 * flush there is a race that passes on a fast machine and fails on a slow one,
 * and the failure reads as a missing feature rather than as an early
 * assertion. Throws on timeout, so a condition that never becomes true is a
 * loud failure and never a silent pass.
 *
 * IT SPINS `setImmediate`, SO IT DOES NOT ADVANCE TIMERS. Every current use
 * site waits on a storage write, where the primitive matches. A condition that
 * only becomes true once a `setTimeout` fires — real or faked — will never be
 * seen here and will time out after the full 200 turns; use fake timers and
 * `advanceTimersByTime` for that instead.
 */
const waitFor = async (predicate, label = "condition") => {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`waitFor: ${label} never became true`);
};

// The durable terminal write is fire-and-forget through `crypto.subtle`, so it
// can land AFTER the test that triggered it has finished. A synchronous
// `beforeEach` would then reset `localStore` and the late write would drop the
// verdict into the NEXT test's store — where it silently blocks `connect` and
// the failure reads as "the module refused to build a socket" in a test that
// never mentioned a terminal close. Draining first is what keeps each case
// measuring its own setup rather than the previous one's leftovers.
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  sockets = [];
  constructorThrows = null;
  globalThis.chrome.tabs = makeTabs();
  alarmCreates = [];
  alarmClears = [];
  localStore = {};
  syncStore = {};
  localSetFails = null;
  evaluateResult = null;
  localRemoveFails = null;
  syncGetFails = null;
  auditLog.resetWriteFailure();
  socket.__reset();
});

/**
 * Open a tab the way the AGENT does, and put it on `url`.
 *
 * Deliberately goes through `ensureAgentTab` + `chrome.tabs.update` rather than
 * calling `chrome.tabs.create` directly or poking `createdTabIds`. Since F1,
 * "the agent opened it" is a real capability boundary — a tab created directly
 * is a USER's tab and the module must refuse to adopt it. A helper that
 * fabricated membership would quietly re-grant exactly the capability F1
 * removed, and every test built on it would then be asserting against a state
 * production can never reach.
 *
 * @returns {Promise<number>} the tab id
 */
async function agentOpenedTab(url = "about:blank") {
  const id = await socket.ensureAgentTab();
  if (url !== "about:blank") {
    await chrome.tabs.update(id, { url });
    globalThis.chrome.tabs.__commit(id);
  }
  return id;
}

/**
 * Stage a SECOND tab the agent owns.
 *
 * Worth being blunt about what this models. `ensureAgentTab` reuses the one tab
 * the module holds, so after F1 there is no production path that gives the
 * agent two live tabs at once — which means `page_switch` currently has at most
 * one tab it could ever switch to. That is a real consequence of restricting
 * the agent to its own tabs, it is reported rather than papered over, and it is
 * a product call about whether page_switch should still exist.
 *
 * These tests still cover the two-tab shape, because the ownership rules must
 * be right if such a path is ever added, and because getting them right is what
 * stops the next person adding one from re-opening F1. The staging is the
 * honest minimum: the module's handle on the current tab is dropped while the
 * tab itself stays open and stays in `createdTabIds`, which is exactly the
 * state a second agent tab would produce.
 */
async function stageSecondAgentTab(url) {
  const previous = await socket.ensureAgentTab();
  socket.__forgetCurrentTab();
  const next = await agentOpenedTab(url);
  return { previous, next };
}

/** Connect and get the socket the module just built, opened. */
async function connectAndOpen(overrides = {}) {
  const onCommand = overrides.onCommand ?? j.fn(async () => ({ ok: true }));
  await socket.connect({
    apiBase: "https://x.test/api",
    apiKey: "brx-abc",
    onCommand,
    ...overrides,
  });
  const ws = sockets.at(-1);
  ws.open();
  return { ws, onCommand };
}

/* ========================================================================= */
describe("socketUrlFor / wsUrlFor", () => {
  it("upgrades https to wss and keeps the api path", () => {
    expect(socket.socketUrlFor("https://workspace.approof.studio/api")).toBe(
      "wss://workspace.approof.studio/api/browser-companion/agent-socket"
    );
  });

  it("upgrades http to ws for a local server", () => {
    expect(socket.socketUrlFor("http://localhost:3001/api")).toBe(
      "ws://localhost:3001/api/browser-companion/agent-socket"
    );
  });

  it("tolerates a trailing slash on apiBase", () => {
    expect(socket.socketUrlFor("https://x.test/api/")).toBe(
      "wss://x.test/api/browser-companion/agent-socket"
    );
  });

  // @edge — without re-adding the slash, `new URL(path, ".../api")` resolves
  // against the PARENT of /api and the api prefix silently disappears.
  it("keeps a multi-segment base path instead of resolving above it", () => {
    expect(socket.socketUrlFor("https://x.test/anything/llm/api")).toBe(
      "wss://x.test/anything/llm/api/browser-companion/agent-socket"
    );
  });

  it("throws on a malformed apiBase instead of building a broken url", () => {
    expect(() => socket.socketUrlFor("not a url")).toThrow();
  });

  // @edge — this is the WHOLE POINT of the subprotocol transport: the URL that
  // reaches every proxy access log must not carry the credential.
  it("puts no credential in the url the connection is opened with", async () => {
    await socket.connect({
      apiBase: "https://x.test/api",
      apiKey: "brx-secret-value",
      onCommand: async () => ({}),
    });
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).not.toContain("brx-secret-value");
    expect(sockets[0].url).not.toContain("key=");
  });

  // The deprecated fallback still has to encode rather than concatenate.
  it("url-encodes the key in the deprecated query form", () => {
    expect(wsQuery("brx-a b&c")).toContain("key=brx-a+b%26c");
    expect(wsQuery("brx-a b&c")).not.toContain("&c=");
  });

  it("omits the query parameter entirely when given no key", () => {
    expect(socket.wsUrlFor("https://x.test/api")).toBe(
      "wss://x.test/api/browser-companion/agent-socket"
    );
  });
});

const wsQuery = (key) => socket.wsUrlFor("https://x.test/api", key);

/* ========================================================================= */
describe("the handshake", () => {
  // @edge — MARKER FIRST. `ws` echoes back only the FIRST offered subprotocol,
  // so a key in position 0 would be echoed in the handshake RESPONSE header —
  // moving the leak rather than closing it — and the browser would then refuse
  // the connection because it never offered what the server answered with.
  it("offers the marker first and the key second", async () => {
    await socket.connect({
      apiBase: "https://x.test/api",
      apiKey: "brx-abc",
      onCommand: async () => ({}),
    });
    expect(sockets[0].protocols).toEqual([
      "anythingllm-browser-companion",
      "brx-abc",
    ]);
    expect(sockets[0].protocols[0]).toBe(socket.COMPANION_SUBPROTOCOL);
    expect(sockets[0].protocols[1]).toBe("brx-abc");
  });

  it("uses the exact marker the server matches on", () => {
    expect(socket.COMPANION_SUBPROTOCOL).toBe("anythingllm-browser-companion");
    expect(socket.SOCKET_PATH).toBe("browser-companion/agent-socket");
  });

  // @edge — a key with a space or a comma cannot travel as a subprotocol token;
  // the WebSocket constructor throws a bare SyntaxError naming nothing.
  it.each([
    ["a space", "brx-a b"],
    ["a comma", "brx-a,b"],
    ["a quote", 'brx-a"b'],
    ["empty after the prefix", "brx- "],
  ])("refuses a key carrying %s rather than throwing from the constructor", async (_label, key) => {
    await socket.connect({
      apiBase: "https://x.test/api",
      apiKey: key,
      onCommand: async () => ({}),
    });
    expect(sockets).toHaveLength(0);
    expect(socket.state().status).toBe("idle");
    expect(socket.state().lastError).toMatch(/subprotocol cannot carry/);
  });

  it("does not open a socket without both an apiBase and an apiKey", async () => {
    await socket.connect({ apiBase: "", apiKey: "brx-abc", onCommand: async () => ({}) });
    await socket.connect({ apiBase: "https://x.test/api", apiKey: "", onCommand: async () => ({}) });
    await socket.connect({ onCommand: async () => ({}) });
    expect(sockets).toHaveLength(0);
    expect(socket.state().status).toBe("idle");
  });

  it("reports a malformed apiBase instead of leaving the worker in connecting", async () => {
    await socket.connect({
      apiBase: "not a url",
      apiKey: "brx-abc",
      onCommand: async () => ({}),
    });
    expect(sockets).toHaveLength(0);
    expect(socket.state().status).toBe("idle");
    expect(socket.state().lastError).toMatch(/not a valid AnythingLLM server address/);
  });

  // @edge — a constructor that throws after `status = "connecting"` and after
  // the alarm was armed would leave a browser that shows as busy forever.
  it("recovers when the WebSocket constructor itself throws", async () => {
    constructorThrows = new Error("SecurityError");
    await socket.connect({
      apiBase: "https://x.test/api",
      apiKey: "brx-abc",
      onCommand: async () => ({}),
    });
    expect(socket.state().status).toBe("idle");
    expect(socket.state().lastError).toMatch(/SecurityError/);
    expect(alarmClears).toContain(socket.KEEPALIVE_ALARM);
  });

  // @edge — index.js calls startCompanion from five places (load, onStartup,
  // onInstalled, a storage change, the alarm). Without the guard that is five
  // sockets, of which the server routes to exactly one.
  it("does not open a second socket for the same config", async () => {
    const { ws } = await connectAndOpen();
    await socket.connect({
      apiBase: "https://x.test/api",
      apiKey: "brx-abc",
      onCommand: async () => ({}),
    });
    expect(sockets).toHaveLength(1);
    expect(sockets[0]).toBe(ws);
  });

  it("replaces the socket when the config changes", async () => {
    const { ws } = await connectAndOpen();
    await socket.connect({
      apiBase: "https://y.test/api",
      apiKey: "brx-abc",
      onCommand: async () => ({}),
    });
    expect(sockets).toHaveLength(2);
    expect(ws.closeCalls).toHaveLength(1);
    expect(sockets[1].url).toContain("y.test");
  });
});

/* ========================================================================= */
describe("close codes", () => {
  it("reports 4401 as an unauthorized key and stops retrying", async () => {
    const { ws } = await connectAndOpen();
    ws.serverClose(socket.CLOSE_UNAUTHORIZED);
    await flush();
    expect(socket.state().status).toBe("unauthorized");
    expect(socket.state().lastError).toMatch(/rejected this API key/);
    expect(sockets).toHaveLength(1);
    expect(alarmClears).toContain(socket.KEEPALIVE_ALARM);
  });

  it("reports 4403 as a forbidden account and stops retrying", async () => {
    const { ws } = await connectAndOpen();
    ws.serverClose(socket.CLOSE_FORBIDDEN);
    await flush();
    expect(socket.state().status).toBe("unauthorized");
    expect(socket.state().lastError).toMatch(/not allowed to connect/);
    expect(sockets).toHaveLength(1);
  });

  // @edge — THE 4409 LOOP. Reconnecting here would take the slot back from the
  // browser that just claimed it, which reconnects and takes it back again:
  // two clients fighting over one slot forever, with neither user able to see
  // why. Distinct from 4401/4403 because the state the popup shows differs.
  it("treats 4409 as terminal rather than racing the browser that evicted it", async () => {
    const { ws } = await connectAndOpen();
    ws.serverClose(socket.CLOSE_EVICTED);
    await flush();
    expect(socket.state().status).toBe("evicted");
    expect(socket.state().lastError).toMatch(/Another browser connected/);
    expect(sockets).toHaveLength(1);
    expect(alarmClears).toContain(socket.KEEPALIVE_ALARM);
  });

  // @edge — a SURVIVOR the mutation harness found: every assertion above checks
  // the state and the socket count IMMEDIATELY after the close, so a terminal
  // close that ALSO scheduled a reconnect timer looked identical — the timer
  // had simply not fired yet. Advancing past the longest possible backoff is
  // what makes the difference visible, and this is the assertion that actually
  // proves 4409 does not turn into two clients fighting over one slot.
  it.each([
    ["4409", 4409],
    ["4401", 4401],
    ["4403", 4403],
  ])("schedules no reconnect at all after %s", async (_label, code) => {
    // Connect under REAL timers first. `connect`'s cold-entry check awaits
    // crypto.subtle, which settles on a macrotask that fake timers stub out —
    // starting them any earlier means no socket is ever built, and the failure
    // reads as "the module did not connect" rather than "the setup froze the
    // clock before the setup finished".
    await socket.connect({
      apiBase: "https://x.test/api",
      apiKey: "brx-abc",
      onCommand: async () => ({}),
    });
    j.useFakeTimers();
    try {
      sockets[0].open();
      sockets[0].serverClose(code);
      // Well past RECONNECT_MAX_MS: if any timer was armed, it has fired.
      j.advanceTimersByTime(socket.RECONNECT_MAX_MS * 10);
      expect(sockets).toHaveLength(1);
    } finally {
      j.useRealTimers();
      // The terminal close fired a durable write that could not settle while
      // the clock was frozen. Drain it HERE, inside the case that caused it,
      // rather than leaving it to land in whichever case runs next — where it
      // blocks that case's `connect` and the failure names the wrong test.
      await flush();
      await socket.clearTerminalVerdict();
    }
  });

  // @edge — two SURVIVORS the harness found, and the reason they survived is
  // worth stating: a terminal close now has TWO independent guards against
  // reconnecting — it schedules no timer, AND it drops `config`, which the
  // timer callback requires. Either alone is sufficient, so removing either
  // alone changes nothing observable and no test could see it. Removing BOTH
  // reconnects.
  //
  // That is a redundancy worth keeping (the two protect different callers:
  // `scheduleReconnect` and `keepalive`), but redundancy with nothing pinning
  // the pieces is how one of them gets deleted as dead code and the other then
  // gets deleted as harmless. These assert each mechanism directly rather than
  // through its effect, which is the only way to tell them apart.
  it.each([
    ["4409", 4409],
    ["4401", 4401],
    ["4403", 4403],
  ])("drops the config on %s, so nothing can rebuild the connection", async (_label, code) => {
    const { ws } = await connectAndOpen();
    expect(socket.__hasConfig()).toBe(true);
    ws.serverClose(code);
    await flush();
    // Asserted on the mechanism, not on its effect: the terminal `status` guard
    // in `keepalive` would mask a config that was still set, so going through
    // `keepalive` here could not tell the two guards apart.
    expect(socket.__hasConfig()).toBe(false);
  });

  // The other half of the same pair: no timer is ARMED. Distinct from the
  // "schedules no reconnect" cases above, which pass as long as EITHER guard
  // holds — this one fails if a timer was armed even though the dropped config
  // renders it inert.
  //
  // Observed through `setTimeout` itself rather than through a socket
  // appearing, because that is the only way to separate "no timer was armed"
  // from "a timer was armed and then found no config".
  it.each([
    ["4409", 4409],
    ["4401", 4401],
    ["4403", 4403],
  ])("arms no reconnect timer on %s", async (_label, code) => {
    const { ws } = await connectAndOpen();
    const realSetTimeout = globalThis.setTimeout;
    const armed = [];
    globalThis.setTimeout = (fn, delay) => {
      armed.push(delay);
      return realSetTimeout(fn, delay);
    };
    try {
      ws.serverClose(code);
      await flush();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(armed).toEqual([]);
  });

  it("does not reconnect on the keepalive tick after being evicted", async () => {
    const { ws } = await connectAndOpen();
    ws.serverClose(socket.CLOSE_EVICTED);
    await flush();
    expect(socket.keepalive()).toBe(true);
    await flush();
    // Still exactly the one socket: the alarm must not resurrect the fight.
    expect(sockets).toHaveLength(1);
    expect(socket.state().status).toBe("evicted");
  });

  /* ---------------------------------------------------------------------
   * M1 — the terminal verdict must OUTLIVE the worker.
   *
   * `socket.__reset()` here is not a convenience: it is the closest model this
   * suite has of an MV3 teardown, and it is exactly what the module header
   * says a teardown does — every scrap of per-worker state gone, `chrome`
   * storage untouched. That is a MODEL of the teardown, not the teardown; what
   * it does not reproduce is Chrome's own timing, the loss of pending
   * microtasks, and the alarm's next tick.
   *
   * Before this, a review drove the real sequence: 4409 → evicted → teardown →
   * wake reads storage.sync → SECOND socket, status "connecting". The slot
   * fight the terminal decision refuses to start, restarted by the lifecycle.
   * ------------------------------------------------------------------ */
  it.each([
    ["4409", 4409, "evicted"],
    ["4401", 4401, "unauthorized"],
    ["4403", 4403, "unauthorized"],
  ])(
    "remembers a %s across a worker teardown instead of reconnecting on the next wake",
    async (_label, code, expected) => {
      const { ws } = await connectAndOpen();
      ws.serverClose(code);
      // Waits for the durable record itself, not a fixed number of turns: this
      // case asserts the verdict SURVIVES a teardown, so a teardown modelled
      // before the write lands would test nothing and still go green.
      await waitFor(
        () => "companionTerminalClose" in localStore,
        "the terminal verdict was written"
      );
      expect(socket.state().status).toBe(expected);

      // --- the worker dies; storage survives, as it does in Chrome ---
      socket.__reset();
      sockets = [];
      expect(socket.state().status).toBe("idle");

      // --- the wake: index.js reads storage.sync and calls connect ---
      await socket.connect({
        apiBase: "https://x.test/api",
        apiKey: "brx-abc",
        onCommand: async () => ({}),
      });

      // No socket at all. This is the whole point: the fight does not resume.
      expect(sockets).toHaveLength(0);
      expect(socket.state().status).toBe(expected);
      expect(socket.state().lastError).toEqual(expect.any(String));
    }
  );

  // @edge — THE WAY BACK IN. An evicted user who reconnects in AnythingLLM gets
  // a NEW key, and that must clear the block with no reinstall and nothing to
  // find by hand. Keyed on a fingerprint, so this is what makes the durable
  // refusal safe to ship at all.
  it("lets a different key through, and clears the stored refusal", async () => {
    const { ws } = await connectAndOpen();
    ws.serverClose(4409);
    // Without this wait the whole case is vacuous: if no verdict was ever
    // stored, "a different key connects" is trivially true and proves nothing
    // about clearing anything.
    await waitFor(
      () => "companionTerminalClose" in localStore,
      "the terminal verdict was written"
    );
    socket.__reset();
    sockets = [];

    await socket.connect({
      apiBase: "https://x.test/api",
      apiKey: "brx-a-brand-new-key",
      onCommand: async () => ({}),
    });
    expect(sockets).toHaveLength(1);
    expect(socket.state().status).toBe("connecting");

    // The record is gone, not merely bypassed: the OLD key connects again too,
    // which is what proves it was cleared rather than shadowed.
    socket.__reset();
    sockets = [];
    await socket.connect({
      apiBase: "https://x.test/api",
      apiKey: "brx-abc",
      onCommand: async () => ({}),
    });
    expect(sockets).toHaveLength(1);
  });

  // @edge — the key itself must NOT be written to storage. storage.local is not
  // encrypted, and the whole point of the subprotocol transport is keeping this
  // credential out of places it does not need to be.
  it("stores a fingerprint, never the key", async () => {
    const { ws } = await connectAndOpen({ apiKey: "brx-secret-value" });
    ws.serverClose(4409);
    // Waits for the RECORD rather than a fixed number of turns. The digest and
    // the write behind it take an unspecified number of macrotasks, so a fixed
    // flush is a race that passes on a fast machine and fails on a slow one —
    // and when it failed it read as "the module never wrote the verdict".
    await waitFor(() => "companionTerminalClose" in localStore);
    const dumped = JSON.stringify(localStore);
    expect(dumped).not.toContain("brx-secret-value");
    expect(dumped).toContain("companionTerminalClose");
  });

  // @edge — task 6 learned that a storage write is not a thing to assume. A
  // failed write must not stop the popup learning this connection was refused;
  // the cost is only that the verdict does not survive the teardown, which is
  // no worse than not having tried.
  it("still reports the terminal state when the durable write fails", async () => {
    const { ws } = await connectAndOpen();
    localSetFails = new Error("QUOTA_BYTES quota exceeded");
    ws.serverClose(4409);
    await flush();
    expect(socket.state().status).toBe("evicted");
  });

  // @edge — a storage READ failure must fail OPEN. The alternative is an
  // extension that cannot connect at all when storage is unhealthy, and the
  // server refuses the connection again anyway if the verdict was real.
  it("connects when the stored verdict cannot be read", async () => {
    const { ws } = await connectAndOpen();
    ws.serverClose(4409);
    // A verdict must actually exist, or "it connected anyway" is not evidence
    // that a READ failure fails open — there would be nothing to read.
    await waitFor(
      () => "companionTerminalClose" in localStore,
      "the terminal verdict was written"
    );
    socket.__reset();
    sockets = [];

    const realGet = globalThis.chrome.storage.local.get;
    globalThis.chrome.storage.local.get = async () => {
      throw new Error("storage unavailable");
    };
    await socket.connect({
      apiBase: "https://x.test/api",
      apiKey: "brx-abc",
      onCommand: async () => ({}),
    });
    globalThis.chrome.storage.local.get = realGet;
    expect(sockets).toHaveLength(1);
  });

  it("clearTerminalVerdict lets the same key connect again", async () => {
    const { ws } = await connectAndOpen();
    ws.serverClose(4409);
    // Same reason: clearing nothing and then connecting proves nothing.
    await waitFor(
      () => "companionTerminalClose" in localStore,
      "the terminal verdict was written"
    );
    socket.__reset();
    sockets = [];

    await expect(socket.clearTerminalVerdict()).resolves.toBe(true);
    await socket.connect({
      apiBase: "https://x.test/api",
      apiKey: "brx-abc",
      onCommand: async () => ({}),
    });
    expect(sockets).toHaveLength(1);
  });

  it("writes a terminal close to the audit log the user reads", async () => {
    const { ws } = await connectAndOpen();
    ws.serverClose(socket.CLOSE_EVICTED);
    await flush();
    const entries = await auditLog.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].cmd).toBe("socket");
    expect(entries[0].detail).toContain("4409");
  });

  // @edge — the audit write is fire-and-forget from a close handler. A storage
  // failure there must not stop the state the popup reads from being set.
  it("still reports the terminal state when the audit write fails", async () => {
    const { ws } = await connectAndOpen();
    localSetFails = new Error("QUOTA_BYTES quota exceeded");
    ws.serverClose(socket.CLOSE_EVICTED);
    await flush();
    expect(socket.state().status).toBe("evicted");
  });

  // 1011 is the server's own internal error and IS retryable — it is the shape
  // a transient server-side failure takes.
  it("retries after a 1011 internal error", async () => {
    j.useFakeTimers();
    try {
      const onCommand = async () => ({});
      await socket.connect({
        apiBase: "https://x.test/api",
        apiKey: "brx-abc",
        onCommand,
      });
      sockets[0].open();
      sockets[0].serverClose(1011);
      expect(socket.state().status).toBe("idle");
      j.advanceTimersByTime(socket.RECONNECT_MAX_MS);
      expect(sockets).toHaveLength(2);
    } finally {
      j.useRealTimers();
    }
  });

  it("retries after an ordinary abnormal close", async () => {
    j.useFakeTimers();
    try {
      await socket.connect({
        apiBase: "https://x.test/api",
        apiKey: "brx-abc",
        onCommand: async () => ({}),
      });
      sockets[0].open();
      sockets[0].serverClose(1006);
      j.advanceTimersByTime(socket.RECONNECT_MAX_MS);
      expect(sockets).toHaveLength(2);
    } finally {
      j.useRealTimers();
    }
  });

  // @edge — the evicted FRAME arrives before the 4409 close, and carries the
  // server's own reason. Handling only the close code loses that text.
  it("takes the reason from the evicted frame the server sends first", async () => {
    const { ws } = await connectAndOpen();
    ws.deliver({ event: "evicted", reason: "Replaced by a newer connection." });
    await flush();
    expect(socket.state().status).toBe("evicted");
    expect(socket.state().lastError).toBe("Replaced by a newer connection.");
  });

  it("falls back to its own wording when the evicted frame carries no reason", async () => {
    const { ws } = await connectAndOpen();
    ws.deliver({ event: "evicted" });
    await flush();
    expect(socket.state().lastError).toMatch(/Another browser connected/);
  });
});

/* ========================================================================= */
describe("reconnect backoff", () => {
  it("backs off exponentially rather than storming a server that is down", async () => {
    j.useFakeTimers();
    // Pinned so the jitter cannot make this assertion flaky, and so the
    // exponent is what is measured rather than the random draw.
    const random = j.spyOn(Math, "random").mockReturnValue(0);
    try {
      await socket.connect({
        apiBase: "https://x.test/api",
        apiKey: "brx-abc",
        onCommand: async () => ({}),
      });
      const delays = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const before = sockets.length;
        sockets.at(-1).serverClose(1006);
        // With random() === 0 the delay is exactly half the current ceiling.
        let waited = 0;
        while (sockets.length === before && waited < 120_000) {
          j.advanceTimersByTime(50);
          waited += 50;
        }
        delays.push(waited);
      }
      // Each wait is at least as long as the last, and they grow.
      expect(delays[1]).toBeGreaterThan(delays[0]);
      expect(delays[2]).toBeGreaterThan(delays[1]);
      expect(delays[0]).toBeGreaterThanOrEqual(socket.RECONNECT_BASE_MS / 2);
    } finally {
      random.mockRestore();
      j.useRealTimers();
    }
  });

  it("caps the backoff so a long outage still retries", async () => {
    j.useFakeTimers();
    const random = j.spyOn(Math, "random").mockReturnValue(0.999);
    try {
      await socket.connect({
        apiBase: "https://x.test/api",
        apiKey: "brx-abc",
        onCommand: async () => ({}),
      });
      for (let attempt = 0; attempt < 12; attempt += 1) {
        sockets.at(-1).serverClose(1006);
        j.advanceTimersByTime(socket.RECONNECT_MAX_MS + 1);
      }
      const before = sockets.length;
      sockets.at(-1).serverClose(1006);
      j.advanceTimersByTime(socket.RECONNECT_MAX_MS + 1);
      expect(sockets.length).toBe(before + 1);
    } finally {
      random.mockRestore();
      j.useRealTimers();
    }
  });

  // @edge — an unjittered backoff has every installed extension retrying in
  // lockstep and hitting a recovering server as one burst.
  it("jitters the delay rather than retrying on a fixed schedule", async () => {
    j.useFakeTimers();
    const draws = [0, 0.9];
    const random = j.spyOn(Math, "random").mockImplementation(() => draws.shift() ?? 0);
    try {
      const measure = async () => {
        socket.__reset();
        sockets = [];
        await socket.connect({
          apiBase: "https://x.test/api",
          apiKey: "brx-abc",
          onCommand: async () => ({}),
        });
        sockets[0].serverClose(1006);
        let waited = 0;
        while (sockets.length === 1 && waited < 10_000) {
          j.advanceTimersByTime(10);
          waited += 10;
        }
        return waited;
      };
      const low = await measure();
      const high = await measure();
      expect(high).toBeGreaterThan(low);
    } finally {
      random.mockRestore();
      j.useRealTimers();
    }
  });

  it("resets the backoff once a connection succeeds", async () => {
    j.useFakeTimers();
    const random = j.spyOn(Math, "random").mockReturnValue(0);
    try {
      await socket.connect({
        apiBase: "https://x.test/api",
        apiKey: "brx-abc",
        onCommand: async () => ({}),
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        sockets.at(-1).serverClose(1006);
        j.advanceTimersByTime(socket.RECONNECT_MAX_MS + 1);
      }
      // A successful open must put the next failure back at the base delay.
      sockets.at(-1).open();
      const before = sockets.length;
      sockets.at(-1).serverClose(1006);
      j.advanceTimersByTime(socket.RECONNECT_BASE_MS);
      expect(sockets.length).toBe(before + 1);
    } finally {
      random.mockRestore();
      j.useRealTimers();
    }
  });
});

/* ========================================================================= */
describe("the keepalive alarm", () => {
  // @edge — the value itself is the shipping limitation. Chrome honours a
  // sub-minute period only for an UNPACKED extension; this asserts what the
  // module ASKS FOR, and pins that it is under the packed floor so the comment
  // above the constant cannot silently stop being true.
  it("asks for a period under the 1-minute packed-extension floor", () => {
    expect(socket.KEEPALIVE_MINUTES).toBeLessThan(1);
    // Under half the ~30s MV3 idle teardown, or it cannot prevent one.
    expect(socket.KEEPALIVE_MINUTES).toBeLessThanOrEqual(0.25);
    expect(socket.KEEPALIVE_MINUTES).toBeGreaterThan(0);
  });

  it("arms the alarm with that period when connecting", async () => {
    await connectAndOpen();
    const armed = alarmCreates.filter((a) => a.name === socket.KEEPALIVE_ALARM);
    expect(armed).toHaveLength(1);
    expect(armed[0].info.periodInMinutes).toBe(socket.KEEPALIVE_MINUTES);
  });

  // @edge — armed before the handshake completes, not in onopen: a worker torn
  // down mid-handshake would otherwise have no alarm to wake it.
  it("arms the alarm before the socket has opened", async () => {
    await socket.connect({
      apiBase: "https://x.test/api",
      apiKey: "brx-abc",
      onCommand: async () => ({}),
    });
    expect(sockets[0].readyState).toBe(FakeSocket.CONNECTING);
    expect(alarmCreates.map((a) => a.name)).toContain(socket.KEEPALIVE_ALARM);
  });

  it("pings a live socket so the idle timer is reset", async () => {
    const { ws } = await connectAndOpen();
    expect(socket.keepalive()).toBe(true);
    expect(ws.frames()).toEqual([{ event: "ping" }]);
  });

  // @edge — THE POINT OF THE ALARM. If the worker was torn down the socket died
  // with it, so a keepalive that only pings would keep nothing alive: the wake
  // has to re-open the connection.
  it("reconnects rather than only pinging when the socket is gone", async () => {
    await connectAndOpen();
    // The worker's socket died; the module still holds the config.
    sockets[0].serverClose(1006);
    await flush();
    const before = sockets.length;
    expect(socket.keepalive()).toBe(true);
    expect(sockets.length).toBe(before + 1);
  });

  it("says so when it woke cold with no config to reconnect with", () => {
    expect(socket.keepalive()).toBe(false);
    expect(sockets).toHaveLength(0);
  });

  it("clears the alarm when there is no configuration to connect with", async () => {
    await connectAndOpen();
    await socket.connect({ apiBase: "", apiKey: "", onCommand: async () => ({}) });
    expect(alarmClears).toContain(socket.KEEPALIVE_ALARM);
  });
});

/* ========================================================================= */
describe("the agent's tab", () => {
  it("creates its own inactive tab rather than taking over the user's", async () => {
    const id = await socket.ensureAgentTab();
    expect(typeof id).toBe("number");
    expect(tabCreateCalls).toEqual([{ url: "about:blank", active: false }]);
  });

  it("reuses the tab it already has", async () => {
    const first = await socket.ensureAgentTab();
    const second = await socket.ensureAgentTab();
    expect(second).toBe(first);
    expect(tabCreateCalls).toHaveLength(1);
  });

  it("opens a fresh tab after the user closes the agent's", async () => {
    const first = await socket.ensureAgentTab();
    tabs.delete(first);
    const second = await socket.ensureAgentTab();
    expect(second).not.toBe(first);
    expect(tabCreateCalls).toHaveLength(2);
  });

  // @edge — two concurrent callers each finding no tab would each create one,
  // leaving an orphan open forever and the two holding different ids for the
  // same logical tab.
  it("opens exactly one tab for concurrent callers", async () => {
    const [a, b, c] = await Promise.all([
      socket.ensureAgentTab(),
      socket.ensureAgentTab(),
      socket.agentTabUrl().then(() => socket.ensureAgentTab()),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(tabCreateCalls).toHaveLength(1);
  });

  it("reports about:blank for a tab that has no url yet", async () => {
    await socket.ensureAgentTab();
    tabs.get(1).url = "";
    expect(await socket.agentTabUrl()).toBe("about:blank");
  });

  it("throws rather than returning a tabless id when create gives no id", async () => {
    globalThis.chrome.tabs.create = async () => ({});
    await expect(socket.ensureAgentTab()).rejects.toThrow(
      /did not return a tab id/i
    );
  });

  // F1. This case previously asserted the OPPOSITE — that every tab in the
  // browser is listed, with all filtering left to the gate. A final review
  // drove the seam that made that wrong: `switchToTab` adopts what it focuses,
  // so an unfiltered list let `page_switch` adopt a tab the USER opened, after
  // which `page_close` closed it and `page_navigate` moved it. Both tool
  // descriptions and the spec deny that outright ("agent เปิดแท็บใหม่ของตัวเอง
  // ไม่แตะแท็บที่ผู้ใช้เปิดอยู่"), and the user chose that behaviour explicitly at
  // design time — so the code was wrong, not the descriptions.
  //
  // The two filters are still separate: OWNERSHIP is answered here, because
  // `createdTabIds` exists nowhere else; the ALLOWLIST is still judged only by
  // dispatch. The case below asserts both halves of that split.
  it("lists only tabs the agent opened, whatever the user has open", async () => {
    const mine = await agentOpenedTab("https://allowed.test/a");
    // Two tabs the user opened: one allowlisted, one not. Neither is the
    // agent's, so the allowlist is not what decides here — ownership is.
    await chrome.tabs.create({ url: "https://allowed.test/user", active: false });
    await chrome.tabs.create({ url: "https://forbidden.test/b", active: false });

    const listed = await socket.listAgentTabs();
    expect(listed.map((t) => t.id)).toEqual([mine]);
    expect(listed.map((t) => t.url)).toEqual(["https://allowed.test/a"]);
  });

  // The ownership filter must not be mistaken for an allowlist filter: an
  // agent tab on a forbidden url is still LISTED here, and it is dispatch that
  // refuses to act on it. Collapsing the two would put the security boundary
  // in a second place.
  it("still leaves the allowlist judgement to the gate", async () => {
    const forbidden = await agentOpenedTab("https://forbidden.test/mine");
    const listed = await socket.listAgentTabs();
    expect(listed.map((t) => t.id)).toEqual([forbidden]);
  });

  // @edge — "the agent's tabs" is EVERY tab it owns, not just the one it is
  // currently on. Narrowing to `agentTabId` would still read as "the agent's
  // tabs" and would silently leave page_switch with nothing to switch to and
  // page_tabs showing one row — a mutation proved the suite could not tell.
  it("lists every tab the agent owns, not only the current one", async () => {
    const first = await agentOpenedTab("https://allowed.test/one");
    socket.__forgetCurrentTab();
    const second = await agentOpenedTab("https://allowed.test/two");
    expect(second).not.toBe(first);

    const listed = await socket.listAgentTabs();
    expect(listed.map((t) => t.id).sort()).toEqual([first, second].sort());
  });

  // @edge — switching without ADOPTING the tab would leave every following
  // command acting on the old one: the agent believes it is on the page it
  // switched to and reads, clicks and closes somewhere else.
  it("adopts a tab it owns, so later commands act on it", async () => {
    const { previous, next } = await stageSecondAgentTab("https://other.test/");
    expect(next).not.toBe(previous);
    // Currently on `next`; switch back to the one it owned before.
    await socket.switchToTab(previous);
    expect(tabs.get(previous).active).toBe(true);
    expect(await socket.ensureAgentTab()).toBe(previous);
  });

  // @edge — F1, at the accessor. Adoption is the step that makes a tab
  // reachable by page_close and page_navigate, so it is the step that refuses.
  it("refuses to adopt a tab the agent did not open", async () => {
    await socket.ensureAgentTab();
    const usersTab = await chrome.tabs.create({
      url: "https://allowed.test/user-draft",
      active: false,
    });
    await expect(socket.switchToTab(usersTab.id)).rejects.toThrow(
      /only acts on its own tabs/
    );
    // And it did not half-apply: the tab is neither focused nor adopted.
    expect(tabs.get(usersTab.id).active).toBeUndefined();
    expect(await socket.ensureAgentTab()).not.toBe(usersTab.id);
  });

  // @edge — the id of an agent tab the USER closes must leave the capability
  // set. Chrome reuses tab ids within a session, so a lingering id would let a
  // user's new tab inherit the agent's ownership of it — L4 by another route,
  // and it only became reachable when this set became a capability record.
  it("gives up ownership of an agent tab the user closed", async () => {
    const mine = await socket.ensureAgentTab();
    tabs.delete(mine); // the user closes it; closeTab is never called
    await socket.ensureAgentTab(); // the module notices and opens a fresh one

    // Chrome recycles the old id onto a tab the user opens.
    nextTabId = mine;
    const usersTab = await chrome.tabs.create({
      url: "https://allowed.test/user-draft",
      active: false,
    });
    expect(usersTab.id).toBe(mine);

    await expect(socket.switchToTab(usersTab.id)).rejects.toThrow(
      /only acts on its own tabs/
    );
    expect((await socket.listAgentTabs()).map((t) => t.id)).not.toContain(mine);
  });

  // @edge — a SURVIVOR the harness found. This originally asserted only that a
  // NEW tab appears afterwards, which happens either way: without the forget,
  // `agentTabId` names a closed tab and the next `chrome.tabs.get` REJECTS, and
  // the catch inside `doResolveAgentTab` recovers by accident. The setup could
  // therefore never distinguish the two. Asserting on the tab TABLE — that the
  // recovery is a deliberate create and not a rescued throw — is what makes it
  // observable, and the stale-id assertion below is what proves the state was
  // actually cleared rather than merely worked around.
  // @edge — L1. `handle` calls `ensureAgentTab()` before EVERY command's run,
  // page_switch included, so on a cold worker a switch creates a blank agent
  // tab and then adopts a different one — abandoning the blank. One stray tab
  // per cold-start switch, accumulating across worker restarts, and the user
  // has no idea where it came from.
  it("does not leave an orphan blank tab behind when it switches away", async () => {
    // Two agent-owned tabs: one settled on a page, one a fresh blank. Switching
    // to the settled one must not leave the blank behind.
    const settled = await agentOpenedTab("https://other.test/");
    socket.__forgetCurrentTab();
    const blank = await socket.ensureAgentTab();
    expect(blank).not.toBe(settled);

    await socket.switchToTab(settled);

    expect(tabs.has(blank)).toBe(false);
    expect(tabs.has(settled)).toBe(true);
    expect(await socket.ensureAgentTab()).toBe(settled);
  });

  // @edge — the three conditions on that cleanup are what stop it destroying
  // something the user was using. A tab the agent NAVIGATED may hold state the
  // user can see, so it is left alone even though we opened it.
  it("keeps an abandoned tab the agent actually used", async () => {
    // The tab being abandoned is the one the agent NAVIGATED, so it may hold
    // state the user can see and must survive the switch.
    const used = await agentOpenedTab("https://linkedin.com/feed/");
    socket.__forgetCurrentTab();
    const target = await agentOpenedTab("https://other.test/");
    socket.__forgetCurrentTab();
    await socket.switchToTab(used); // current = used
    await socket.switchToTab(target); // abandons `used`

    expect(tabs.has(used)).toBe(true);
  });

  // @edge — a tab MID-NAVIGATION still reports `url: "about:blank"`; the truth
  // is in `pendingUrl`. Without that check a tab the agent navigated one
  // instant ago is indistinguishable from an unused blank one, and the cleanup
  // closes it out from under its own navigation.
  it("keeps an abandoned tab whose navigation has not committed yet", async () => {
    const target = await agentOpenedTab("https://other.test/");
    socket.__forgetCurrentTab();
    const navigating = await socket.ensureAgentTab();
    // Exactly what cdp.navigate does. `url` still reads about:blank after it.
    await chrome.tabs.update(navigating, { url: "https://linkedin.com/feed/" });
    expect(tabs.get(navigating).url).toBe("about:blank");

    await socket.switchToTab(target); // abandons the navigating tab

    expect(tabs.has(navigating)).toBe(true);
    // And it really was a live navigation, not a tab that had settled.
    globalThis.chrome.tabs.__commit(navigating);
    expect(tabs.get(navigating).url).toBe("https://linkedin.com/feed/");
  });

  // @edge — a pending navigation to about:blank is not a reason to keep a tab:
  // that is where it already is, so the tab is still unused.
  it("still discards a tab whose only pending navigation is to about:blank", async () => {
    const target = await agentOpenedTab("https://other.test/");
    socket.__forgetCurrentTab();
    const blank = await socket.ensureAgentTab();
    await chrome.tabs.update(blank, { url: "about:blank" });

    await socket.switchToTab(target);

    expect(tabs.has(blank)).toBe(false);
  });

  // @edge — L4. `closeTab` forgetting the id in `createdTabIds` is LOAD-BEARING
  // and this is the only thing pinning it.
  //
  // Chrome REUSES tab ids within a session. So: we open a tab, we close it, and
  // Chrome hands that same id to a tab the USER opens. If the id was never
  // removed from `createdTabIds`, the user's tab now satisfies every condition
  // `discardIfUnused` checks — we "opened" it (stale membership), it is blank,
  // and it exists — and switching away CLOSES IT.
  //
  // This is L1 inverted, and worse: L1 leaked a blank tab, which is cosmetic;
  // this destroys a real one. Neither of the other two guards saves it, because
  // both are satisfied by an ordinary blank tab.
  it("does not close a user tab that reuses a closed tab's id", async () => {
    const ours = await socket.ensureAgentTab();
    await socket.closeTab(ours);

    // Chrome recycles the id. `nextTabId` is rewound so the table hands the
    // same number out again, which is exactly what a real session does.
    nextTabId = ours;
    const usersTab = await chrome.tabs.create({
      url: "about:blank",
      active: false,
    });
    expect(usersTab.id).toBe(ours);

    // Since F1 the stale id is also a CAPABILITY, so the first thing to prove
    // is that ownership did not come back with the id: the agent cannot adopt
    // the user's tab, and cannot see it.
    await expect(socket.switchToTab(usersTab.id)).rejects.toThrow(
      /only acts on its own tabs/
    );
    expect((await socket.listAgentTabs()).map((t) => t.id)).not.toContain(
      usersTab.id
    );

    // And the original L4 property: an ordinary switch between the agent's own
    // tabs must not sweep up the recycled tab either.
    const elsewhere = await agentOpenedTab("https://other.test/");
    socket.__forgetCurrentTab();
    await socket.ensureAgentTab();
    await socket.switchToTab(elsewhere);

    expect(tabs.has(usersTab.id)).toBe(true);
  });

  // @edge — and a tab the USER opened is never a candidate, whatever it shows.
  // A blank tab the user opened themselves looks identical to ours.
  // Since F1 this is guarded twice over: the tab cannot be adopted in the first
  // place, and even if it somehow became the abandoned tab, the cleanup checks
  // ownership. The case asserts BOTH, because the first guard alone would make
  // the second unreachable and therefore deletable.
  it("never closes a blank tab the user opened", async () => {
    const usersBlank = await chrome.tabs.create({
      url: "about:blank",
      active: false,
    });
    // Guard one: it cannot be adopted at all.
    await expect(socket.switchToTab(usersBlank.id)).rejects.toThrow(
      /only acts on its own tabs/
    );

    // Guard two: an ordinary switch between the agent's own tabs must not
    // sweep up the user's blank tab, which looks identical to an unused one.
    const target = await agentOpenedTab("https://other.test/");
    socket.__forgetCurrentTab();
    await socket.ensureAgentTab();
    await socket.switchToTab(target);

    expect(tabs.has(usersBlank.id)).toBe(true);
  });

  it("forgets the agent tab when it is the one closed", async () => {
    const id = await socket.ensureAgentTab();
    await socket.closeTab(id);
    expect(tabs.has(id)).toBe(false);

    // A `get` on the stale id must never be attempted: if it is, the module is
    // still holding a tab id it was told to forget.
    const gets = [];
    const realGet = globalThis.chrome.tabs.get;
    globalThis.chrome.tabs.get = async (wanted) => {
      gets.push(wanted);
      return realGet(wanted);
    };
    const next = await socket.ensureAgentTab();
    globalThis.chrome.tabs.get = realGet;

    expect(next).not.toBe(id);
    expect(gets).not.toContain(id);
    expect(tabCreateCalls).toHaveLength(2);
  });

  // @edge — the same forget, on the binding. A binding left naming a closed tab
  // would make the NEXT `ensureAgentTab` in the same command throw the
  // gate-mismatch error for a tab the command itself legitimately closed.
  it("forgets the binding too when the bound tab is closed", async () => {
    await socket.agentTabUrl();
    const id = await socket.ensureAgentTab();
    await socket.closeTab(id);
    await expect(socket.ensureAgentTab()).resolves.toBe(2);
  });
});

/* ========================================================================= */
describe("agentTabUrl and ensureAgentTab name the same tab", () => {
  // @edge — THE COUPLING TASK 7 COULD NOT TEST. `handle` gates on the url
  // `agentTabUrl` reports, then acts on the tab `ensureAgentTab` returns. If
  // the user closes the tab between those two calls and this module quietly
  // opens a new one, the allowlist judged tab A while the action lands on tab
  // B — and for page_close that is the entire gate defeated.
  it("refuses when the gated tab was replaced before the action", async () => {
    const gatedUrl = await socket.agentTabUrl();
    expect(gatedUrl).toBe("about:blank");
    // The user closes it in the window between the two calls.
    tabs.delete(1);
    await expect(socket.ensureAgentTab()).rejects.toThrow(
      /between the allowlist check and the action/
    );
  });

  it("returns the same tab when nothing moved", async () => {
    await socket.agentTabUrl();
    await expect(socket.ensureAgentTab()).resolves.toBe(1);
  });

  // The whole point, end to end through the REAL dispatcher: a page_close that
  // was gated on an allowed page must not close a different tab.
  it("does not let page_close act on a tab the gate never judged", async () => {
    localStore[ALLOWLIST_KEY] = ["allowed.test"];
    // The agent's OWN tab, on an allowed page. Opened through the agent's own
    // path since F1: a tab from `chrome.tabs.create` belongs to the user, and
    // the module now refuses to adopt one.
    const agent = await agentOpenedTab("https://allowed.test/page");

    const closed = [];
    const deps = {
      loadAllowlist: (await import("../src/background/allowlist.js"))
        .loadAllowlist,
      record: auditLog.record,
      agentTabUrl: socket.agentTabUrl,
      ensureAgentTab: socket.ensureAgentTab,
      listAgentTabs: socket.listAgentTabs,
      switchToTab: socket.switchToTab,
      closeTab: async (id) => {
        closed.push(id);
        await socket.closeTab(id);
      },
      cdp: { attach: async () => {}, detach: async () => {} },
      pageState: { invalidate: () => {} },
    };

    // Ordinary case first: the gate judged this tab, and this tab is closed.
    const ok = await handle({ requestId: "r1", cmd: "close" }, deps);
    expect(ok.ok).toBe(true);
    expect(closed).toEqual([agent]);

    // Now the race: the gate resolves an allowed url, then the tab vanishes.
    const agent2 = await agentOpenedTab("https://allowed.test/page");
    // The victim is a tab the USER opened, which is what makes it a victim.
    const victim = await chrome.tabs.create({
      url: "https://bank.test/transfer",
      active: false,
    });

    const racing = {
      ...deps,
      agentTabUrl: async () => {
        const url = await socket.agentTabUrl();
        tabs.delete(agent2); // The user closes it right here.
        return url;
      },
    };
    const raced = await handle({ requestId: "r2", cmd: "close" }, racing);

    expect(raced.ok).toBe(false);
    expect(raced.error).toMatch(/between the allowlist check and the action/);
    // The unrelated tab is untouched, which is the property that matters.
    expect(closed).toEqual([agent]);
    expect(tabs.has(victim.id)).toBe(true);
  });

  /* ---------------------------------------------------------------------
   * F1 — the agent must not be able to adopt, close or navigate a tab the
   * USER opened.
   *
   * Driven through the REAL `dispatch.handle` with the real allowlist, because
   * the defect lived in the SEAM: task 7's gate judged whatever the resolver
   * handed it, and task 8's accessor handed it every tab in the browser. Each
   * half was right alone. A test that only checked `listAgentTabs`' output
   * would miss the adoption path, which is what actually made the user's tab
   * reachable — so this drives page_switch itself and then page_close after
   * it.
   * ------------------------------------------------------------------ */
  it("refuses page_switch onto a user tab, and page_close cannot then reach it", async () => {
    localStore[ALLOWLIST_KEY] = ["allowed.test"];
    // The agent has its own tab, on an allowed page.
    await agentOpenedTab("https://allowed.test/agent-page");
    // The user is working in a tab on the SAME allowlisted domain. The
    // allowlist therefore cannot be what protects it — only ownership can.
    const usersDraft = await chrome.tabs.create({
      url: "https://allowed.test/user-draft",
      active: false,
    });

    const closed = [];
    const deps = {
      loadAllowlist: (await import("../src/background/allowlist.js"))
        .loadAllowlist,
      record: auditLog.record,
      agentTabUrl: socket.agentTabUrl,
      ensureAgentTab: socket.ensureAgentTab,
      listAgentTabs: socket.listAgentTabs,
      switchToTab: socket.switchToTab,
      closeTab: async (id) => {
        closed.push(id);
        await socket.closeTab(id);
      },
      cdp: { attach: async () => {}, detach: async () => {} },
      pageState: { invalidate: () => {} },
    };

    // The switch must fail. It is denied at the resolver — the user's tab is
    // not in the set that is searched — so it reads as "nothing matched",
    // which is also what a forbidden tab looks like. That sameness is task 7's
    // opaque denial and is deliberate.
    const switched = await handle(
      { requestId: "s1", cmd: "switch", url: "user-draft" },
      deps
    );
    expect(switched.ok).toBe(false);

    // The tab was neither adopted nor focused.
    expect(tabs.get(usersDraft.id).active).toBeUndefined();

    // And page_close, which acts on "the agent's current tab", cannot have
    // become the user's tab. This is the assertion that would have caught the
    // original defect: previously the switch succeeded and this close removed
    // the user's tab.
    const closeResult = await handle({ requestId: "s2", cmd: "close" }, deps);
    expect(closeResult.ok).toBe(true);
    expect(closed).not.toContain(usersDraft.id);
    expect(tabs.has(usersDraft.id)).toBe(true);
  });

  /* ---------------------------------------------------------------------
   * F1-R — a tab id the module holds must not survive the tab it named.
   *
   * Chrome reuses tab ids within a session, and since F1 every held id GRANTS.
   * The first fix dropped stale ids in `doResolveAgentTab`'s catch, which only
   * fires when a lookup FAILS — but after a recycle the lookup SUCCEEDS, so
   * the catch never ran and the agent adopted whatever tab now wore the
   * number. `chrome.tabs.onRemoved` is the event that invalidates the ids, so
   * that is where they are dropped.
   *
   * Both routes are driven through the REAL dispatch.handle, and the user's
   * tab is on the SAME allowlisted domain as the agent's — so the allowlist
   * cannot be what protects it and only ownership can.
   * ------------------------------------------------------------------ */
  const ownershipDeps = async (log = {}) => ({
    loadAllowlist: (await import("../src/background/allowlist.js"))
      .loadAllowlist,
    record: auditLog.record,
    agentTabUrl: socket.agentTabUrl,
    ensureAgentTab: socket.ensureAgentTab,
    listAgentTabs: socket.listAgentTabs,
    switchToTab: socket.switchToTab,
    closeTab: async (id) => {
      (log.closed ??= []).push(id);
      await socket.closeTab(id);
    },
    cdp: {
      attach: async (id) => {
        (log.attached ??= []).push(id);
      },
      detach: async () => {},
      click: async (id) => {
        (log.clicked ??= []).push(id);
      },
    },
    pageState: { invalidate: () => {} },
    lookup: async () => ({ x: 10, y: 20 }),
  });

  // ROUTE A — `agentTabId`, and `listAgentTabs` is never involved. This is why
  // a test that only exercises page_switch would miss it: nothing here goes
  // near the tab list. The agent simply keeps acting on "its" tab, which is now
  // someone else's.
  it("does not act on a user tab that recycled the agent tab's id", async () => {
    localStore[ALLOWLIST_KEY] = ["allowed.test"];
    const agentTab = await agentOpenedTab("https://allowed.test/agent-page");

    // The user closes the agent's tab. Chrome fires onRemoved.
    userClosesTab(agentTab);
    // Chrome hands that id to a tab the USER opens, on the same allowed domain.
    nextTabId = agentTab;
    const usersTab = await chrome.tabs.create({
      url: "https://allowed.test/user-secret",
      active: false,
    });
    expect(usersTab.id).toBe(agentTab);

    const log = {};
    const deps = await ownershipDeps(log);

    // page_click would attach a debugger to the user's tab and click in it.
    const clicked = await handle(
      { requestId: "a1", cmd: "click", id: 1 },
      deps
    );
    // page_close would remove it.
    const closedResult = await handle({ requestId: "a2", cmd: "close" }, deps);

    // The agent must have opened a FRESH tab rather than inheriting the id, so
    // nothing it did can have landed on the user's tab.
    expect(log.attached ?? []).not.toContain(usersTab.id);
    expect(log.clicked ?? []).not.toContain(usersTab.id);
    expect(log.closed ?? []).not.toContain(usersTab.id);
    expect(tabs.has(usersTab.id)).toBe(true);
    expect(tabs.get(usersTab.id).url).toBe("https://allowed.test/user-secret");
    // Both commands still resolved rather than hanging — the agent is told
    // something, it just is not given the user's tab.
    expect(typeof clicked.ok).toBe("boolean");
    expect(typeof closedResult.ok).toBe("boolean");
  });

  // ROUTE B — `createdTabIds`, while the worker is not holding that tab
  // current. The stale entry keeps granting, so page_switch adopts the user's
  // recycled tab and page_close then removes it.
  it("does not adopt a user tab that recycled an owned tab's id", async () => {
    localStore[ALLOWLIST_KEY] = ["allowed.test"];
    const owned = await agentOpenedTab("https://allowed.test/owned");
    // The module stops holding it current, but it stays in createdTabIds.
    socket.__forgetCurrentTab();
    await agentOpenedTab("https://allowed.test/agent-page");

    // The user closes the first one; Chrome recycles its id onto their own tab.
    userClosesTab(owned);
    nextTabId = owned;
    const usersTab = await chrome.tabs.create({
      url: "https://allowed.test/user-secret",
      active: false,
    });
    expect(usersTab.id).toBe(owned);

    const log = {};
    const deps = await ownershipDeps(log);

    const switched = await handle(
      { requestId: "b1", cmd: "switch", url: "user-secret" },
      deps
    );
    expect(switched.ok).toBe(false);

    const closedResult = await handle({ requestId: "b2", cmd: "close" }, deps);
    expect(closedResult.ok).toBe(true);
    expect(log.closed ?? []).not.toContain(usersTab.id);
    expect(tabs.has(usersTab.id)).toBe(true);
  });

  /* ---------------------------------------------------------------------
   * TOCTOU-1 — the same class one layer down, and the listener cannot reach it.
   *
   * `dispatch.handle` does `const tabId = await d.ensureAgentTab()` and then
   * awaits again before anything happens with it — `cdp.attach(tabId)`, then
   * `spec.run`, which awaits inside itself. Those are real IPC round trips, so
   * a removal AND a `tabs.create` can both land inside them. `handleTabRemoved`
   * fixes STORED ids; this one is already captured in a local, so nothing the
   * listener does can save it.
   *
   * The recycle is driven from INSIDE the awaited call, which is the only place
   * it reproduces. The two windows fail differently and are therefore separate
   * cases: a recycle inside `attach` gets the user's tab CLICKED, one inside
   * `detach` gets it CLOSED.
   * ------------------------------------------------------------------ */

  /** Close the agent's tab and hand its id straight to a tab the user opens. */
  const recycleOnto = (agentTab, url) => {
    userClosesTab(agentTab);
    nextTabId = agentTab;
    return chrome.tabs.create({ url, active: false });
  };

  it("does not click a user tab that took the agent's id during cdp.attach", async () => {
    localStore[ALLOWLIST_KEY] = ["allowed.test"];
    const agentTab = await agentOpenedTab("https://allowed.test/agent-page");

    let usersTab;
    const clicked = [];
    const result = await handle(
      { requestId: "w1", cmd: "click", id: 1 },
      {
        loadAllowlist: (await import("../src/background/allowlist.js"))
          .loadAllowlist,
        record: auditLog.record,
        agentTabUrl: socket.agentTabUrl,
        ensureAgentTab: socket.ensureAgentTab,
        listAgentTabs: socket.listAgentTabs,
        switchToTab: socket.switchToTab,
        closeTab: socket.closeTab,
        cdp: socket.guardTabActs({
          // The window: the id was resolved, and the recycle happens while this
          // await is outstanding.
          attach: async () => {
            usersTab = await recycleOnto(
              agentTab,
              "https://allowed.test/user-secret"
            );
          },
          detach: async () => {},
          click: async (id) => clicked.push(id),
        }),
        pageState: { invalidate: () => {} },
        lookup: async () => ({ x: 10, y: 20 }),
      }
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/closed while this command/);
    expect(clicked).not.toContain(usersTab.id);
    expect(clicked).toEqual([]);
    expect(tabs.has(usersTab.id)).toBe(true);
  });

  it("does not close a user tab that took the agent's id during cdp.detach", async () => {
    localStore[ALLOWLIST_KEY] = ["allowed.test"];
    const agentTab = await agentOpenedTab("https://allowed.test/agent-page");

    let usersTab;
    const closed = [];
    const result = await handle(
      { requestId: "w2", cmd: "close" },
      {
        loadAllowlist: (await import("../src/background/allowlist.js"))
          .loadAllowlist,
        record: auditLog.record,
        agentTabUrl: socket.agentTabUrl,
        ensureAgentTab: socket.ensureAgentTab,
        listAgentTabs: socket.listAgentTabs,
        switchToTab: socket.switchToTab,
        closeTab: socket.guardTabActs({
          closeTab: async (id) => {
            closed.push(id);
            await socket.closeTab(id);
          },
        }).closeTab,
        cdp: socket.guardTabActs({
          attach: async () => {},
          // page_close detaches before it closes, so this is the window.
          detach: async () => {
            usersTab = await recycleOnto(
              agentTab,
              "https://allowed.test/user-secret"
            );
          },
        }),
        pageState: { invalidate: () => {} },
      }
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/closed while this command/);
    expect(closed).toEqual([]);
    expect(tabs.has(usersTab.id)).toBe(true);
    expect(tabs.get(usersTab.id).url).toBe("https://allowed.test/user-secret");
  });

  /* ---------------------------------------------------------------------
   * TOCTOU-1, the pageState path — DISCLOSURE rather than action.
   *
   * `pageState` was wired into deps RAW, and it imports `evaluate` straight
   * from cdp.js rather than through the frozen `cdp` surface — so `page_read`
   * and `page_state` reached `Runtime.evaluate` on the captured id with no
   * act-time check, and returned an arbitrary NON-ALLOWLISTED page's text and
   * control layout to the server.
   *
   * The follow-up click does not land (the next command gets a fresh tab and
   * the gate refuses), so the reachable damage is disclosure. That is still the
   * one thing the allowlist exists to bound, because the server is the
   * component this design assumes may be compromised.
   *
   * Driven with PER-TAB page content, so reading the wrong tab returns visibly
   * different text — a double that returned one fixed page could not tell the
   * two apart and the test would pass on the broken wiring.
   * ------------------------------------------------------------------ */
  const pageContentByTab = (byId) => {
    // Mirrors what cdp.evaluate returns for pageState's expressions, chosen by
    // which tab the command actually reached.
    globalThis.chrome.debugger.sendCommand = async ({ tabId }) => ({
      result: { value: byId[tabId] ?? null },
    });
  };

  it.each([
    ["read", "text"],
    ["state", "elements"],
  ])("does not disclose a recycled tab's page through page_%s", async (cmd) => {
    localStore[ALLOWLIST_KEY] = ["allowed.test"];
    const agentTab = await agentOpenedTab("https://allowed.test/agent");

    let usersTab;
    const result = await handle(
      { requestId: "p1", cmd },
      {
        loadAllowlist: (await import("../src/background/allowlist.js"))
          .loadAllowlist,
        record: auditLog.record,
        agentTabUrl: socket.agentTabUrl,
        ensureAgentTab: socket.ensureAgentTab,
        listAgentTabs: socket.listAgentTabs,
        switchToTab: socket.switchToTab,
        closeTab: socket.closeTab,
        cdp: socket.guardTabActs({
          // The window: the id is resolved, and the recycle lands while the
          // attach is outstanding.
          attach: async () => {
            usersTab = await recycleOnto(
              agentTab,
              // NOT in the allowlist at all.
              "https://bank.example.com/statement"
            );
            pageContentByTab({
              [usersTab.id]: {
                url: "https://bank.example.com/statement",
                title: "Statement",
                text: "USER PRIVATE BANK BALANCE 12345",
                elements: [
                  { id: 1, tag: "button", text: "Transfer funds", x: 5, y: 6 },
                ],
              },
            });
          },
          detach: async () => {},
        }),
        // The REAL pageState, wrapped the way index.js wraps it. Using the raw
        // module here would test the bug rather than the fix.
        pageState: socket.guardTabActs(
          await import("../src/background/pageState.js")
        ),
      }
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/closed while this command/);
    // Nothing from the bank page may appear anywhere in the reply.
    expect(JSON.stringify(result)).not.toContain("BANK BALANCE");
    expect(JSON.stringify(result)).not.toContain("Transfer funds");
    expect(JSON.stringify(result)).not.toContain("bank.example.com");

    // AND the audit line must not name a page that was never read. An entry
    // that is confidently wrong is worse than an absent one, because it is
    // what someone relies on afterwards to decide nothing happened.
    const entries = await auditLog.readAll();
    const last = entries.at(-1);
    expect(last.outcome).toBe("error");
    expect(last.url).not.toBe("https://bank.example.com/statement");
    void usersTab;
  });

  // @edge — the element map is keyed by tab id, so a surviving map resolves
  // coordinates for a RECYCLED id: the agent asks for element [3] and gets a
  // point from a page that no longer exists, on a tab that is now someone
  // else's. Dropped by the same listener, for the same reason.
  it("drops the element map for a removed tab", async () => {
    const realPageState = await import("../src/background/pageState.js");
    const mine = await agentOpenedTab("https://allowed.test/one");
    evaluateResult = {
      url: "https://allowed.test/one",
      title: "One",
      elements: [{ id: 1, tag: "button", text: "Go", x: 10, y: 20 }],
    };
    await realPageState.capture(mine);
    expect(realPageState.hasMap(mine)).toBe(true);

    socket.handleTabRemoved(mine);

    expect(realPageState.hasMap(mine)).toBe(false);
    await expect(realPageState.lookup(mine, 1)).resolves.toBeNull();
  });

  // The listener itself, at the unit level: both handles are given up, and the
  // gate binding deliberately is NOT — clearing it would erase the evidence of
  // the very event it exists to catch.
  it("gives up both tab handles when Chrome reports a tab removed", async () => {
    const mine = await agentOpenedTab("https://allowed.test/one");
    expect((await socket.listAgentTabs()).map((t) => t.id)).toContain(mine);

    socket.handleTabRemoved(mine);

    expect((await socket.listAgentTabs()).map((t) => t.id)).not.toContain(mine);
    await expect(socket.switchToTab(mine)).rejects.toThrow(
      /only acts on its own tabs/
    );
  });

  it("ignores a removal event for a tab it never held", async () => {
    const mine = await agentOpenedTab("https://allowed.test/one");
    socket.handleTabRemoved(9999);
    expect((await socket.listAgentTabs()).map((t) => t.id)).toEqual([mine]);
  });

  // A non-numeric removal id must change nothing.
  //
  // BE HONEST ABOUT WHAT THIS PINS: the `typeof` guard in `handleTabRemoved` is
  // currently INERT, and a mutation removing it correctly survives these cases.
  // I first justified it as stopping `handleTabRemoved(null)` from matching
  // `agentTabId === null` — that reasoning is WRONG and driving it proved so:
  // when a tab is held, `agentTabId` is a number, and when none is held there
  // is nothing to lose. `Set.delete` and `===` reject these values anyway.
  //
  // The cases stay because they pin the BEHAVIOUR (a junk event is a no-op)
  // rather than the guard, and that behaviour must hold however the function is
  // later written — the moment someone adds a `Map` keyed by id, or a `find`,
  // the coercion rules stop being so forgiving. The guard itself stays as one
  // cheap line on a listener fed by an external event source. Recorded in the
  // harness as an equivalent mutant rather than left to look like coverage.
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a numeric string", "1"],
    ["an object", {}],
  ])("ignores a removal event carrying %s", async (_label, value) => {
    const mine = await agentOpenedTab("https://allowed.test/one");
    socket.handleTabRemoved(value);
    // Still owned, still current, still listed.
    expect((await socket.listAgentTabs()).map((t) => t.id)).toEqual([mine]);
    expect(await socket.ensureAgentTab()).toBe(mine);
    expect(tabCreateCalls).toHaveLength(1);
  });

  // page_tabs must not even enumerate the user's tabs: the urls a user has
  // open are exactly what a compromised server would most like to learn, and
  // ownership now bounds that too.
  it("does not report the user's tabs to page_tabs", async () => {
    localStore[ALLOWLIST_KEY] = ["allowed.test"];
    const mine = await agentOpenedTab("https://allowed.test/agent-page");
    await chrome.tabs.create({
      url: "https://allowed.test/user-draft",
      active: false,
    });

    const result = await handle(
      { requestId: "t1", cmd: "tabs" },
      {
        loadAllowlist: (await import("../src/background/allowlist.js"))
          .loadAllowlist,
        record: auditLog.record,
        agentTabUrl: socket.agentTabUrl,
        ensureAgentTab: socket.ensureAgentTab,
        listAgentTabs: socket.listAgentTabs,
        switchToTab: socket.switchToTab,
        closeTab: socket.closeTab,
        cdp: { attach: async () => {}, detach: async () => {} },
        pageState: { invalidate: () => {} },
      }
    );

    expect(result.ok).toBe(true);
    expect(result.data.tabs.map((t) => t.id)).toEqual([mine]);
    // `withheld` counts what the ALLOWLIST hid, and the user's tab was never in
    // the set at all — so it must not be reported as withheld either, which
    // would itself disclose that the user has tabs open.
    expect(result.data.withheld).toBe(0);
  });

  // @edge — page_navigate is the ONE command that never asks for the current
  // url, because it must work with no usable tab. The binding must not break
  // that bootstrap.
  it("still lets page_navigate bootstrap with no gated tab", async () => {
    localStore[ALLOWLIST_KEY] = ["allowed.test"];
    const navigated = [];
    const result = await handle(
      { requestId: "r3", cmd: "navigate", url: "https://allowed.test/start" },
      {
        loadAllowlist: (await import("../src/background/allowlist.js"))
          .loadAllowlist,
        record: auditLog.record,
        agentTabUrl: socket.agentTabUrl,
        ensureAgentTab: socket.ensureAgentTab,
        listAgentTabs: socket.listAgentTabs,
        switchToTab: socket.switchToTab,
        closeTab: socket.closeTab,
        cdp: {
          attach: async () => {},
          detach: async () => {},
          navigate: async (tabId, url) => navigated.push({ tabId, url }),
        },
        pageState: { invalidate: () => {} },
      }
    );
    expect(result.ok).toBe(true);
    expect(navigated).toHaveLength(1);
  });

  // @edge — a SURVIVOR the harness found, and the sharpest one: moving the
  // per-command reset OUT of the queue survived every case above. It runs
  // synchronously in the message handler there, so a second frame ARRIVING
  // while the first command is mid-flight clears the first command's binding —
  // between its gate check and its action, which is precisely the window the
  // binding exists to close. The gate then judges tab A and the action lands on
  // tab B, with the server having done nothing unusual: two commands in quick
  // succession is ordinary traffic.
  it("a second frame arriving mid-command does not clear the first's binding", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const outcomes = [];
    const { ws } = await connectAndOpen({
      onCommand: async (command) => {
        const url = await socket.agentTabUrl();
        if (command.requestId === "a") await gate;
        try {
          const id = await socket.ensureAgentTab();
          outcomes.push({ id: command.requestId, url, tab: id });
        } catch (error) {
          outcomes.push({ id: command.requestId, url, error: error.message });
        }
        return { requestId: command.requestId, ok: true };
      },
    });

    ws.deliver({ requestId: "a", cmd: "state" });
    await flush(); // "a" is now past its gate check and waiting.
    ws.deliver({ requestId: "b", cmd: "state" }); // arrives mid-command
    await flush();
    tabs.delete(1); // the user closes the gated tab
    release();
    await socket.__commandQueue();

    // "a" was gated on tab 1 and tab 1 is gone, so it must refuse rather than
    // act on the replacement tab it never had checked.
    expect(outcomes[0].id).toBe("a");
    expect(outcomes[0].error).toMatch(
      /between the allowlist check and the action/
    );
  });

  // @edge — a SURVIVOR the harness found. The case below did NOT catch a
  // missing reset, because every command in it calls `agentTabUrl`, which
  // overwrites the binding on the way past. The reset only becomes observable
  // for a command that never asks for the url — page_navigate, the one command
  // whose whole point is working with no usable tab. Without the reset, a
  // navigate following any other command inherits that command's binding and
  // fails against a tab it was never gated on.
  it("does not leak a previous command's binding into a navigate", async () => {
    const { ws } = await connectAndOpen({
      onCommand: async (command) => {
        if (command.cmd === "state") {
          await socket.agentTabUrl();
          await socket.ensureAgentTab();
          return { requestId: command.requestId, ok: true };
        }
        // Like page_navigate: never asks for the current url.
        return {
          requestId: command.requestId,
          ok: true,
          data: { id: await socket.ensureAgentTab() },
        };
      },
    });
    ws.deliver({ requestId: "a", cmd: "state" });
    await socket.__commandQueue();
    // The user closes the agent's tab between the two commands.
    tabs.delete(1);
    ws.deliver({ requestId: "b", cmd: "navigate" });
    await socket.__commandQueue();
    const replies = ws.frames();
    expect(replies[1].ok).toBe(true);
    expect(replies[1].data.id).toBe(2);
  });

  // @edge — the binding is per command. Without a reset, the SECOND command in
  // a connection would be judged against the first's tab and fail for nothing
  // once the tab legitimately changed.
  it("clears the binding between commands", async () => {
    const { ws, onCommand } = await connectAndOpen({
      onCommand: async (command) => {
        const url = await socket.agentTabUrl();
        const id = await socket.ensureAgentTab();
        return { requestId: command.requestId, ok: true, data: { url, id } };
      },
    });
    ws.deliver({ requestId: "a", cmd: "state" });
    await socket.__commandQueue();
    // The user closes it between commands, legitimately.
    tabs.delete(1);
    ws.deliver({ requestId: "b", cmd: "state" });
    await socket.__commandQueue();
    const replies = ws.frames();
    expect(replies).toHaveLength(2);
    expect(replies[0].ok).toBe(true);
    expect(replies[1].ok).toBe(true);
    expect(replies[1].data.id).not.toBe(replies[0].data.id);
    void onCommand;
  });
});

/* ========================================================================= */
describe("commands on the wire", () => {
  it("answers a command with the handler's reply", async () => {
    const { ws, onCommand } = await connectAndOpen({
      onCommand: j.fn(async (command) => ({
        requestId: command.requestId,
        ok: true,
        data: { seen: command.cmd },
      })),
    });
    ws.deliver({ requestId: "r1", cmd: "state" });
    await socket.__commandQueue();
    expect(onCommand).toHaveBeenCalledWith({ requestId: "r1", cmd: "state" });
    expect(ws.frames()).toEqual([
      { requestId: "r1", ok: true, data: { seen: "state" } },
    ]);
  });

  it("ignores a frame it cannot parse instead of taking the connection down", async () => {
    const { ws, onCommand } = await connectAndOpen();
    expect(() => ws.deliver("{not json")).not.toThrow();
    await flush();
    expect(onCommand).not.toHaveBeenCalled();
    expect(socket.state().status).toBe("online");
  });

  // @edge — commands drive ONE tab. Two running concurrently would interleave
  // clicks and navigations on the same page, and would share the per-command
  // tab binding.
  it("runs commands one at a time", async () => {
    let active = 0;
    let overlapped = false;
    const { ws } = await connectAndOpen({
      onCommand: async (command) => {
        active += 1;
        if (active > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 0));
        active -= 1;
        return { requestId: command.requestId, ok: true };
      },
    });
    ws.deliver({ requestId: "a", cmd: "state" });
    ws.deliver({ requestId: "b", cmd: "state" });
    ws.deliver({ requestId: "c", cmd: "state" });
    await socket.__commandQueue();
    expect(overlapped).toBe(false);
    expect(ws.frames().map((f) => f.requestId)).toEqual(["a", "b", "c"]);
  });

  // @edge — a handler that throws would otherwise leave the queue's promise
  // rejected and every following command silently dropped.
  it("keeps serving commands after a handler throws", async () => {
    const seen = [];
    const { ws } = await connectAndOpen({
      onCommand: async (command) => {
        seen.push(command.requestId);
        if (command.requestId === "a") throw new Error("handler broke");
        return { requestId: command.requestId, ok: true };
      },
    });
    ws.deliver({ requestId: "a", cmd: "state" });
    await socket.__commandQueue();
    ws.deliver({ requestId: "b", cmd: "state" });
    await socket.__commandQueue();
    expect(seen).toEqual(["a", "b"]);
    expect(ws.frames().map((f) => f.requestId)).toContain("b");
  });

  // @edge — `handle` is DOCUMENTED never to reject, and as of de8cf157 it wraps
  // every `auditLog.record` call so a full store cannot break that. This case
  // does not trust either fact: the socket is the last line, and it must hold
  // even if a future edit to dispatch.js reintroduces a rejecting path.
  //
  // Surviving the rejection is not enough on its own. Answering NOTHING leaves
  // the server waiting out its full BROWSER_COMPANION_TIMEOUT_MS for a reply
  // that can never arrive, and it then reports "timed out after 20000ms" — which
  // reads as a slow page when the truth is that the extension broke. So a
  // rejecting handler must produce a REPLY, carrying the requestId so the
  // server's correlation table can settle that command rather than every
  // command.
  it("answers the server when the command handler rejects", async () => {
    const { ws } = await connectAndOpen({
      onCommand: async () => {
        throw new Error("QUOTA_BYTES quota exceeded");
      },
    });
    ws.deliver({ requestId: "r1", cmd: "click", id: 3 });
    await socket.__commandQueue();

    expect(ws.frames()).toHaveLength(1);
    const answer = ws.frames()[0];
    expect(answer.requestId).toBe("r1");
    // NOT a success. The agent must not read "the click happened" from a
    // command whose outcome the extension cannot vouch for.
    expect(answer.ok).toBe(false);
    expect(answer.error).toMatch(/QUOTA_BYTES quota exceeded/);
    // Said in words the agent can act on, since the agent reasons over this
    // string: it has to learn the action's outcome is UNKNOWN, not merely that
    // something failed — a retry of a click that already landed clicks twice.
    expect(answer.error).toMatch(/may or may not/i);
    expect(socket.state().status).toBe("online");
  });

  it("keeps the connection and the queue alive after a rejecting handler", async () => {
    const { ws } = await connectAndOpen({
      onCommand: async (command) => {
        if (command.requestId === "a") throw new Error("audit write failed");
        return { requestId: command.requestId, ok: true };
      },
    });
    ws.deliver({ requestId: "a", cmd: "state" });
    await socket.__commandQueue();
    ws.deliver({ requestId: "b", cmd: "state" });
    await socket.__commandQueue();
    expect(ws.frames().map((f) => f.requestId)).toEqual(["a", "b"]);
    expect(ws.frames()[0].ok).toBe(false);
    expect(ws.frames()[1].ok).toBe(true);
    expect(socket.state().status).toBe("online");
  });

  // @edge — a SURVIVOR the harness found: the module bounds the echoed throw
  // message and nothing tested the bound. An error message can carry
  // page-derived or server-derived text, so it is untrusted by origin even
  // though it arrives as an exception — and this path runs precisely when
  // dispatch.js's own bounding did NOT, because the throw escaped it. A 5MB
  // message would otherwise be written straight back onto the wire.
  it("bounds an untrusted throw message instead of echoing it whole", async () => {
    const { ws } = await connectAndOpen({
      onCommand: async () => {
        throw new Error("x".repeat(200_000));
      },
    });
    ws.deliver({ requestId: "r1", cmd: "state" });
    await socket.__commandQueue();
    const answer = ws.frames()[0];
    expect(answer.ok).toBe(false);
    // Bounded, but still long enough to carry a real message.
    expect(answer.error.length).toBeLessThan(5_000);
    expect(answer.error.length).toBeGreaterThan(100);
  });

  // @edge — also bounded: `cmd` is server-controlled and reaches this reply on
  // a path where no check has passed.
  it("bounds a server-controlled cmd in the failure reply", async () => {
    const { ws } = await connectAndOpen({
      onCommand: async () => {
        throw new Error("broke");
      },
    });
    ws.deliver({ requestId: "r1", cmd: "z".repeat(200_000) });
    await socket.__commandQueue();
    expect(ws.frames()[0].error.length).toBeLessThan(10_000);
  });

  // @edge — the queue's own last-resort catch, which the harness showed was no
  // longer reachable through `onCommand` once the inner try/catch landed. It IS
  // still reachable: an error object whose `message` getter throws makes the
  // reply BUILDER throw. That is not contrived — an error's message can be
  // page-derived, and a hostile or merely exotic object reaches here as data.
  // The socket must survive it and keep serving.
  it("survives an error object that throws while being read", async () => {
    const hostile = {
      get message() {
        throw new Error("message getter exploded");
      },
    };
    const { ws } = await connectAndOpen({
      onCommand: async (command) => {
        if (command.requestId === "a") throw hostile;
        return { requestId: command.requestId, ok: true };
      },
    });
    ws.deliver({ requestId: "a", cmd: "state" });
    await socket.__commandQueue();
    expect(socket.state().status).toBe("online");

    // And the connection still serves the next command.
    ws.deliver({ requestId: "b", cmd: "state" });
    await socket.__commandQueue();
    expect(ws.frames().map((f) => f.requestId)).toContain("b");
  });

  // @edge — F3. A handler returning `null` means "do not reply" — a paused
  // browser's guard returns it for a frame with no requestId, and a reply with
  // no id settles nothing on the server, whose pending map is keyed by it.
  // Without the check on the SHARED send path, `JSON.stringify(null)` wrote the
  // literal string "null" onto the wire. The server drops it, so it was
  // cosmetic; the reason it matters is that the convention was honoured by one
  // branch's own early return and by nothing else, so the next handler to
  // return null would inherit the bug.
  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("writes nothing when the handler returns %s", async (_label, value) => {
    const { ws } = await connectAndOpen({ onCommand: async () => value });
    ws.deliver({ requestId: "r1", cmd: "state" });
    await socket.__commandQueue();
    expect(ws.sent).toEqual([]);
    expect(ws.discarded).toEqual([]);
    expect(socket.state().status).toBe("online");
  });

  it("still serves the next command after a no-reply", async () => {
    const { ws } = await connectAndOpen({
      onCommand: async (command) =>
        command.requestId === "a"
          ? null
          : { requestId: command.requestId, ok: true },
    });
    ws.deliver({ requestId: "a", cmd: "state" });
    await socket.__commandQueue();
    ws.deliver({ requestId: "b", cmd: "state" });
    await socket.__commandQueue();
    expect(ws.frames().map((f) => f.requestId)).toEqual(["b"]);
  });

  // @edge — a rejection with no requestId must NOT be answered with an
  // undefined one. The server keys its pending table on requestId, and
  // `pending.get(undefined)` is a miss that drops the frame silently — so a
  // reply built from a frame that carried no id is noise on the wire at best.
  it("does not send a reply for a rejected frame that carried no requestId", async () => {
    const { ws } = await connectAndOpen({
      onCommand: async () => {
        throw new Error("broke");
      },
    });
    ws.deliver({ cmd: "state" });
    await socket.__commandQueue();
    expect(ws.frames()).toHaveLength(0);
    expect(socket.state().status).toBe("online");
  });

  // @edge — THE CLOSE-BETWEEN-SEND-AND-REPLY CASE. A browser WebSocket does not
  // throw for `send` on a CLOSING/CLOSED socket; it discards silently. Without a
  // readyState guard the reply vanishes with no error anywhere.
  it("does not pretend to have replied on a socket that closed mid-command", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { ws } = await connectAndOpen({
      onCommand: async (command) => {
        await gate;
        return { requestId: command.requestId, ok: true };
      },
    });
    ws.deliver({ requestId: "r1", cmd: "state" });
    await flush();
    ws.serverClose(1006);
    release();
    await socket.__commandQueue();
    // `discarded` is asserted empty as well as `sent`, and that is the half
    // that kills the mutation: without the readyState guard the client WOULD
    // call `send`, the browser would swallow it silently, and `sent` would
    // still be empty — a test asserting only `sent` would pass on the broken
    // client. Nothing may reach the socket at all.
    expect(ws.sent).toHaveLength(0);
    expect(ws.discarded).toHaveLength(0);
  });

  // The fake's own contract, asserted directly so the reasoning above is not
  // merely a comment: a browser WebSocket does NOT throw for a send on a closed
  // socket, so "no exception" is not evidence a reply was delivered.
  it("models the browser rule that a send on a closed socket is silently dropped", () => {
    const fake = new FakeSocket("wss://x.test/", []);
    fake.open();
    fake.serverClose(1006);
    expect(() => fake.send("late")).not.toThrow();
    expect(fake.sent).toHaveLength(0);
    expect(fake.discarded).toEqual(["late"]);
  });

  // @edge — the reply must go out on the socket the command CAME IN on. On a
  // replacement socket the server logs it as a cross-connection echo and drops
  // it, which reads as an attack rather than as a lost reply.
  it("never sends a reply on a socket that replaced the one the command arrived on", async () => {
    j.useFakeTimers();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await socket.connect({
        apiBase: "https://x.test/api",
        apiKey: "brx-abc",
        onCommand: async (command) => {
          await gate;
          return { requestId: command.requestId, ok: true };
        },
      });
      const first = sockets[0];
      first.open();
      first.deliver({ requestId: "r1", cmd: "state" });
      await Promise.resolve();

      first.serverClose(1006);
      j.advanceTimersByTime(socket.RECONNECT_MAX_MS + 1);
      expect(sockets).toHaveLength(2);
      const second = sockets[1];
      second.open();

      release();
      await socket.__commandQueue();
      // Nothing on the replacement, by either route. The reply is lost either
      // way — the point is that it is lost quietly on the dead socket rather
      // than arriving on a live one, where the server logs it as a
      // cross-connection echo and it reads as an attack.
      expect(second.sent).toHaveLength(0);
      expect(second.discarded).toHaveLength(0);
      expect(first.sent).toHaveLength(0);
    } finally {
      j.useRealTimers();
    }
  });

  // @edge — a server that never replies is the server's problem (it has its own
  // 20s timeout); a server that sends a command and then goes quiet must not
  // leave this client wedged.
  it("stays online and keeps accepting commands when a reply is never awaited", async () => {
    const { ws } = await connectAndOpen();
    ws.deliver({ requestId: "r1", cmd: "state" });
    await socket.__commandQueue();
    expect(socket.state().status).toBe("online");
    ws.deliver({ requestId: "r2", cmd: "state" });
    await socket.__commandQueue();
    expect(ws.frames()).toHaveLength(2);
  });

  it("ignores events from a socket it has already replaced", async () => {
    const { ws: first } = await connectAndOpen();
    await socket.connect({
      apiBase: "https://y.test/api",
      apiKey: "brx-abc",
      onCommand: async () => ({}),
    });
    // The stale socket is still emitting: none of it may touch live state.
    first.serverClose(socket.CLOSE_EVICTED);
    await flush();
    expect(socket.state().status).not.toBe("evicted");
  });
});

/* ========================================================================= */
describe("state()", () => {
  it("starts idle with no error", () => {
    expect(socket.state()).toEqual({ status: "idle", lastError: null });
  });

  it("reports connecting before the handshake completes", async () => {
    await socket.connect({
      apiBase: "https://x.test/api",
      apiKey: "brx-abc",
      onCommand: async () => ({}),
    });
    expect(socket.state().status).toBe("connecting");
  });

  it("reports online once the socket opens, and clears the last error", async () => {
    await socket.connect({
      apiBase: "https://x.test/api",
      apiKey: "brx-abc",
      onCommand: async () => ({}),
    });
    sockets[0].fail();
    expect(socket.state().lastError).toMatch(/Could not reach/);
    sockets[0].open();
    expect(socket.state()).toEqual({ status: "online", lastError: null });
  });

  it("records why the connection failed", async () => {
    await socket.connect({
      apiBase: "https://x.test/api",
      apiKey: "brx-abc",
      onCommand: async () => ({}),
    });
    sockets[0].fail();
    expect(socket.state().lastError).toBe(
      "Could not reach the AnythingLLM server."
    );
  });
});

/* ========================================================================= */
describe("ping", () => {
  it("writes nothing when there is no socket", () => {
    expect(socket.ping()).toBe(false);
  });

  // @edge — the readyState guard, again on the ping path: a ping "sent" on a
  // dead socket would report success and keep nothing alive.
  it("writes nothing on a socket that has not opened yet", async () => {
    await socket.connect({
      apiBase: "https://x.test/api",
      apiKey: "brx-abc",
      onCommand: async () => ({}),
    });
    expect(sockets[0].readyState).toBe(FakeSocket.CONNECTING);
    expect(socket.ping()).toBe(false);
    expect(sockets[0].sent).toHaveLength(0);
  });

  it("writes nothing on a closing socket", async () => {
    const { ws } = await connectAndOpen();
    ws.close();
    expect(socket.ping()).toBe(false);
    expect(ws.sent).toHaveLength(0);
  });
});
