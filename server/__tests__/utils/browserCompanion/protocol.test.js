/* global jest */
const { describe, it, expect, beforeEach } = require("@jest/globals");
const protocol = require("../../../utils/browserCompanion/protocol");

function fakeSocket() {
  const sent = [];
  return {
    sent,
    send(raw) {
      sent.push(JSON.parse(raw));
    },
    lastRequestId() {
      return sent[sent.length - 1].requestId;
    },
  };
}

describe("browserCompanion protocol", () => {
  beforeEach(() => protocol.__reset());

  it("resolves with the reply carrying the matching requestId", async () => {
    const socket = fakeSocket();
    const pending = protocol.send({ socket, cmd: "click", payload: { id: 12 } });
    protocol.handleMessage({
      socket,
      raw: JSON.stringify({
        requestId: socket.lastRequestId(),
        ok: true,
        data: { url: "https://x.test/" },
      }),
    });
    await expect(pending).resolves.toEqual({
      ok: true,
      data: { url: "https://x.test/" },
      error: null,
      // Always present, null when the extension sent none — see the `warning`
      // cases below. Asserted with toEqual rather than objectContaining so an
      // extra field appearing in the projection reddens here.
      warning: null,
    });
  });

  // @edge — คำสั่งซ้อนกันต้องไม่สลับผลกัน
  it("keeps concurrent commands paired with their own replies", async () => {
    const socket = fakeSocket();
    const first = protocol.send({ socket, cmd: "read", payload: {} });
    const firstId = socket.lastRequestId();
    const second = protocol.send({ socket, cmd: "click", payload: { id: 3 } });
    const secondId = socket.lastRequestId();

    expect(firstId).not.toBe(secondId);
    protocol.handleMessage({
      socket,
      raw: JSON.stringify({ requestId: secondId, ok: true, data: "second" }),
    });
    protocol.handleMessage({
      socket,
      raw: JSON.stringify({ requestId: firstId, ok: true, data: "first" }),
    });

    expect((await first).data).toBe("first");
    expect((await second).data).toBe("second");
  });

  it("passes an extension-side failure through as error", async () => {
    const socket = fakeSocket();
    const pending = protocol.send({ socket, cmd: "click", payload: { id: 1 } });
    protocol.handleMessage({
      socket,
      raw: JSON.stringify({
        requestId: socket.lastRequestId(),
        ok: false,
        error: "denied: domain not in allowlist",
      }),
    });
    await expect(pending).resolves.toEqual({
      ok: false,
      data: null,
      error: "denied: domain not in allowlist",
      warning: null,
    });
  });

  it("times out instead of hanging when no reply arrives", async () => {
    const socket = fakeSocket();
    const result = await protocol.send({
      socket,
      cmd: "click",
      payload: { id: 1 },
      timeoutMs: 20,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });

  // @edge — ผลที่ไม่มีใครรอ ต้องทิ้งเงียบ ไม่ throw
  it("drops a reply whose requestId nobody is waiting on", () => {
    const socket = fakeSocket();
    expect(() =>
      protocol.handleMessage({
        socket,
        raw: JSON.stringify({ requestId: "r_nobody", ok: true }),
      })
    ).not.toThrow();
  });

  it("ignores malformed json rather than crashing the socket", () => {
    const socket = fakeSocket();
    expect(() =>
      protocol.handleMessage({ socket, raw: "not json" })
    ).not.toThrow();
  });

  // @edge — a reply arriving after its timeout fired must be dropped silently.
  // Separate from the "nobody is waiting" case: here the caller HAS already been
  // resolved with a timeout, so a second resolve would be a no-op the test
  // cannot see. What it can see is that the answer the caller got stays the
  // timeout, and that the late frame does not throw out of the message handler.
  it("drops a reply that arrives after its own timeout fired", async () => {
    const socket = fakeSocket();
    const pending = protocol.send({
      socket,
      cmd: "read",
      payload: {},
      timeoutMs: 10,
    });
    const requestId = socket.lastRequestId();
    const timedOut = await pending;
    expect(timedOut.ok).toBe(false);

    expect(() =>
      protocol.handleMessage({
        socket,
        raw: JSON.stringify({ requestId, ok: true, data: "too late" }),
      })
    ).not.toThrow();
    await expect(pending).resolves.toBe(timedOut);
  });

  // A settled command must leave the correlation table. The map lives for the
  // life of the process, so an entry that is never deleted is a leak no caller
  // can observe — they already got their answer.
  it("clears the pending entry on reply, on failure and on timeout", async () => {
    const socket = fakeSocket();

    const replied = protocol.send({ socket, cmd: "read", payload: {} });
    protocol.handleMessage({
      socket,
      raw: JSON.stringify({ requestId: socket.lastRequestId(), ok: true, data: 1 }),
    });
    await replied;
    expect(protocol.__pendingCount()).toBe(0);

    const failed = protocol.send({ socket, cmd: "click", payload: {} });
    protocol.handleMessage({
      socket,
      raw: JSON.stringify({ requestId: socket.lastRequestId(), ok: false, error: "no" }),
    });
    await failed;
    expect(protocol.__pendingCount()).toBe(0);

    await protocol.send({ socket, cmd: "click", payload: {}, timeoutMs: 10 });
    expect(protocol.__pendingCount()).toBe(0);
  });

  // The worst failure this module can have: two commands sharing a requestId
  // means one caller reads another's page state, silently. A payload key must
  // never be able to overwrite the correlation fields.
  it("does not let a payload overwrite requestId or cmd", async () => {
    const socket = fakeSocket();
    const pending = protocol.send({
      socket,
      cmd: "read",
      payload: { requestId: "r_attacker", cmd: "evil", id: 7 },
    });

    const frame = socket.sent[socket.sent.length - 1];
    expect(frame.requestId).not.toBe("r_attacker");
    expect(frame.cmd).toBe("read");
    expect(frame.id).toBe(7);

    // The forged id resolves nothing, so the real command is still waiting.
    protocol.handleMessage({
      socket,
      raw: JSON.stringify({ requestId: "r_attacker", ok: true, data: "hijacked" }),
    });
    expect(protocol.__pendingCount()).toBe(1);

    protocol.handleMessage({
      socket,
      raw: JSON.stringify({ requestId: frame.requestId, ok: true, data: "mine" }),
    });
    expect((await pending).data).toBe("mine");
  });

  // A socket that throws on send — ws does this for CONNECTING(0), and any
  // non-ws transport may — must come back as an error rather than rejecting.
  // NOTE: this is deliberately no longer the closed-socket case. Real ws does
  // NOT throw on a closed socket (see the readyState tests below); an earlier
  // version of this suite tested only a throwing fake and therefore asserted
  // nothing about the disconnect path that actually occurs in production.
  it("resolves as an error when the socket throws on send", async () => {
    const socket = {
      send() {
        throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
      },
    };
    const result = await protocol.send({ socket, cmd: "click", payload: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/readyState 0 \(CONNECTING\)/);
    expect(protocol.__pendingCount()).toBe(0);
  });

  // A non-Error throw has no `.message`. Without coercion the documented
  // `error: string|null` renders as "could not be sent: undefined".
  it("keeps error a string when the socket throws a non-Error", async () => {
    const socket = {
      send() {
        throw "socket exploded"; // eslint-disable-line no-throw-literal
      },
    };
    const result = await protocol.send({ socket, cmd: "click", payload: {} });
    expect(typeof result.error).toBe("string");
    expect(result.error).toMatch(/socket exploded/);
  });

  // Q-1: the disconnect path that actually happens. ws throws only for
  // CONNECTING; for CLOSING(2)/CLOSED(3) send() calls sendAfterClose() and
  // returns silently, so a try/catch never fires and the command would wait out
  // the full timeout for an answer that can never arrive.
  describe("a socket that is not OPEN", () => {
    it.each([
      ["CLOSED", 3],
      ["CLOSING", 2],
      ["CONNECTING", 0],
    ])("answers immediately when readyState is %s", async (_name, state) => {
      let wrote = false;
      const socket = {
        readyState: state,
        send() {
          wrote = true;
        },
      };

      const started = Date.now();
      const result = await protocol.send({
        socket,
        cmd: "read",
        payload: {},
        // Long enough that a timeout-based settle is unmistakable.
        timeoutMs: 30_000,
      });

      expect(Date.now() - started).toBeLessThan(1_000);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not connected/i);
      expect(result.error).not.toMatch(/timed out/i);
      expect(wrote).toBe(false);
      expect(protocol.__pendingCount()).toBe(0);
    });

    it("still writes to a socket with no readyState at all", async () => {
      // A test double or a non-ws transport must not be refused.
      const socket = fakeSocket();
      const pending = protocol.send({ socket, cmd: "read", payload: {} });
      expect(socket.sent).toHaveLength(1);
      protocol.handleMessage({
        socket,
        raw: JSON.stringify({
          requestId: socket.lastRequestId(),
          ok: true,
          data: "ok",
        }),
      });
      expect((await pending).data).toBe("ok");
    });

    // The premise behind the readyState guard, asserted against the real
    // library rather than a fake: if ws ever starts throwing on a closed
    // socket, this test says so instead of the guard quietly becoming dead code.
    it("does not throw on a real terminated ws socket (the reason the guard exists)", async () => {
      const WebSocket = require("ws");
      const wss = new WebSocket.Server({ port: 0 });
      try {
        const serverSocket = await new Promise((resolve, reject) => {
          wss.on("connection", resolve);
          wss.on("error", reject);
          wss.on("listening", () => {
            const client = new WebSocket(`ws://127.0.0.1:${wss.address().port}`);
            client.on("error", reject);
          });
        });

        await new Promise((resolve) => {
          serverSocket.on("close", resolve);
          serverSocket.terminate();
        });
        expect(serverSocket.readyState).toBe(3);
        expect(() => serverSocket.send("x")).not.toThrow();

        const started = Date.now();
        const result = await protocol.send({
          socket: serverSocket,
          cmd: "read",
          payload: {},
          timeoutMs: 30_000,
        });
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(result.error).toMatch(/not connected/i);
      } finally {
        await new Promise((resolve) => wss.close(resolve));
      }
    });
  });

  // Q-3: a reply must resolve a command only on the socket it was written to.
  // Without this, an extension echoing another connection's requestId resolves
  // that caller with its own data — no error, no log, silently wrong.
  it("ignores a reply echoed on a different socket", async () => {
    const alice = fakeSocket();
    const mallory = fakeSocket();

    const pending = protocol.send({ socket: alice, cmd: "read", payload: {} });
    const requestId = alice.lastRequestId();
    expect(mallory.sent).toHaveLength(0);

    protocol.handleMessage({
      socket: mallory,
      raw: JSON.stringify({ requestId, ok: true, data: "hijacked" }),
    });
    expect(protocol.__pendingCount()).toBe(1);

    protocol.handleMessage({
      socket: alice,
      raw: JSON.stringify({ requestId, ok: true, data: "mine" }),
    });
    expect((await pending).data).toBe("mine");
  });

  // The non-adversarial variant: the same user's extension reconnects (the
  // registry evicts and replaces the socket) with a command still in flight.
  // The reply would come from a different browser session at a different page.
  it("ignores a reply from a replacement socket for the same user", async () => {
    const oldSocket = fakeSocket();
    const pending = protocol.send({ socket: oldSocket, cmd: "read", payload: {} });
    const requestId = oldSocket.lastRequestId();

    const reconnected = fakeSocket();
    protocol.handleMessage({
      socket: reconnected,
      raw: JSON.stringify({ requestId, ok: true, data: "other tab" }),
    });
    expect(protocol.__pendingCount()).toBe(1);

    protocol.handleMessage({
      socket: oldSocket,
      raw: JSON.stringify({ requestId, ok: true, data: "same tab" }),
    });
    expect((await pending).data).toBe("same tab");
  });

  // Q-2: `ok` must be compared strictly. "false" is a truthy string, so an
  // extension doing `ok: String(success)` would turn a denied command into a
  // confident success carrying extension-supplied data.
  it.each([
    ["the string 'false'", "false"],
    ["the number 1", 1],
    ["the string 'true'", "true"],
    ["an object", {}],
  ])("does not treat %s as a successful reply", async (_name, okValue) => {
    const socket = fakeSocket();
    const pending = protocol.send({ socket, cmd: "read", payload: {} });
    protocol.handleMessage({
      socket,
      raw: JSON.stringify({
        requestId: socket.lastRequestId(),
        ok: okValue,
        data: "TREATED AS SUCCESS",
      }),
    });
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.data).toBeNull();
  });

  // The result shape is a contract tasks 3 and 4 destructure. A success reply
  // that omits `data` must still yield `data: null` — `undefined` would make
  // JSON.stringify drop the key entirely, so the field vanishes rather than
  // reading as empty.
  it("returns null data for a successful reply that carries none", async () => {
    const socket = fakeSocket();
    const pending = protocol.send({ socket, cmd: "read", payload: {} });
    protocol.handleMessage({
      socket,
      raw: JSON.stringify({ requestId: socket.lastRequestId(), ok: true }),
    });
    const result = await pending;
    expect(result.data).toBeNull();
    // The exact key set, not a subset: this is the projection that decides what
    // untrusted extension output reaches the model, so a field appearing in it
    // must be a deliberate decision that reddens this line first.
    expect(Object.keys(result).sort()).toEqual([
      "data",
      "error",
      "ok",
      "warning",
    ]);
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      ok: true,
      data: null,
      error: null,
      warning: null,
    });
  });

  // Q-5: `error` must stay a string, or task 3/4 code interpolating it gets
  // "[object Object]".
  it("coerces a non-string error from the extension to a string", async () => {
    const socket = fakeSocket();
    const pending = protocol.send({ socket, cmd: "read", payload: {} });
    protocol.handleMessage({
      socket,
      raw: JSON.stringify({
        requestId: socket.lastRequestId(),
        ok: false,
        error: { nested: "obj" },
      }),
    });
    const result = await pending;
    expect(typeof result.error).toBe("string");
    expect(result.error).toMatch(/nested/);
  });

  // Q-4: the caller's timeoutMs gets the same validation as the env var. Tasks
  // 3 and 4 are the callers; every value here otherwise fires on the next tick
  // and produces an error reading "timed out after nullms".
  describe("caller-supplied timeoutMs", () => {
    it.each([
      ["null", null],
      ["NaN", NaN],
      ["zero", 0],
      ["negative", -1],
      ["a non-numeric string", "fast"],
      ["an object", {}],
      ["past the 32-bit setTimeout ceiling", 2 ** 31],
    ])("does not time out on the next tick for %s", async (_name, timeoutMs) => {
      const socket = fakeSocket();
      const pending = protocol.send({
        socket,
        cmd: "read",
        payload: {},
        timeoutMs,
      });

      // A next-tick timeout settles well inside this window; a clamped one does
      // not settle at all, leaving the command available to its real reply.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(protocol.__pendingCount()).toBe(1);

      protocol.handleMessage({
        socket,
        raw: JSON.stringify({
          requestId: socket.lastRequestId(),
          ok: true,
          data: "answered",
        }),
      });
      const result = await pending;
      expect(result.ok).toBe(true);
      expect(result.data).toBe("answered");
    });

    it("honours a valid caller timeout over the module default", async () => {
      const socket = fakeSocket();
      const result = await protocol.send({
        socket,
        cmd: "read",
        payload: {},
        timeoutMs: 15,
      });
      expect(result.error).toMatch(/timed out after 15ms/);
    });
  });

  // Q-8: the contract says send never throws. Called with nothing, it did.
  it("resolves rather than throwing when called with no arguments", async () => {
    let thrown = null;
    let result = null;
    try {
      result = await protocol.send();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeNull();
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
  });

  // Q-6: __reset is the isolation seam every test in this file depends on, and
  // nothing verified it. A reset that clears the timer and drops the map entry
  // without resolving leaves the caller hung forever — to the Jest timeout,
  // rather than a useful failure.
  describe("drainSocket", () => {
    it("settles every command in flight on that socket", async () => {
      const socket = fakeSocket();
      const first = protocol.send({ socket, cmd: "read", timeoutMs: 60_000 });
      const second = protocol.send({ socket, cmd: "click", timeoutMs: 60_000 });
      expect(protocol.__pendingCount()).toBe(2);

      expect(protocol.drainSocket(socket)).toBe(2);

      for (const pending of [first, second]) {
        const settled = await Promise.race([
          pending,
          new Promise((resolve) => setTimeout(() => resolve("HUNG"), 100)),
        ]);
        expect(settled).not.toBe("HUNG");
        expect(settled.ok).toBe(false);
        expect(settled.data).toBeNull();
        // Must say the browser disconnected, and must NOT reuse the timeout
        // text: "timed out" reads as a slow page, which is the misleading
        // string this function exists to replace.
        expect(settled.error).toMatch(/disconnected before it answered/i);
        expect(settled.error).not.toMatch(/timed out/i);
        expect(settled.error).not.toMatch(/could not be sent/i);
      }
      expect(protocol.__pendingCount()).toBe(0);
    });

    // The reason __reset could not be reused: one extension disconnecting must
    // not settle a different user's in-flight commands.
    it("leaves other sockets' commands untouched", async () => {
      const mine = fakeSocket();
      const theirs = fakeSocket();
      const drained = protocol.send({
        socket: mine,
        cmd: "read",
        timeoutMs: 60_000,
      });
      const untouched = protocol.send({
        socket: theirs,
        cmd: "read",
        timeoutMs: 60_000,
      });

      expect(protocol.drainSocket(mine)).toBe(1);
      await expect(drained).resolves.toMatchObject({ ok: false });
      expect(protocol.__pendingCount()).toBe(1);

      // Still genuinely pending, not settled.
      const stillWaiting = await Promise.race([
        untouched,
        new Promise((resolve) => setTimeout(() => resolve("PENDING"), 50)),
      ]);
      expect(stillWaiting).toBe("PENDING");

      protocol.drainSocket(theirs);
      await expect(untouched).resolves.toMatchObject({ ok: false });
    });

    it("is a no-op for a socket with nothing in flight, and for no socket", () => {
      expect(protocol.drainSocket(fakeSocket())).toBe(0);
      expect(protocol.drainSocket(undefined)).toBe(0);
      expect(protocol.drainSocket(null)).toBe(0);
    });

    // A missing socket must not match entries that happen to carry a falsy
    // socket, or it would drain connections it has nothing to do with.
    it("does not drain entries when called with no socket", async () => {
      const socket = fakeSocket();
      const pending = protocol.send({ socket, cmd: "read", timeoutMs: 60_000 });

      expect(protocol.drainSocket(undefined)).toBe(0);
      expect(protocol.__pendingCount()).toBe(1);

      protocol.drainSocket(socket);
      await expect(pending).resolves.toMatchObject({ ok: false });
    });
  });

  describe("mismatched-socket diagnostics", () => {
    // A reply on the wrong socket is dropped correctly, but was previously
    // dropped SILENTLY — indistinguishable from an unknown requestId, and the
    // caller only ever saw a timeout. It is a wiring bug or a cross-connection
    // echo, never normal traffic, so warning cannot be noisy.
    it("warns when a reply arrives on a different socket than it was sent on", () => {
      const sent = fakeSocket();
      const other = fakeSocket();
      protocol.send({ socket: sent, cmd: "read", timeoutMs: 60_000 });
      const requestId = sent.lastRequestId();
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

      try {
        protocol.handleMessage({
          socket: other,
          raw: JSON.stringify({ requestId, ok: true, data: "PWN" }),
        });
        expect(warn).toHaveBeenCalledTimes(1);
        // The requestId is the correlation secret — it must not be logged.
        expect(String(warn.mock.calls[0][0])).not.toContain(requestId);
      } finally {
        warn.mockRestore();
      }
      // And the command is still pending: the frame resolved nothing.
      expect(protocol.__pendingCount()).toBe(1);
      protocol.drainSocket(sent);
    });

    // An unknown requestId is ordinary traffic (a late reply after a timeout),
    // so it must stay silent or the warning becomes noise and gets ignored.
    it("stays silent for an unknown requestId", () => {
      const socket = fakeSocket();
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        protocol.handleMessage({
          socket,
          raw: JSON.stringify({ requestId: "r_never-existed", ok: true }),
        });
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("__reset", () => {
    it("settles in-flight callers instead of abandoning them", async () => {
      const socket = fakeSocket();
      const pending = protocol.send({ socket, cmd: "read", payload: {} });
      expect(protocol.__pendingCount()).toBe(1);

      protocol.__reset();

      const settled = await Promise.race([
        pending,
        new Promise((resolve) => setTimeout(() => resolve("HUNG"), 100)),
      ]);
      expect(settled).not.toBe("HUNG");
      expect(settled.ok).toBe(false);
      expect(typeof settled.error).toBe("string");
    });

    it("empties the correlation table", async () => {
      const socket = fakeSocket();
      const pending = protocol.send({ socket, cmd: "read", payload: {} });
      protocol.__reset();
      expect(protocol.__pendingCount()).toBe(0);
      await pending;
    });

    // A leaked timer cannot be observed through the promise: the caller is
    // already settled, so the stray fire is a silent no-op. Fake timers make the
    // leak itself visible — without this, dropping the clearTimeout from __reset
    // is indistinguishable from keeping it.
    it("clears the timer rather than leaking it", async () => {
      jest.useFakeTimers();
      try {
        const socket = fakeSocket();
        const pending = protocol.send({
          socket,
          cmd: "read",
          payload: {},
          timeoutMs: 20,
        });
        expect(jest.getTimerCount()).toBe(1);

        protocol.__reset();
        expect(jest.getTimerCount()).toBe(0);

        await pending; // already settled by __reset; must not hang
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // attach() is the only production path into handleMessage; the other tests all
  // call it directly, so without this nothing proves the handler is ever bound.
  it("attach routes socket messages into the correlation table", async () => {
    const sent = [];
    let onMessage = null;
    const socket = {
      send: (raw) => sent.push(JSON.parse(raw)),
      on: (event, handler) => {
        if (event === "message") onMessage = handler;
      },
    };

    protocol.attach(socket);
    expect(typeof onMessage).toBe("function");

    const pending = protocol.send({ socket, cmd: "read", payload: {} });
    // Buffer, not string: ws delivers frames as Buffers in production.
    onMessage(
      Buffer.from(
        JSON.stringify({ requestId: sent[0].requestId, ok: true, data: "via attach" })
      )
    );
    expect((await pending).data).toBe("via attach");
  });

  // A reconnect path that calls attach twice would deliver every frame twice.
  // The duplicate finds the entry already settled and deleted, so it is dropped
  // silently — the bug leaves no trace, which is why it needs a test.
  it("attach is idempotent per socket", () => {
    let binds = 0;
    const socket = { send() {}, on: () => binds++ };

    protocol.attach(socket);
    protocol.attach(socket);
    protocol.attach(socket);
    expect(binds).toBe(1);

    // A different socket still gets its own handler.
    protocol.attach({ send() {}, on: () => binds++ });
    expect(binds).toBe(2);
  });

  describe("DEFAULT_TIMEOUT_MS", () => {
    // A typo'd env var must not silently make every command time out on the next
    // tick — Number("fast") is NaN and setTimeout(fn, NaN) fires immediately.
    const load = (value) => {
      jest.resetModules();
      const previous = process.env.BROWSER_COMPANION_TIMEOUT_MS;
      if (value === undefined) delete process.env.BROWSER_COMPANION_TIMEOUT_MS;
      else process.env.BROWSER_COMPANION_TIMEOUT_MS = value;
      try {
        return require("../../../utils/browserCompanion/protocol")
          .DEFAULT_TIMEOUT_MS;
      } finally {
        if (previous === undefined)
          delete process.env.BROWSER_COMPANION_TIMEOUT_MS;
        else process.env.BROWSER_COMPANION_TIMEOUT_MS = previous;
      }
    };

    it("reads the env var when it is a positive number", () => {
      expect(load("1234")).toBe(1234);
    });

    it("falls back when the env var is unset, non-numeric or non-positive", () => {
      const fallback = load(undefined);
      expect(fallback).toBe(20_000);
      expect(load("fast")).toBe(fallback);
      expect(load("0")).toBe(fallback);
      expect(load("-1")).toBe(fallback);
    });
  });
});
