/* global jest */
const {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} = require("@jest/globals");
// Must precede the endpoint require: it pulls in jsonwebtoken via models/workspace,
// which reads buffer.SlowBuffer at require time. Same reason as the lark suites.
require("../utils/lark/_polyfill");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const registry = require("../../utils/browserCompanion/registry");
const protocol = require("../../utils/browserCompanion/protocol");

jest.mock("../../models/browserExtensionApiKey", () => ({
  BrowserExtensionApiKey: { validate: jest.fn() },
}));
jest.mock("../../models/systemSettings", () => ({
  SystemSettings: { isMultiUserMode: jest.fn() },
}));
jest.mock("../../models/user", () => ({ User: { get: jest.fn() } }));

const {
  BrowserExtensionApiKey,
} = require("../../models/browserExtensionApiKey");
const { SystemSettings } = require("../../models/systemSettings");
const { User } = require("../../models/user");
const {
  browserExtensionEndpoints,
} = require("../../endpoints/browserExtension");

const ROUTE = "/browser-companion/agent-socket";
let wsRoutes;

function fakeApp() {
  wsRoutes = {};
  return {
    get() {},
    post() {},
    delete() {},
    ws(path, handler) {
      wsRoutes[path] = handler;
    },
  };
}

function fakeSocket() {
  const handlers = {};
  return {
    sent: [],
    closed: false,
    closeCode: null,
    send(raw) {
      this.sent.push(JSON.parse(raw));
    },
    close(code) {
      this.closed = true;
      this.closeCode = code ?? null;
    },
    on(evt, fn) {
      handlers[evt] = fn;
    },
    emit(evt, ...args) {
      handlers[evt]?.(...args);
    },
  };
}

async function connect(key) {
  const socket = fakeSocket();
  await wsRoutes[ROUTE](socket, { query: { key } });
  return socket;
}

