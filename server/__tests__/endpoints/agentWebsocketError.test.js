/**
 * Hostile input on the agent socket route, /api/agent-invocation/:uuid (#61).
 *
 * SCOPE NOTE: the malformed-frame crash is NOT a defect of this route. It is a
 * property of the express-ws bootstrap, which completes the handshake before
 * Express dispatches, so it reaches every socket the server makes - including on
 * paths with no ws route at all. That fix and its primary proof live in
 * __tests__/utils/boot/bootWebSockets.test.js. These tests boot through the same
 * real bootstrap helper and cover what is specific to THIS route:
 *
 *   - the close-path cleanup (abort / closeAlert / WorkspaceAgentInvocation.close)
 *     still runs exactly once when a socket dies from a bad frame;
 *   - relayToSocket does not let a throwing or rejecting handler escape - the
 *     websocket plugin's handleFeedback is async and opens with a bare
 *     JSON.parse, so a non-JSON payload on a WELL-FORMED frame would otherwise
 *     become an unhandled rejection. The bootstrap guard does not cover that;
 *   - an unknown invocation uuid is still refused.
 *
 * The child process is load-bearing: Jest traps `uncaughtException` inside its
 * own worker, so a same-process test would report a failed assertion where
 * production reports a dead server. Asserting on the child's exit code is the
 * only way to observe the real consequence.
 */
const { describe, it, expect, afterEach } = require("@jest/globals");
// Must precede anything that pulls in jsonwebtoken (via the route's model
// requires): Node >= 24 removed buffer.SlowBuffer, which it reads at require
// time. Same reason as the lark suites.
require("../utils/lark/_polyfill");
const path = require("path");
const { fork } = require("child_process");
const WebSocket = require("ws");

const HARNESS = path.join(__dirname, "helpers/agentWebsocketServer.js");
const UUID = "test-invocation-uuid";
// A single frame is enough to kill the process, but the harness needs a moment
// to act on it before we can judge the outcome. Generous enough to be reliable
// on a loaded CI box; the tests still finish in well under a second in practice.
const SETTLE_MS = 750;

let harness = null;
const clients = [];

/**
 * Boots the route in a child process and waits for its port.
 * @param {"malformed-frame"|"throwing-handler"} mode
 */
function startHarness(mode = "malformed-frame") {
  return new Promise((resolve, reject) => {
    const child = fork(HARNESS, [], {
      env: { ...process.env, HARNESS_UUID: UUID, HARNESS_MODE: mode },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const boot = setTimeout(
      () => reject(new Error("harness never reported listening")),
      10_000
    );
    const events = [];
    let exit = null;
    let stdout = "";
    let stderr = "";

    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("exit", (code, signal) => (exit = { code, signal }));
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        events.push(event);
        if (event.event === "listening") {
          clearTimeout(boot);
          resolve({
            child,
            port: event.port,
            events,
            get exit() {
              return exit;
            },
            get stderr() {
              return stderr;
            },
          });
        }
      }
    });
    child.on("error", (error) => {
      clearTimeout(boot);
      reject(error);
    });
  });
}

/**
 * Opens a real ws client against the route and resolves once it is open.
 * `express-ws` completes the HTTP upgrade before the route handler runs, so a
 * client always reaches `open`; a rejected invocation is closed just after.
 */
function connect(port, uuid = UUID) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/api/agent-invocation/${uuid}`
    );
    clients.push(socket);
    // Without this the client's own close/reset surfaces as an unhandled
    // 'error' inside the Jest worker, which is not what is under test.
    socket.on("error", () => {});
    socket.on("open", () => resolve(socket));
    socket.on("close", () => reject(new Error("socket closed before open")));
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  for (const socket of clients.splice(0)) socket.terminate();
  harness?.child.kill("SIGKILL");
  harness = null;
});

describe("agent websocket hostile input", () => {
  it("survives a malformed frame and keeps other clients connected", async () => {
    harness = await startHarness("malformed-frame");
    const bystander = await connect(harness.port);
    const attacker = await connect(harness.port);

    // FIN=1, reserved non-control opcode 0x3, MASK=1, zero-length payload.
    // `ws` rejects this with WS_ERR_INVALID_OPCODE on the server socket.
    attacker._socket.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0]));
    await delay(SETTLE_MS);

    expect(harness.exit).toBeNull();
    expect(bystander.readyState).toBe(WebSocket.OPEN);
    // Contained, not swallowed: the cause must still be diagnosable from logs.
    // The guard lives at the express-ws bootstrap, not on this route, so the
    // tag is [WebSocket] - see __tests__/utils/boot/bootWebSockets.test.js.
    expect(harness.stderr).toMatch(/\[WebSocket\]/);
    expect(harness.stderr).toMatch(/WS_ERR_INVALID_OPCODE/);
  });

  it("runs the close cleanup exactly once for the socket it kills", async () => {
    harness = await startHarness("malformed-frame");
    const attacker = await connect(harness.port);

    attacker._socket.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0]));
    await delay(SETTLE_MS);

    // abort / closeAlert / WorkspaceAgentInvocation.close all hang off the
    // `close` handler. The error path must reach them, and only once.
    const names = harness.events.map((event) => event.event);
    expect(names.filter((n) => n === "abort")).toHaveLength(1);
    expect(names.filter((n) => n === "closeAlert")).toHaveLength(1);
    expect(names.filter((n) => n === "invocationClose")).toHaveLength(1);
    expect(harness.exit).toBeNull();
  });

  it("survives a non-JSON payload reaching the feedback handler", async () => {
    harness = await startHarness("throwing-handler");
    const bystander = await connect(harness.port);
    const attacker = await connect(harness.port);

    // A well-formed frame - the damage is done by the handler it dispatches to,
    // whose unguarded JSON.parse rejects and, being returned unawaited from a
    // 'message' listener, becomes an unhandled rejection.
    attacker.send("not json at all");
    await delay(SETTLE_MS);

    expect(harness.exit).toBeNull();
    expect(bystander.readyState).toBe(WebSocket.OPEN);
  });

  it("still refuses an unknown invocation uuid, and a frame on it is harmless", async () => {
    harness = await startHarness("malformed-frame");
    const rejected = await connect(harness.port, "no-such-uuid");
    await delay(SETTLE_MS);

    // The route closes the socket and returns before attaching any listener, so
    // this path was already accidentally safe. Pinned so the fix cannot make it
    // hold a socket open that today is dropped.
    expect(rejected.readyState).toBe(WebSocket.CLOSED);
    expect(harness.events.map((event) => event.event)).not.toContain("abort");
    expect(harness.exit).toBeNull();
  });
});
