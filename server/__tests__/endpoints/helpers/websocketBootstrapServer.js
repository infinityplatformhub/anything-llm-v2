#!/usr/bin/env node
/**
 * Boots express-ws the way the product does, in its own process, so a test can
 * prove whether a hostile frame kills the whole process.
 *
 * The process boundary is the point: Jest traps `uncaughtException` inside its
 * own worker and turns it into a failed assertion, which would hide the actual
 * production consequence. Only a child's exit code shows it.
 *
 * Modes mirror the two product bootstrap call sites and the shape of the bug:
 *   no-route   - express-ws installed, NO ws route registered at all. This is
 *                the real crash surface: the handshake completes before Express
 *                dispatches, so no route and no middleware can reject first.
 *   with-route - a ws route registered, to show the same frame on a matched path.
 *   ssl        - the bootSSL shape: express-ws attached to a pre-built server.
 *
 * Protocol: one JSON line per event on stdout.
 *   {"event":"listening","port":N}
 */
const path = require("path");

// Node >= 24 removed buffer.SlowBuffer; jsonwebtoken -> buffer-equal-constant-time
// still reads it at require time. Same reason as __tests__/utils/lark/_polyfill.js,
// which cannot be reused here because it is written against Jest's `expect`.
// ponytail: drop when jsonwebtoken drops buffer-equal-constant-time.
const buffer = require("buffer");
if (!buffer.SlowBuffer) buffer.SlowBuffer = buffer.Buffer;

const SERVER_DIR = path.resolve(__dirname, "../../..");

function report(event, fields = {}) {
  process.stdout.write(JSON.stringify({ event, ...fields }) + "\n");
}

function main() {
  const mode = String(process.env.HARNESS_MODE || "no-route");
  const express = require("express");
  const http = require("http");
  const { bootWebSockets } = require(
    path.join(SERVER_DIR, "utils/boot/bootWebSockets")
  );

  const app = express();
  let server = null;

  if (mode === "ssl") {
    // bootSSL's shape: the server exists first and express-ws attaches to it.
    // Plain http here - TLS is irrelevant to frame parsing, and the point is
    // that this call site is guarded too.
    server = http.createServer(app);
    bootWebSockets(app, server);
  } else {
    bootWebSockets(app);
  }

  if (mode === "with-route")
    app.ws("/api/some-route", (socket) => {
      socket.on("message", () => {});
    });

  const listener = server ?? app;
  const bound = listener.listen(0, "127.0.0.1", () =>
    report("listening", { port: bound.address().port })
  );
}

// Jest collects every file under __tests__, and this must not boot a server
// when it does. Same guard as __tests__/e2e/lark/helpers/fakeCli.js.
if (require.main === module) main();
else
  test("is an executable fixture, not a suite", () => {
    expect(typeof main).toBe("function");
  });
