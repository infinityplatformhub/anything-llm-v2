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

  // A socket that closed between the registry handing it over and the write must
  // come back as an error now, not as a full-length timeout the agent waits out.
  it("resolves as an error when the socket throws on send", async () => {
    const socket = {
      send() {
        throw new Error("WebSocket is not open");
      },
    };
    const result = await protocol.send({ socket, cmd: "click", payload: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/WebSocket is not open/);
    expect(protocol.__pendingCount()).toBe(0);
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