describe("browser-companion agent socket", () => {
  beforeEach(() => {
    registry.__reset();
    protocol.__reset();
    jest.clearAllMocks();
    browserExtensionEndpoints(fakeApp());
    SystemSettings.isMultiUserMode.mockResolvedValue(false);
  });
  afterEach(() => {
    registry.__reset();
    protocol.__reset();
  });

  it("registers the socket for the key's user", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: false });

    const socket = await connect("brx-good");
    expect(socket.closed).toBe(false);
    expect(registry.resolve({ userId: 7, multiUserMode: true }).socket).toBe(
      socket
    );
  });

  // @edge — key ผิดต้องถูกปิด และต้องไม่มีอะไรถูกลงทะเบียน
  it("closes the socket when the key is invalid", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue(null);
    const socket = await connect("brx-bad");
    expect(socket.closed).toBe(true);
    expect(
      registry.resolve({ userId: 7, multiUserMode: true }).socket
    ).toBeNull();
  });

  it("closes the socket when no key is supplied at all", async () => {
    const socket = await connect(undefined);
    expect(socket.closed).toBe(true);
    expect(BrowserExtensionApiKey.validate).not.toHaveBeenCalled();
  });

  // @edge — ผู้ใช้ที่ถูกระงับ ต่อไม่ได้
  it("closes the socket for a suspended user", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: true });

    const socket = await connect("brx-good");
    expect(socket.closed).toBe(true);
  });

  it("tells the evicted device it was replaced, then closes it", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: false });

    const first = await connect("brx-good");
    await connect("brx-good");

    expect(first.sent.some((m) => m.event === "evicted")).toBe(true);
    expect(first.closed).toBe(true);
  });

  it("unregisters on close", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: false });

    const socket = await connect("brx-good");
    socket.emit("close");
    expect(
      registry.resolve({ userId: 7, multiUserMode: true }).socket
    ).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Beyond the brief. Each of the following covers a way this endpoint can
  // fail that the six cases above still pass through.
  // ---------------------------------------------------------------------

  // The close code is the only thing the extension can act on — it cannot read a
  // body. "Closed" is not enough: retry-with-the-same-key (4401) and
  // stop-retrying (4403) are opposite instructions to the extension, and the six
  // cases above pass even if every rejection collapses to one code.
  it("distinguishes unauthorized, forbidden and replaced with distinct close codes", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue(false);
    expect((await connect("brx-bad")).closeCode).toBe(4401);
    expect((await connect(undefined)).closeCode).toBe(4401);

    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: true });
    expect((await connect("brx-good")).closeCode).toBe(4403);

    User.get.mockResolvedValue({ id: 7, suspended: false });
    const first = await connect("brx-good");
    await connect("brx-good");
    expect(first.closeCode).toBe(4409);
  });

  // `validate` resolves `false`, not `null`, for a bad key (models/
  // browserExtensionApiKey.js). A `=== null` check would let every bad key
  // through; the brief's own test mocks `null` and so cannot catch that.
  it("closes the socket when validate resolves false rather than null", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue(false);
    const socket = await connect("brx-bad");
    expect(socket.closed).toBe(true);
    expect(
      registry.resolve({ userId: 7, multiUserMode: true }).socket
    ).toBeNull();
  });

  // A user missing entirely is a different DB result from a suspended one, and
  // the suspended-user test passes even if the `!user` branch is deleted.
  it("closes the socket when the key's user no longer exists", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue(null);

    const socket = await connect("brx-good");
    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(4403);
  });

  // @edge — the identity must come from the validated key row, never from the
  // request. Every test above uses user_id 7 and a key that also says 7, so all
  // of them still pass if the handler reads an id off the request instead.
  it("registers the key row's user, not anything the caller supplied", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: false });

    const socket = fakeSocket();
    // A caller trying to be someone else: the query says 9, the key says 7.
    await wsRoutes[ROUTE](socket, {
      query: { key: "brx-good", userId: "9", user_id: "9" },
      params: { userId: "9" },
      headers: { "x-user-id": "9" },
    });

    expect(registry.resolve({ userId: 7, multiUserMode: true }).socket).toBe(
      socket
    );
    expect(
      registry.resolve({ userId: 9, multiUserMode: true }).socket
    ).toBeNull();
  });

  // @edge — single-user mode: the key's user_id is null, which is the registry's
  // legitimate sentinel. Every other test runs in multi-user mode.
  it("registers a single-user-mode key under the null sentinel without a user lookup", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: null });
    SystemSettings.isMultiUserMode.mockResolvedValue(false);

    const socket = await connect("brx-good");
    expect(socket.closed).toBe(false);
    expect(User.get).not.toHaveBeenCalled();
    expect(registry.resolve({ userId: null, multiUserMode: false }).socket).toBe(
      socket
    );
  });

  // @edge — a null-user key must never bind in multi-user mode: the null
  // sentinel is the one key every user's agent run can resolve.
  it("refuses a null-user key once multi-user mode is on", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: null });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);

    const socket = await connect("brx-good");
    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(4403);
    expect(
      registry.resolve({ userId: null, multiUserMode: false }).socket
    ).toBeNull();
  });

  // @edge — registry.register throws a TypeError on a non-integer userId. That
  // throw must reach the catch and close the socket, not escape the handler and
  // leave a connection open that no agent run can ever address.
  it("closes the socket when the key row carries a corrupt user id", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: "7" });
    SystemSettings.isMultiUserMode.mockResolvedValue(false);

    const socket = await connect("brx-good");
    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(1011);
    expect(
      registry.resolve({ userId: 7, multiUserMode: true }).socket
    ).toBeNull();
  });

  // @edge — express parses a repeated ?key=a&key=b into an array. String() would
  // turn that into "a,b" and hand it to the DB as a real lookup.
  it("closes the socket when the key is not a string", async () => {
    const socket = await connect(["brx-a", "brx-b"]);
    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(4401);
    expect(BrowserExtensionApiKey.validate).not.toHaveBeenCalled();
  });

  // @edge — the whole point of point 4 in the plan: protocol.js keys its pending
  // map on socket object identity. Wrap or re-create the socket anywhere between
  // register and attach and every reply silently stops matching, every command
  // times out, and all six of the brief's tests still pass. This drives the real
  // protocol module end to end: register -> resolve -> send -> reply.
  it("attaches the protocol to the same object the registry hands back", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: false });

    const socket = await connect("brx-good");
    const resolved = registry.resolve({
      userId: 7,
      multiUserMode: true,
    }).socket;
    expect(resolved).toBe(socket);

    const inFlight = protocol.send({ socket: resolved, cmd: "read_page" });
    const { requestId } = socket.sent[socket.sent.length - 1];
    // The reply arrives the way a real one does: on the socket's own "message"
    // event, which only routes to protocol.handleMessage if attach saw this
    // exact object.
    socket.emit(
      "message",
      JSON.stringify({ requestId, ok: true, data: { title: "x" } })
    );

    await expect(inFlight).resolves.toEqual({
      ok: true,
      data: { title: "x" },
      error: null,
    });
  });

  // @edge — the wiring invariant itself, checked at connect time. If the object
  // the registry holds is ever not the object the protocol is attached to, the
  // connection must be refused loudly rather than served as a browser that looks
  // connected and silently swallows every command. Simulated by making the
  // registry hand back a different object, which is exactly what a wrapper,
  // proxy or spread copy anywhere in this handler would produce.
  it("refuses the connection when the registry and the protocol disagree on the socket", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: false });

    const realResolve = registry.resolve;
    const spy = jest
      .spyOn(registry, "resolve")
      .mockImplementation((args) => ({ socket: fakeSocket(), error: null }));

    let socket;
    try {
      socket = await connect("brx-good");
    } finally {
      spy.mockRestore();
    }

    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(1011);
    // And it must not be left in the registry for an agent run to find.
    expect(realResolve({ userId: 7, multiUserMode: true }).socket).toBeNull();
  });

  // @edge — a rejected connection must not leave the protocol wired to a socket
  // no agent run can reach.
  it("does not attach the protocol to a socket it rejected", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue(false);
    const socket = await connect("brx-bad");
    const before = protocol.__pendingCount();

    const inFlight = protocol.send({ socket, cmd: "read_page", timeoutMs: 50 });
    const { requestId } = socket.sent[socket.sent.length - 1];
    socket.emit("message", JSON.stringify({ requestId, ok: true, data: "x" }));

    // Nothing routed the frame, so the command is still waiting rather than
    // resolved — proof no "message" handler was bound to a rejected socket.
    expect(protocol.__pendingCount()).toBe(before + 1);
    await expect(inFlight).resolves.toMatchObject({ ok: false });
  });

  // @edge — an evicted device that is told nothing shows a browser that looks
  // connected forever. The notification must go out BEFORE the close: ws drops
  // a frame sent after close() (verified against ws@7.5.10 in the real-library
  // suite below), so the ordering is the behaviour, not a detail.
  it("notifies the evicted device before closing it, not after", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: false });

    const order = [];
    const first = fakeSocket();
    const rawSend = first.send.bind(first);
    const rawClose = first.close.bind(first);
    first.send = (raw) => {
      order.push("send");
      rawSend(raw);
    };
    first.close = (code) => {
      order.push("close");
      rawClose(code);
    };
    await wsRoutes[ROUTE](first, { query: { key: "brx-good" } });
    await connect("brx-good");

    expect(order).toEqual(["send", "close"]);
    const notice = first.sent.find((m) => m.event === "evicted");
    expect(typeof notice.reason).toBe("string");
    expect(notice.reason.length).toBeGreaterThan(0);
  });

  // @edge — the evicted socket may already be dead. A throw from notifying it
  // must not abort the new connection, which is the one the user is watching.
  it("still registers the new device when the evicted one throws on notify", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: false });

    const first = fakeSocket();
    first.send = () => {
      throw new Error("socket is gone");
    };
    await wsRoutes[ROUTE](first, { query: { key: "brx-good" } });

    const second = await connect("brx-good");
    expect(second.closed).toBe(false);
    expect(registry.resolve({ userId: 7, multiUserMode: true }).socket).toBe(
      second
    );
  });

  // @edge — an eviction must not unregister the user. The evicted socket's close
  // arrives after the replacement has taken the slot, and dropping the entry
  // then would leave the live extension unreachable.
  it("keeps the replacement registered when the evicted socket closes late", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: false });

    const first = await connect("brx-good");
    const second = await connect("brx-good");
    first.emit("close"); // the eviction's close event, arriving now

    expect(registry.resolve({ userId: 7, multiUserMode: true }).socket).toBe(
      second
    );
  });

  // @edge — ws emits 'error' for any protocol violation in an inbound frame, and
  // an EventEmitter with no 'error' listener rethrows, taking the whole server
  // process down. This asserts the listener exists; the real-library suite below
  // proves it is actually needed.
  it("survives an error emitted on the socket by untrusted input", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: false });

    const socket = await connect("brx-good");
    expect(() =>
      socket.emit("error", new Error("Invalid WebSocket frame"))
    ).not.toThrow();
  });

  // ---------------------------------------------------------------------
  // Fix round 1.
  // ---------------------------------------------------------------------

  // @edge — `schema.prisma` declares `suspended Int @default(0)` and `User.get`
  // does not cast it, so production hands this handler `1`, never `true`. Every
  // other test here mocks a boolean, so tightening the check to `=== true` — the
  // most natural-looking edit — survives them all while letting a suspended
  // user's extension register. Mocked with the values Prisma actually returns.
  it("refuses a suspended user when Prisma reports suspended as 1, not true", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: 1 });

    const socket = await connect("brx-good");
    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(4403);
    expect(
      registry.resolve({ userId: 7, multiUserMode: true }).socket
    ).toBeNull();
  });

  it("admits an active user when Prisma reports suspended as 0, not false", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: 0 });

    const socket = await connect("brx-good");
    expect(socket.closed).toBe(false);
    expect(registry.resolve({ userId: 7, multiUserMode: true }).socket).toBe(
      socket
    );
  });

  // @edge — M-2: `""` must never reach the DB. `validate("")` would return false
  // at `.startsWith`, so this is defence in depth, but nothing pinned it.
  it("closes the socket on an empty-string key without touching the database", async () => {
    const socket = await connect("");
    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(4401);
    expect(BrowserExtensionApiKey.validate).not.toHaveBeenCalled();
  });

  // --- C1: the key travels in the subprotocol, query is the deprecated fallback ---

  it("authenticates with the key offered as a subprotocol", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: 0 });

    const socket = fakeSocket();
    await wsRoutes[ROUTE](socket, {
      headers: {
        "sec-websocket-protocol":
          "anythingllm-browser-companion, brx-from-subprotocol",
      },
      query: {},
    });

    expect(BrowserExtensionApiKey.validate).toHaveBeenCalledWith(
      "brx-from-subprotocol"
    );
    expect(socket.closed).toBe(false);
    expect(registry.resolve({ userId: 7, multiUserMode: true }).socket).toBe(
      socket
    );
  });

  // The subprotocol must WIN when both are present, or an attacker who can
  // append a query string to the upgrade URL could downgrade the transport.
  it("prefers the subprotocol key over the query parameter when both are sent", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: 0 });

    const socket = fakeSocket();
    await wsRoutes[ROUTE](socket, {
      headers: {
        "sec-websocket-protocol": "anythingllm-browser-companion, brx-preferred",
      },
      query: { key: "brx-ignored" },
    });

    expect(BrowserExtensionApiKey.validate).toHaveBeenCalledWith("brx-preferred");
    expect(BrowserExtensionApiKey.validate).not.toHaveBeenCalledWith(
      "brx-ignored"
    );
  });

  // A header without the marker is not a credential offer. Accepting a bare
  // token would let any subprotocol string be tried as a key.
  it("ignores a subprotocol header that does not lead with the marker", async () => {
    const socket = fakeSocket();
    await wsRoutes[ROUTE](socket, {
      headers: { "sec-websocket-protocol": "brx-not-announced" },
      query: {},
    });

    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(4401);
    expect(BrowserExtensionApiKey.validate).not.toHaveBeenCalled();
  });

  // Sabotage found this gap: the "no marker" test above offers a single token,
  // so dropping the marker check still rejects it (tokens[1] is undefined).
  // Two tokens whose first is NOT the marker is what actually distinguishes
  // "require the marker" from "treat any subprotocol list as a credential".
  it("ignores a two-token subprotocol offer whose first token is not the marker", async () => {
    const socket = fakeSocket();
    await wsRoutes[ROUTE](socket, {
      headers: { "sec-websocket-protocol": "some-other-protocol, brx-sneaky" },
      query: {},
    });

    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(4401);
    expect(BrowserExtensionApiKey.validate).not.toHaveBeenCalled();
  });

  // Sabotage found this gap too: with only two tokens, "index 1" and "last
  // token" are the same value. A third token separates them, and the key must
  // stay at the position right after the marker — otherwise a client appending
  // subprotocols shifts which value is treated as the credential.
  it("takes the key from the position after the marker, not the last token", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: 0 });

    await wsRoutes[ROUTE](fakeSocket(), {
      headers: {
        "sec-websocket-protocol":
          "anythingllm-browser-companion, brx-real-key, brx-trailing-decoy",
      },
      query: {},
    });

    expect(BrowserExtensionApiKey.validate).toHaveBeenCalledWith("brx-real-key");
    expect(BrowserExtensionApiKey.validate).not.toHaveBeenCalledWith(
      "brx-trailing-decoy"
    );
  });

  it("closes the socket when the marker is offered with no key after it", async () => {
    const socket = fakeSocket();
    await wsRoutes[ROUTE](socket, {
      headers: { "sec-websocket-protocol": "anythingllm-browser-companion" },
      query: {},
    });

    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(4401);
    expect(BrowserExtensionApiKey.validate).not.toHaveBeenCalled();
  });

  // The deprecation has to be visible or the fallback is never removed.
  it("warns exactly once when the deprecated query parameter is used", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: 0 });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await connect("brx-good");
      const deprecationWarnings = warn.mock.calls.filter((args) =>
        String(args[0]).includes("deprecated")
      );
      expect(deprecationWarnings).toHaveLength(1);
      // It must name the replacement, or it is a warning nobody can act on.
      expect(String(deprecationWarnings[0][0])).toContain(
        "anythingllm-browser-companion"
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn about deprecation when the subprotocol is used", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: 0 });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await wsRoutes[ROUTE](fakeSocket(), {
        headers: {
          "sec-websocket-protocol": "anythingllm-browser-companion, brx-good",
        },
        query: {},
      });
      expect(
        warn.mock.calls.filter((args) =>
          String(args[0]).includes("deprecated")
        )
      ).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  // --- M-1: the raw key must never reach the log ---

  // Prisma embeds the failing query's arguments in its error message, so an
  // error raised while validating carries the key in plaintext. Truncating does
  // not fix it — in the real error shape the key sits inside the first 200
  // characters — so the token itself has to go.
  it("never logs the raw API key when validate throws", async () => {
    const KEY = "brx-SUPERSECRETKEYVALUE12345";
    BrowserExtensionApiKey.validate.mockRejectedValue(
      new Error(
        "Invalid `prisma.browser_extension_api_keys.findUnique()` invocation: where key = " +
          KEY
      )
    );
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const socket = await connect(KEY);
      expect(socket.closed).toBe(true);
      expect(socket.closeCode).toBe(1011);

      const logged = errorLog.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(logged).not.toContain(KEY);
      // And it must still say something useful.
      expect(logged).toContain("brx-[redacted]");
    } finally {
      errorLog.mockRestore();
    }
  });

  // --- M-5: a client that dies mid-auth must not leave a dead socket bound ---

  it("does not leave a socket registered when the client dies during auth", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: 0 });

    // A socket that reports itself already CLOSED by the time auth finishes —
    // the close event fired before the handler could attach its listener.
    const socket = fakeSocket();
    socket.readyState = 3; // CLOSED
    await wsRoutes[ROUTE](socket, { query: { key: "brx-good" } });

    expect(
      registry.resolve({ userId: 7, multiUserMode: true }).socket
    ).toBeNull();
  });

  it("keeps an open socket registered (the mid-auth check must not fire on a live one)", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: 0 });

    const socket = fakeSocket();
    socket.readyState = 1; // OPEN
    await wsRoutes[ROUTE](socket, { query: { key: "brx-good" } });

    expect(registry.resolve({ userId: 7, multiUserMode: true }).socket).toBe(
      socket
    );
  });

  // --- drainSocket: in-flight commands answer on disconnect ---

  it("answers in-flight commands with 'not connected' when the socket closes", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: 0 });

    const socket = await connect("brx-good");
    // In flight: written to the socket, no reply yet. A long timeout so that a
    // pass cannot come from the command simply timing out.
    const inFlight = protocol.send({
      socket,
      cmd: "read_page",
      timeoutMs: 60_000,
    });
    expect(protocol.__pendingCount()).toBe(1);

    socket.emit("close");

    await expect(inFlight).resolves.toMatchObject({
      ok: false,
      data: null,
      error: expect.stringContaining("not connected"),
    });
    expect(protocol.__pendingCount()).toBe(0);
  });

  // One extension disconnecting must not settle another user's commands — the
  // reason __reset could not be used for this.
  it("drains only the closing socket's commands, not another connection's", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: 0 });
    const first = await connect("brx-good");

    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 2, user_id: 9 });
    User.get.mockResolvedValue({ id: 9, suspended: 0 });
    const second = await connect("brx-other");

    const onFirst = protocol.send({
      socket: first,
      cmd: "read_page",
      timeoutMs: 60_000,
    });
    const onSecond = protocol.send({
      socket: second,
      cmd: "read_page",
      timeoutMs: 60_000,
    });
    expect(protocol.__pendingCount()).toBe(2);

    first.emit("close");

    await expect(onFirst).resolves.toMatchObject({ ok: false });
    // The other user's command is untouched and still waiting.
    expect(protocol.__pendingCount()).toBe(1);

    // Settle it so the test does not leave a live timer behind.
    second.emit("close");
    await expect(onSecond).resolves.toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// The suite above runs the handler against a hand-written socket, which cannot
