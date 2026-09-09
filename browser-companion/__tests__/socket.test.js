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
      Object.assign(tabs.get(id), patch);
      return tabs.get(id);
    },
    async remove(id) {
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
      tabs.delete(id);
    },
  };
}

/* ---- chrome.alarms ---- */
let alarmCreates;
let alarmClears;

/* ---- chrome.storage ---- */
let localStore;
let syncStore;
/** Set to an Error to make every `storage.local.set` reject. */
let localSetFails;
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
    sendCommand: async () => ({ result: { value: null } }),
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
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

beforeEach(() => {
  sockets = [];
  constructorThrows = null;
  globalThis.chrome.tabs = makeTabs();
  alarmCreates = [];
  alarmClears = [];
  localStore = {};
  syncStore = {};
  localSetFails = null;
  syncGetFails = null;
  auditLog.resetWriteFailure();
  socket.__reset();
});

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
    j.useFakeTimers();
    try {
      await socket.connect({
        apiBase: "https://x.test/api",
        apiKey: "brx-abc",
        onCommand: async () => ({}),
      });
      sockets[0].open();
      sockets[0].serverClose(code);
      // Well past RECONNECT_MAX_MS: if any timer was armed, it has fired.
      j.advanceTimersByTime(socket.RECONNECT_MAX_MS * 10);
      expect(sockets).toHaveLength(1);
    } finally {
      j.useRealTimers();
    }
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

  it("lists every tab unfiltered, leaving the filtering to the gate", async () => {
    await chrome.tabs.create({ url: "https://allowed.test/a", active: false });
    await chrome.tabs.create({ url: "https://forbidden.test/b", active: false });
    const listed = await socket.listAgentTabs();
    expect(listed.map((t) => t.url)).toEqual([
      "https://allowed.test/a",
      "https://forbidden.test/b",
    ]);
  });

  // @edge — switching without ADOPTING the tab would leave every following
  // command acting on the old one: the agent believes it is on the page it
  // switched to and reads, clicks and closes somewhere else.
  it("adopts the tab it switches to, so later commands act on it", async () => {
    await socket.ensureAgentTab();
    const other = await chrome.tabs.create({
      url: "https://other.test/",
      active: false,
    });
    await socket.switchToTab(other.id);
    expect(tabs.get(other.id).active).toBe(true);
    expect(await socket.ensureAgentTab()).toBe(other.id);
    expect(await socket.agentTabUrl()).toBe("https://other.test/");
  });

  // @edge — a SURVIVOR the harness found. This originally asserted only that a
  // NEW tab appears afterwards, which happens either way: without the forget,
  // `agentTabId` names a closed tab and the next `chrome.tabs.get` REJECTS, and
  // the catch inside `doResolveAgentTab` recovers by accident. The setup could
  // therefore never distinguish the two. Asserting on the tab TABLE — that the
  // recovery is a deliberate create and not a rescued throw — is what makes it
  // observable, and the stale-id assertion below is what proves the state was
  // actually cleared rather than merely worked around.
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
    // The agent's tab is on an allowed page.
    const agent = await chrome.tabs.create({
      url: "https://allowed.test/page",
      active: false,
    });
    await socket.switchToTab(agent.id);

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
    expect(closed).toEqual([agent.id]);

    // Now the race: the gate resolves an allowed url, then the tab vanishes.
    const agent2 = await chrome.tabs.create({
      url: "https://allowed.test/page",
      active: false,
    });
    await socket.switchToTab(agent2.id);
    const victim = await chrome.tabs.create({
      url: "https://bank.test/transfer",
      active: false,
    });

    const racing = {
      ...deps,
      agentTabUrl: async () => {
        const url = await socket.agentTabUrl();
        tabs.delete(agent2.id); // The user closes it right here.
        return url;
      },
    };
    const raced = await handle({ requestId: "r2", cmd: "close" }, racing);

    expect(raced.ok).toBe(false);
    expect(raced.error).toMatch(/between the allowlist check and the action/);
    // The unrelated tab is untouched, which is the property that matters.
    expect(closed).toEqual([agent.id]);
    expect(tabs.has(victim.id)).toBe(true);
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
    expect(ws.frames().map((f) => f.requestId)).toEqual(["b"]);
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
