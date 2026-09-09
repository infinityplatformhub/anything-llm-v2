const { randomUUID } = require("crypto");

// A browser command that gets no reply must not hang the agent turn. Overridable
// because a slow page load is environment-dependent.
//
// The fallback is the only inline number in this module. It is a true constant:
// the ceiling on how long one agent turn may block on a browser that may never
// answer, not a deployment detail — anything deployment-specific goes in the env
// var. A non-numeric or non-positive override is ignored rather than honoured:
// `Number("fast")` is NaN and `setTimeout(fn, NaN)` fires on the next tick, so a
// typo'd env var would silently time out every command instantly and present as
// "the extension is broken" rather than as a config error.
const FALLBACK_TIMEOUT_MS = 20_000;

function resolveTimeoutMs(rawValue) {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : FALLBACK_TIMEOUT_MS;
}

const DEFAULT_TIMEOUT_MS = resolveTimeoutMs(
  process.env.BROWSER_COMPANION_TIMEOUT_MS
);

// Correlation table for every command awaiting a reply, keyed by requestId.
//
// One map for all sockets, not one per socket. That is safe only because
// requestId is a v4 UUID: an extension can resolve another socket's pending
// command only by guessing a 122-bit random value it was never sent. Scoping the
// map per socket would make that structural rather than probabilistic — the
// upgrade path if the id scheme ever becomes guessable (a counter, a hash of the
// command) or if replies start being forwarded between sockets.
/** @type {Map<string, {resolve: Function, timer: NodeJS.Timeout}>} */
const pending = new Map();

/**
 * Send one command and resolve when its own reply comes back.
 *
 * Never rejects: a browser failure is data an agent reads and reasons about, not
 * an exception that aborts its turn. Every path resolves `{ok, data, error}`.
 *
 * @param {{socket: object, cmd: string, payload?: object, timeoutMs?: number}} args
 * @returns {Promise<{ok: boolean, data: any, error: string|null}>}
 */
function send({ socket, cmd, payload = {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const requestId = `r_${randomUUID()}`;
  return new Promise((resolveOuter) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolveOuter({
        ok: false,
        data: null,
        error: `Browser command "${cmd}" timed out after ${timeoutMs}ms.`,
      });
    }, timeoutMs);

    const settle = (result) => {
      pending.delete(requestId);
      clearTimeout(timer);
      resolveOuter(result);
    };

    pending.set(requestId, { resolve: settle, timer });

    try {
      // `requestId` and `cmd` are written after the payload spread so a payload
      // carrying either key cannot overwrite them. A payload-supplied requestId
      // would be the worst failure this module has: two commands sharing an id
      // means one agent reads the other's page state, with no error anywhere.
      socket.send(JSON.stringify({ ...payload, requestId, cmd }));
    } catch (error) {
      // The socket closed between the registry handing it over and this write.
      // Resolve now instead of leaving the caller to discover it via a timeout
      // it would have to wait the full DEFAULT_TIMEOUT_MS for.
      settle({
        ok: false,
        data: null,
        error: `Browser command "${cmd}" could not be sent: ${error.message}`,
      });
    }
  });
}

/**
 * Route one inbound frame to the command waiting on it, if any.
 *
 * The extension is across a network and may send anything; nothing it sends may
 * throw out of here, because this runs inside the socket's "message" handler and
 * a throw there takes the connection down for every command in flight.
 *
 * @param {{socket?: object, raw: string|Buffer}} args
 * @returns {void}
 */
function handleMessage({ raw }) {
  let parsed;
  try {
    parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString());
  } catch {
    return; // A malformed frame must not take the socket down.
  }

  // `pending.get(undefined)` is a miss, so a frame with no requestId — or a
  // non-string one — falls through the same drop path as an unknown id.
  const entry = pending.get(parsed?.requestId);
  if (!entry) return; // Late reply after a timeout, or a frame we never asked for.

  entry.resolve(
    parsed.ok
      ? { ok: true, data: parsed.data ?? null, error: null }
      : {
          ok: false,
          data: null,
          error: parsed.error ?? "Browser command failed.",
        }
  );
}

/**
 * Bind the reply handler to a socket. Call once per connection.
 * @param {{on: Function}} socket
 * @returns {void}
 */
function attach(socket) {
  socket.on("message", (raw) => handleMessage({ socket, raw }));
}

/** Test-only: clear module state between cases. */
function __reset() {
  for (const { timer } of pending.values()) clearTimeout(timer);
  pending.clear();
}

/**
 * Test-only: how many commands are still awaiting a reply.
 *
 * Exists so a test can prove the correlation table is emptied on every exit
 * path. A settled command that stays in the map is invisible from the outside —
 * the caller got its answer — but the map is process-lifetime state, so a
 * forgotten delete is an unbounded leak in a long-running server.
 */
function __pendingCount() {
  return pending.size;
}

module.exports = {
  send,
  handleMessage,
  attach,
  __reset,
  __pendingCount,
  DEFAULT_TIMEOUT_MS,
};
