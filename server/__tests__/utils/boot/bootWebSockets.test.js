/**
 * Remote, unauthenticated DoS on every WebSocket the server produces (#61).
 *
 * `express-ws` builds its `ws.Server` on the HTTP server and completes the
 * handshake in its own `connection` handler, *before* Express dispatches. A
 * client therefore reaches an open socket with no credentials, on a path with no
 * ws route at all - no middleware and no route handler gets a chance to reject
 * it. `ws` then emits `error` on that server socket for a malformed inbound
 * frame, and Node rethrows an unlistened `error` as an `uncaughtException`,
 * killing the process: every workspace and every user on the instance.
 *
 * The load-bearing case is `no-route`. A guard on any single route would leave
 * the real hole open, and a test that only exercised a route would pass against
 * such a guard - so the primary test here registers no route at all.
 *
 * Each test drives a real `ws` client against a real `express-ws` server in a
 * child process. The child is deliberate: Jest traps `uncaughtException` in its
 * own worker, so a same-process test would report a failed assertion where
 * production reports a dead server. The child's exit code is the only honest
 * signal.
 */
const { describe, it, expect, afterEach } = require("@jest/globals");
// Must precede anything pulling in jsonwebtoken: Node >= 24 removed
// buffer.SlowBuffer, which it reads at require time. Same as the lark suites.
require("../lark/_polyfill");
const path = require("path");
const { fork } = require("child_process");
const WebSocket = require("ws");

const HARNESS = path.join(
  __dirname,
  "../../endpoints/helpers/websocketBootstrapServer.js"
);
// FIN=1, reserved non-control opcode 0x3, MASK=1, zero-length payload.
// `ws` rejects this with WS_ERR_INVALID_OPCODE on the server socket.
const MALFORMED_FRAME = Buffer.from([0x83, 0x80, 0, 0, 0, 0]);
// Long enough for the child to act on the frame and die if it is going to.
const SETTLE_MS = 750;

let harness = null;
const clients = [];

/** Boots the bootstrap harness in a child process and waits for its port. */
function startHarness(mode) {
  return new Promise((resolve, reject) => {
    const child = fork(HARNESS, [], {
      env: { ...process.env, HARNESS_MODE: mode },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const boot = setTimeout(
      () => reject(new Error("harness never reported listening")),
      10_000
    );
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
        if (event.event === "listening") {
          clearTimeout(boot);
          resolve({
            child,
            port: event.port,
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
 * Opens a real ws client and resolves once it is open. No credentials are ever
 * sent: reaching `open` on an unmatched path is itself part of what is proven.
 */
function connect(port, route) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${route}`);
    clients.push(socket);
    // Without this the client's own reset surfaces as an unhandled 'error'
    // inside the Jest worker, which is not what is under test.
    socket.on("error", () => {});
    socket.on("open", () => resolve(socket));
    socket.on("close", () => reject(new Error("socket closed before open")));
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for the child's stderr to match. A fixed delay is not enough: the exit
 * code is observable the moment the process dies, but stderr is piped and
 * arrives asynchronously, so asserting on it right after a delay races the
 * flush. Polls until it matches or the deadline passes, then returns whatever
 * arrived so the assertion reports the real content on failure.
 */
async function waitForStderr(h, pattern, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !pattern.test(h.stderr)) await delay(25);
  return h.stderr;
}

afterEach(() => {
  for (const socket of clients.splice(0)) socket.terminate();
  harness?.child.kill("SIGKILL");
  harness = null;
});

describe("websocket bootstrap under hostile frames", () => {
  it("survives a malformed frame with no ws route registered at all", async () => {
    harness = await startHarness("no-route");

    // No route exists on this path - and the upgrade still completes, which is
    // exactly why nothing per-route can defend against this.
    const attacker = await connect(harness.port, "/no/such/route/at/all");
    expect(attacker.readyState).toBe(WebSocket.OPEN);

    attacker._socket.write(MALFORMED_FRAME);
    await delay(SETTLE_MS);

    expect(harness.exit).toBeNull();
    // Contained, not swallowed: the cause must stay diagnosable from logs.
    const logged = await waitForStderr(harness, /WS_ERR_INVALID_OPCODE/);
    expect(logged).toMatch(/\[WebSocket\]/);
    expect(logged).toMatch(/WS_ERR_INVALID_OPCODE/);
  });

  it("keeps other connected clients alive when one sends a malformed frame", async () => {
    // The bystander sits on a real route: express-ws closes any socket whose
    // path matches no ws route, so an unmatched bystander would drop on its own
    // and prove nothing about the blast radius.
    harness = await startHarness("with-route");
    const bystander = await connect(harness.port, "/api/some-route");
    const attacker = await connect(harness.port, "/api/some-route");

    attacker._socket.write(MALFORMED_FRAME);
    await delay(SETTLE_MS);

    expect(harness.exit).toBeNull();
    expect(bystander.readyState).toBe(WebSocket.OPEN);
  });

  it("survives the same frame on a registered ws route", async () => {
    harness = await startHarness("with-route");
    const attacker = await connect(harness.port, "/api/some-route");

    attacker._socket.write(MALFORMED_FRAME);
    await delay(SETTLE_MS);

    expect(harness.exit).toBeNull();
  });

  it("survives on the SSL bootstrap shape, where express-ws attaches to an existing server", async () => {
    // bootSSL calls express-ws with a pre-built server; that call site must be
    // guarded too, or HTTPS deployments keep the hole.
    harness = await startHarness("ssl");
    const attacker = await connect(harness.port, "/no/such/route/at/all");

    attacker._socket.write(MALFORMED_FRAME);
    await delay(SETTLE_MS);

    expect(harness.exit).toBeNull();
    expect(await waitForStderr(harness, /WS_ERR_INVALID_OPCODE/)).toMatch(
      /WS_ERR_INVALID_OPCODE/
    );
  });

  it("still serves normal traffic after absorbing a malformed frame", async () => {
    harness = await startHarness("with-route");
    const attacker = await connect(harness.port, "/api/some-route");
    attacker._socket.write(MALFORMED_FRAME);
    await delay(SETTLE_MS);

    // The guard must not have left the server unable to accept new sockets.
    const later = await connect(harness.port, "/api/some-route");
    expect(later.readyState).toBe(WebSocket.OPEN);
    expect(harness.exit).toBeNull();
  });
});
