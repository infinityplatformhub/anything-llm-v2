/**
 * Installs express-ws and guards every socket it will ever produce.
 *
 * `express-ws` builds a `ws.Server` on the HTTP server and completes the
 * WebSocket handshake in its own `connection` handler, *before* Express
 * dispatches the request. So a client reaches an open socket with no
 * credentials, on a path with no ws route at all - nothing per-route and no
 * middleware can reject it first.
 *
 * `ws` then emits `error` on that server socket for any malformed inbound frame
 * (bad opcode, RSV bit, mismatched payload length). Node's EventEmitter rethrows
 * an `error` with no listener as an `uncaughtException`, which kills the
 * process: every workspace and every user on the instance, from six bytes sent
 * by an unauthenticated client. The listener therefore belongs here, on every
 * socket, and not on any one route.
 *
 * @param {import("express").Express} app - the Express app to install onto
 * @param {import("http").Server|import("https").Server|null} httpServer - an
 *   existing server to attach to (SSL boot); omit to let express-ws create one.
 * @returns {object} the express-ws instance, for callers that want `getWss()`
 */
function bootWebSockets(app, httpServer = null) {
  if (!app) throw new Error('No "app" defined - cannot boot WebSockets!');

  const instance = require("@mintplex-labs/express-ws").default(
    app,
    // express-ws treats null/undefined as "create your own server", but only
    // reads the argument when it is present - pass it through as given.
    httpServer ?? undefined
  );

  instance.getWss().on("connection", (socket, request) => {
    // Attached on `connection`, so it is in place before any frame can be read
    // and before the route handler (which is async and may still be awaiting
    // its invocation lookup) has had a chance to run.
    socket.on("error", (error) => {
      console.error(
        `[WebSocket] Socket error on ${request?.url ?? "unknown path"} - closing:`,
        error
      );
      socket.close();
    });
  });

  return instance;
}

module.exports = { bootWebSockets };