// disagree with any belief this endpoint holds about `ws` or `express-ws`. Two
// of those beliefs are load-bearing and both are wrong in the obvious direction:
// a frame sent after close() is dropped, and a socket with no 'error' listener
// takes the process down. So these run against the real libraries, over a real
// TCP connection, with a real browser-side WebSocket client.
// ---------------------------------------------------------------------------
describe("browser-companion agent socket (real ws + express-ws)", () => {
  let server;
  let baseUrl;
  /** Every client opened in a test, so teardown can destroy stragglers. */
  let clients;

  beforeEach(async () => {
    clients = [];
    registry.__reset();
    protocol.__reset();
    jest.clearAllMocks();
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    User.get.mockResolvedValue({ id: 7, suspended: false });

    const app = express();
    server = http.createServer(app);
    // Same call server/index.js makes, against the same express-ws build.
    require("@mintplex-labs/express-ws").default(app, server);
    browserExtensionEndpoints(app);
    await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
    baseUrl = `ws://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    registry.__reset();
    protocol.__reset();
    // `server.close` only stops accepting and then waits for live connections to
    // end, so any socket a test (or a broken implementation) left open would hang
    // teardown until the Jest timeout — turning a clean assertion failure into an
    // unreadable hook timeout. Destroy them first so a failure reports as itself.
    for (const client of clients) {
      try {
        client.terminate();
      } catch {
        // Already gone.
      }
    }
    clients = [];
    await new Promise((done) => server.close(done));
  });

  /** Open a real client socket and resolve once it is open or closed. */
  function open(key) {
    const client = new WebSocket(
      `${baseUrl}/browser-companion/agent-socket?key=${encodeURIComponent(key)}`
    );
    clients.push(client);
    const frames = [];
    client.on("message", (raw) => frames.push(JSON.parse(String(raw))));
    client.frames = frames;
    // ws throws on an unhandled 'error' event; a rejected handshake emits one.
    client.on("error", () => {});
    client.opened = new Promise((done) => {
      client.once("open", () => done("open"));
      client.once("close", () => done("closed"));
    });
    client.ended = new Promise((done) =>
      client.once("close", (code, reason) =>
        done({ code, reason: String(reason) })
      )
    );
    return client;
  }

  // A socket the server never closes would make `await client.ended` hang to the
  // Jest timeout and surface as an unreadable hook error instead of the real
  // failure ("the server did not close it"). Every await of `ended` goes through
  // this so the assertion stays legible when the implementation is wrong.
  const CLOSE_WAIT_MS = 4000;
  function closedWithin(client) {
    return Promise.race([
      client.ended,
      new Promise((done) =>
        setTimeout(
          () => done({ code: "never-closed", reason: "never-closed" }),
          CLOSE_WAIT_MS
        ).unref?.()
      ),
    ]);
  }

  it("accepts a valid key and registers the live server-side socket", async () => {
    const client = open("brx-good");
    expect(await client.opened).toBe("open");

    const { socket } = registry.resolve({ userId: 7, multiUserMode: true });
    expect(socket).not.toBeNull();
    // The object the registry holds is the real ws socket, open for writing.
    expect(socket.readyState).toBe(WebSocket.OPEN);
    client.close();
  });

  // The close code has to survive the wire, not just the call. express-ws closes
  // the socket itself when a handler declines, so a code set here could be
  // replaced by 1005/1006 by the time the extension reads it.
  it("delivers the rejection close code to the client over a real connection", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue(false);
    const { code } = await closedWithin(open("brx-bad"));
    expect(code).toBe(4401);
  });

  // The behaviour point 1 of the plan is about, end to end: the evicted device
  // must actually RECEIVE the notice. Sending it after close() silently delivers
  // nothing, and no fake socket can tell us that.
  it("delivers the eviction notice and the 4409 code to the replaced device", async () => {
    const first = open("brx-good");
    expect(await first.opened).toBe("open");
    const second = open("brx-good");
    expect(await second.opened).toBe("open");

    const { code, reason } = await closedWithin(first);
    expect(first.frames).toEqual([
      { event: "evicted", reason: expect.any(String) },
    ]);
    expect(code).toBe(4409);
    expect(reason.length).toBeGreaterThan(0);
    second.close();
  });

  // The registry must still route to the survivor after the eviction's close
  // event has landed — the ordering the fake suite can only simulate.
  it("routes to the replacement after the evicted socket has finished closing", async () => {
    const first = open("brx-good");
    await first.opened;
    const second = open("brx-good");
    await second.opened;
    await closedWithin(first);

    const { socket } = registry.resolve({ userId: 7, multiUserMode: true });
    expect(socket).not.toBeNull();
    expect(socket.readyState).toBe(WebSocket.OPEN);
    second.close();
  });

  // Point 2: unregister runs on EVERY close. An abnormally terminated connection
  // (the laptop sleeps, the TCP connection dies) never sends a close frame.
  it("unregisters when the connection dies abnormally, with no close frame", async () => {
    const client = open("brx-good");
    await client.opened;
    expect(
      registry.resolve({ userId: 7, multiUserMode: true }).socket
    ).not.toBeNull();

    // Destroy the TCP socket underneath: no close handshake at all.
    client._socket.destroy();
    const { code } = await closedWithin(client);
    expect(code).toBe(1006); // abnormal closure

    // The server's close handler runs on its own turn of the loop.
    await new Promise((tick) => setTimeout(tick, 50));
    const { socket, error } = registry.resolve({
      userId: 7,
      multiUserMode: true,
    });
    expect(socket).toBeNull();
    expect(error).toMatch(/not connected/i);
  });

  // A malformed frame from the extension emits 'error' on the server socket.
  // With no listener, Node rethrows and the whole process dies — a remote crash
  // from unauthenticated-shaped input. Asserted against the real ws parser,
  // because the premise is entirely about what ws does with a bad frame.
  it("survives a malformed frame instead of crashing the server process", async () => {
    const client = open("brx-good");
    await client.opened;

    // Reserved opcode 0x3 — a protocol violation ws rejects while parsing.
    client._socket.write(Buffer.from([0x83, 0x80, 0x00, 0x00, 0x00, 0x00]));
    await closedWithin(client);
    await new Promise((tick) => setTimeout(tick, 50));

    // Reaching this line at all is the assertion: an unhandled 'error' would
    // have taken the worker down. The registry must also have been cleaned up.
    expect(
      registry.resolve({ userId: 7, multiUserMode: true }).socket
    ).toBeNull();

    // And the endpoint still serves the next connection.
    const next = open("brx-good");
    expect(await next.opened).toBe("open");
    next.close();
  });

  // End to end through the real protocol module: a command written to the
  // registered socket comes back over the wire and resolves that same command.
  it("round-trips a command to the client and back through the registry", async () => {
    const client = open("brx-good");
    await client.opened;
    client.on("message", (raw) => {
      const { requestId } = JSON.parse(String(raw));
      client.send(
        JSON.stringify({ requestId, ok: true, data: { title: "hello" } })
      );
    });

    const { socket } = registry.resolve({ userId: 7, multiUserMode: true });
    await expect(protocol.send({ socket, cmd: "read_page" })).resolves.toEqual({
      ok: true,
      data: { title: "hello" },
      error: null,
    });
    client.close();
  });

  // --- Fix round 1, against the real libraries ---

  // I2: regression cover for the error-listener fix. The bug it prevents is a
  // process-wide crash from six bytes, so the assertion has to be against the
  // real ws frame parser — a fake socket cannot produce a protocol violation.
  // (The existing "survives a malformed frame" test above covers the same fix;
  // this one pins the listener's own presence and that the connection is still
  // cleaned up afterwards.)
  it("keeps serving after a malformed frame and cleans up that connection", async () => {
    const client = open("brx-good");
    await client.opened;
    const { socket } = registry.resolve({ userId: 7, multiUserMode: true });
    expect(socket.listenerCount("error")).toBeGreaterThan(0);

    // Reserved opcode 0x3 — rejected by ws while parsing, emits 'error'.
    client._socket.write(Buffer.from([0x83, 0x80, 0x00, 0x00, 0x00, 0x00]));
    await closedWithin(client);
    await new Promise((tick) => setTimeout(tick, 50));

    expect(
      registry.resolve({ userId: 7, multiUserMode: true }).socket
    ).toBeNull();

    // Still serving: the process is alive and the route still authenticates.
    const next = open("brx-good");
    expect(await next.opened).toBe("open");
    next.close();
  });

  // C1: the whole point of moving the key off the query string is that a real
  // browser client can still connect. ws@7 selects the FIRST offered
  // subprotocol and echoes only that back; if the marker were not offered first,
  // or the server echoed the key, the handshake contract would break.
  it("completes the handshake for a client offering the key as a subprotocol", async () => {
    const client = new WebSocket(
      `${baseUrl}/browser-companion/agent-socket`,
      ["anythingllm-browser-companion", "brx-good"]
    );
    clients.push(client);
    client.on("error", () => {});
    const opened = await new Promise((done) => {
      client.once("open", () => done("open"));
      client.once("close", () => done("closed"));
    });

    expect(opened).toBe("open");
    // The echoed subprotocol must be the marker, never the credential.
    expect(client.protocol).toBe("anythingllm-browser-companion");
    expect(client.protocol).not.toContain("brx-");

    const { socket } = registry.resolve({ userId: 7, multiUserMode: true });
    expect(socket).not.toBeNull();
    expect(socket.readyState).toBe(WebSocket.OPEN);
    client.close();
  });

  it("rejects a real subprotocol connection whose key is invalid", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue(false);
    const client = new WebSocket(
      `${baseUrl}/browser-companion/agent-socket`,
      ["anythingllm-browser-companion", "brx-bad"]
    );
    clients.push(client);
    client.on("error", () => {});
    const { code } = await new Promise((done) => {
      client.once("close", (c, r) => done({ code: c, reason: String(r) }));
      setTimeout(() => done({ code: "never-closed", reason: "" }), 4000).unref?.();
    });
    expect(code).toBe(4401);
  });

  // The key must not appear in the URL when the subprotocol is used — that is
  // the entire exposure this change exists to close.
  it("carries no key in the request URL when the subprotocol is used", async () => {
    const seen = [];
    server.on("upgrade", (req) => seen.push(req.url));

    const client = new WebSocket(
      `${baseUrl}/browser-companion/agent-socket`,
      ["anythingllm-browser-companion", "brx-good"]
    );
    clients.push(client);
    client.on("error", () => {});
    await new Promise((done) => {
      client.once("open", done);
      client.once("close", done);
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const url of seen) expect(url).not.toContain("brx-");
    client.close();
  });

  // drainSocket over a real disconnect: the command must answer immediately with
  // "not connected" rather than waiting out its timeout.
  it("answers an in-flight command as soon as the real connection drops", async () => {
    const client = open("brx-good");
    await client.opened;
    const { socket } = registry.resolve({ userId: 7, multiUserMode: true });

    // Never replied to. A long timeout, so passing cannot be the timeout firing.
    const inFlight = protocol.send({
      socket,
      cmd: "read_page",
      timeoutMs: 60_000,
    });
    await new Promise((tick) => setTimeout(tick, 20));

    const startedAt = Date.now();
    client._socket.destroy(); // abnormal close, no handshake

    const result = await inFlight;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not connected/i);
    // Answered because the socket closed, not because it timed out.
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(protocol.__pendingCount()).toBe(0);
  });
});
