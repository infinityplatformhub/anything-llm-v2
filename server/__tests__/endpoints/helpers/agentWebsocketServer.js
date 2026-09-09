#!/usr/bin/env node
/**
 * Boots the real `agentWebsocket` route on a real `@mintplex-labs/express-ws`
 * server, in its own process, so a test can prove whether a hostile frame kills
 * the whole process. The process boundary is the point: an `uncaughtException`
 * inside the Jest worker is trapped by Jest and only fails a test, which would
 * hide the actual production consequence.
 *
 * Everything the bug lives in stays real - `ws`, `express-ws`, Express, and
 * `endpoints/agentWebsocket.js` itself. Only the DB-facing collaborators
 * (`AgentHandler`, `Telemetry`, `WorkspaceAgentInvocation`) are replaced, via
 * the require cache, so the route can be reached without a database. They are
 * not the subject under test.
 *
 * Protocol: prints one JSON line per event on stdout.
 *   {"event":"listening","port":N}
 *   {"event":"abort"|"closeAlert"|"invocationClose","uuid":"..."}
 */
const path = require("path");

// Node >= 24 removed buffer.SlowBuffer; jsonwebtoken -> buffer-equal-constant-time
// still reads it at require time, and the route pulls that in transitively.
// Same reason as __tests__/utils/lark/_polyfill.js, which cannot be reused here
// because it is written against Jest's `expect`.
// ponytail: drop when jsonwebtoken drops buffer-equal-constant-time.
const buffer = require("buffer");
if (!buffer.SlowBuffer) buffer.SlowBuffer = buffer.Buffer;

const SERVER_DIR = path.resolve(__dirname, "../../..");

function report(event, fields = {}) {
  process.stdout.write(JSON.stringify({ event, ...fields }) + "\n");
}

/** Replaces a module's exports before anything requires it for real. */
function stubModule(relativePath, exports) {
  const filename = require.resolve(path.join(SERVER_DIR, relativePath));
  require.cache[filename] = {
    id: filename,
    filename,
    path: path.dirname(filename),
    loaded: true,
    children: [],
    paths: [],
    exports,
  };
}

/**
 * Stand-in for the aibitat instance. `abort()` is the first step of the close
 * handler's cleanup; the test asserts it runs exactly once.
 */
function fakeAibitat(uuid) {
  return {
    abort() {
      report("abort", { uuid });
    },
  };
}

function main() {
  const uuid = String(process.env.HARNESS_UUID || "harness-uuid");
  // Which hostile input this run is arming for. "malformed-frame" needs no
  // handler at all; "throwing-handler" installs the real plugin's feedback
  // handler shape so a valid frame with a non-JSON payload reaches it.
  const mode = String(process.env.HARNESS_MODE || "malformed-frame");

  stubModule("models/telemetry", {
    Telemetry: { sendTelemetry: async () => {} },
  });
  stubModule("models/workspaceAgentInvocation", {
    WorkspaceAgentInvocation: {
      close: async (closedUuid) =>
        report("invocationClose", { uuid: String(closedUuid) }),
    },
  });
  stubModule("utils/agents", {
    AgentHandler: class FakeAgentHandler {
      constructor({ uuid: invocationUuid }) {
        this.uuid = String(invocationUuid);
        this.invocation = null;
        this.aibitat = null;
      }
      async init() {
        // Only a known uuid resolves to an invocation, mirroring the real
        // handler. An unknown one leaves `invocation` null so the route closes
        // the socket before attaching any listener.
        if (this.uuid === uuid) this.invocation = { uuid: this.uuid };
        return this;
      }
      log() {}
      closeAlert() {
        report("closeAlert", { uuid: this.uuid });
      }
      async createAIbitat({ socket }) {
        this.aibitat = fakeAibitat(this.uuid);
        if (mode !== "throwing-handler") return;
        // Verbatim shape of the real feedback handler's entry, from
        // utils/agents/aibitat/plugins/websocket.js: an async function whose
        // first statement is an unguarded JSON.parse of the raw frame.
        socket.handleFeedback = async (message) => {
          const data = JSON.parse(message);
          return data;
        };
      }
      async startAgentCluster() {}
    },
  });

  const express = require("express");
  const app = express();
  // The real bootstrap helper, exactly as server/index.js:80 calls it - the
  // per-socket error guard lives there, so the route must be exercised through it.
  require(path.join(SERVER_DIR, "utils/boot/bootWebSockets")).bootWebSockets(
    app
  );
  const apiRouter = express.Router();
  app.use("/api", apiRouter);
  require(path.join(SERVER_DIR, "endpoints/agentWebsocket")).agentWebsocket(
    apiRouter
  );

  const server = app.listen(0, "127.0.0.1", () =>
    report("listening", { port: server.address().port })
  );
}

// Jest collects every file under __tests__, and this must not boot a server
// when it does. Same guard as __tests__/e2e/lark/helpers/fakeCli.js.
if (require.main === module) main();
else
  test("is an executable fixture, not a suite", () => {
    expect(typeof main).toBe("function");
  });
