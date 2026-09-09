const { randomUUID } = require("crypto");

// A browser command that gets no reply must not hang the agent turn. Overridable
// because a slow page load is environment-dependent.
//
// The fallback is the only inline number in this module. It is a true constant:
// the ceiling on how long one agent turn may block on a browser that may never
// answer, not a deployment detail — anything deployment-specific goes in the env
// var (documented in server/.env.example). A non-numeric or non-positive value is
// ignored rather than honoured: `Number("fast")` is NaN and `setTimeout(fn, NaN)`
// fires on the next tick, so a typo'd env var would silently time out every
// command instantly and present as "the extension is broken" rather than as a
// config error.
const FALLBACK_TIMEOUT_MS = 20_000;

// setTimeout stores its delay in a signed 32-bit int; anything larger overflows
// and fires on the next tick — the same instant-timeout failure a typo produces,
// from a value ("effectively never") whose intent is the exact opposite.
const MAX_TIMEOUT_MS = 2_147_483_647;

// ws readyState for OPEN. Named because the numeric literal appears in the one
// place a dead socket has to be detected, and `1` there reads as a magic number.
const WS_OPEN = 1;

const DISCONNECTED_ERROR = "the browser extension is not connected.";

/**
 * Clamp any timeout — from the env var or from a caller — to a usable delay.
 *
 * Applied to caller input as well as the env var: tasks 3 and 4 are the callers,
 * and every bad value below produces a next-tick timeout whose error text reads
 * "timed out after nullms" / "after [object Object]ms". Silently substituting the
 * default is right for a value whose only role is a deadline — there is no
 * caller-visible failure mode worth a throw, and the alternative is an agent
 * turn that reports a browser failure that never happened.
 */
function resolveTimeoutMs(rawValue) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return FALLBACK_TIMEOUT_MS;
  return Math.min(parsed, MAX_TIMEOUT_MS);
}

const DEFAULT_TIMEOUT_MS = resolveTimeoutMs(
  process.env.BROWSER_COMPANION_TIMEOUT_MS
);

/**
 * Correlation table for every command awaiting a reply.
 *
 * Keyed by requestId, but each entry also records the socket the command was
 * written to, and `handleMessage` resolves an entry only when the reply arrives
 * on that same socket. The requestId alone would be a probabilistic guarantee —
 * an extension would have to guess a 122-bit CSPRNG value it was never sent —
 * and it holds only while the id stays secret, which a single log line or agent
 * transcript that echoes a frame would undo. The socket check makes it
 * structural, and closes a non-adversarial case too: one user's extension
 * reconnecting (the registry evicts and replaces the socket) while commands are
 * in flight on the old one, where the reply would otherwise come back from a
 * different browser session at a different page.
 *
 * @type {Map<string, {resolve: Function, timer: NodeJS.Timeout, socket: object, cmd: string}>}
 */
const pending = new Map();

// Sockets already wired to handleMessage. Binding twice would deliver every
// frame twice; the second delivery finds the entry already settled and deleted,
// so it is silently dropped — an attach-twice bug would leave no trace at all.
// A WeakSet so a closed socket is collectable without an explicit cleanup call.
const attached = new WeakSet();

/**
 * Send one command and resolve when its own reply comes back on its own socket.
 *
 * Never rejects and never throws: a browser failure is data an agent reads and
 * reasons about, not an exception that aborts its turn. Every path resolves
 * `{ok, data, error}`, with `error` always either null or a string.
 *
 * @param {{socket: object, cmd: string, payload?: object, timeoutMs?: number}} args
 * @returns {Promise<{ok: boolean, data: any, error: string|null}>}
 */
function send({ socket, cmd, payload = {}, timeoutMs } = {}) {
  const delay = resolveTimeoutMs(timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const requestId = `r_${randomUUID()}`;

  return new Promise((resolveOuter) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolveOuter({
        ok: false,
        data: null,
        error: `Browser command "${cmd}" timed out after ${delay}ms.`,
      });
    }, delay);

    // One in-flight command must not hold the event loop open for up to
    // DEFAULT_TIMEOUT_MS and delay a graceful shutdown by that much. Optional
    // call because a non-Node timer shim has no unref.
    timer.unref?.();

    const settle = (result) => {
      pending.delete(requestId);
      clearTimeout(timer);
      resolveOuter(result);
    };

    // `cmd` is recorded so `drainSocket` can name the command it interrupted;
    // every other exit path already has `cmd` in scope from the argument.
    pending.set(requestId, { resolve: settle, timer, socket, cmd });

    // A closed ws socket does NOT throw on send: ws/lib/websocket.js throws only
    // for CONNECTING(0), and for CLOSING(2)/CLOSED(3) it calls sendAfterClose()
    // and returns silently. Verified against a real server socket. So without
    // this check a command written to a dead socket waits out the full timeout
    // for an answer that can never arrive, and reports "timed out after 20000ms"
    // when the truth is that the browser is gone. The window is real even once
    // the close handler unregisters the socket, because ws reaches CLOSING/CLOSED
    // before the close event fires — so the registry can hand back a dead socket.
    //
    // Guarded on `!== undefined` so a socket without the property (a test double,
    // a non-ws transport) is still written to rather than rejected outright.
    if (socket?.readyState !== undefined && socket.readyState !== WS_OPEN) {
      return settle({
        ok: false,
        data: null,
        error: `Browser command "${cmd}" could not be sent: ${DISCONNECTED_ERROR}`,
      });
    }

    try {
      // `requestId` and `cmd` are written after the payload spread so a payload
      // carrying either key cannot overwrite them. A payload-supplied requestId
      // would be the worst failure this module has: two commands sharing an id
      // means one agent reads the other's page state, with no error anywhere.
      socket.send(JSON.stringify({ ...payload, requestId, cmd }));
    } catch (error) {
      // Still reachable, just not for the closed-socket case above: a CONNECTING
      // socket throws, an unstringifiable payload throws, and a socket object
      // with no usable send throws. String(error) rather than error.message,
      // because a non-Error throw has no .message and would render the contract's
      // `string` as "could not be sent: undefined".
      settle({
        ok: false,
        data: null,
        error: `Browser command "${cmd}" could not be sent: ${String(
          error?.message ?? error
        )}`,
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
 * @param {{socket: object, raw: string|Buffer}} args `socket` is the connection
 *   the frame arrived on and is required: a reply resolves a command only when it
 *   comes back on the same socket the command was written to. Omitting it drops
 *   every frame, which fails closed.
 * @returns {void}
 */
function handleMessage({ socket, raw }) {
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

  // The reply must arrive on the socket the command went out on. A frame
  // echoing another connection's requestId resolves nothing.
  if (entry.socket !== socket) {
    // Never normal traffic, so this cannot be noisy: it is either a wiring bug
    // (the socket registered is not the socket attached, which makes every
    // command time out with text identical to a disconnected browser) or one
    // connection echoing another's requestId. Without this line both are silent
    // — the drop is a bare `return`, and the caller only ever sees a timeout.
    // The requestId is not logged: it is the correlation secret this module's
    // socket check exists to stop being guessable.
    console.warn(
      "browserCompanion protocol: reply arrived on a different socket than the command was sent on — dropping it. This is a socket-wiring bug or a cross-connection echo, never normal traffic."
    );
    return;
  }

  // `=== true`, not truthy: `ok: "false"` is a truthy string, so an extension
  // doing `ok: String(success)` — or any JSON round trip that stringifies
  // booleans — would otherwise turn a denied command into a confident success
  // carrying extension-supplied data. That is the silent-wrong-answer class this
  // module exists to prevent, arriving from untrusted network input.
  if (parsed.ok === true)
    return entry.resolve({ ok: true, data: parsed.data ?? null, error: null });

  // Coerced to a string so the documented `error: string|null` holds against
  // untrusted input: an object here would reach task 3/4 code as
  // "[object Object]" the first time it is interpolated or `.match`ed.
  const error = parsed.error ?? "Browser command failed.";
  entry.resolve({
    ok: false,
    data: null,
    error: typeof error === "string" ? error : JSON.stringify(error),
  });
}

/**
 * Bind the reply handler to a socket. Idempotent per socket.
 * @param {{on: Function}} socket
 * @returns {void}
 */
function attach(socket) {
  if (attached.has(socket)) return;
  attached.add(socket);
  socket.on("message", (raw) => handleMessage({ socket, raw }));
}

/**
 * Settle every command still awaiting a reply on one socket.
 *
 * Called from the endpoint's close handler. Without it, a command already in
 * flight when the browser disconnects waits out its own timeout — up to
 * DEFAULT_TIMEOUT_MS — and then reports "timed out", which reads as a slow page
 * rather than a closed browser. Commands sent *after* the disconnect already
 * answer immediately via the readyState guard in `send`; this covers the ones
 * that were already on the wire.
 *
 * Filtered by socket identity, deliberately: `__reset` settles everything for
 * every connection, so using it here would abort every other user's in-flight
 * commands whenever any one extension disconnects.
 *
 * Resolves rather than rejects, like every other exit path in this module.
 *
 * @param {object} socket the connection that closed
 * @returns {number} how many commands were settled
 */
function drainSocket(socket) {
  // A missing socket must not match entries whose socket is undefined for some
  // other reason, and would drain connections it has nothing to do with.
  if (!socket) return 0;

  let drained = 0;
  // Snapshotted first: `entry.resolve` is the settle closure, which deletes from
  // the map as it goes.
  for (const entry of [...pending.values()]) {
    if (entry.socket !== socket) continue;
    drained += 1;
    entry.resolve({
      ok: false,
      data: null,
      // Distinct from BOTH other failure strings, deliberately. The timeout text
      // ("timed out after 20000ms") reads as a slow page and was half the reason
      // for adding this function; the send-guard text ("could not be sent")
      // describes a command that never went out. This one went out and was in
      // flight when the browser vanished, so it says exactly that — the agent
      // reads these strings and reasons about them.
      error: `Browser command "${entry.cmd}" was interrupted: the browser disconnected before it answered.`,
    });
  }
  return drained;
}

/**
 * Test-only: clear module state between cases.
 *
 * Settles every in-flight caller rather than dropping it: an entry whose timer
 * is cleared and whose map entry is deleted, but whose promise is never
 * resolved, hangs forever. `beforeEach` runs this before every test, so a
 * promise straddling a reset would hang to the Jest timeout instead of failing
 * usefully.
 */
function __reset() {
  // `entry.resolve` is the settle closure — it already clears the timer and
  // deletes the map entry — so this loop only has to hand each caller an answer.
  // Snapshotted first because settle mutates the map as it goes.
  for (const entry of [...pending.values()])
    entry.resolve({
      ok: false,
      data: null,
      error: "Browser companion protocol state was reset.",
    });
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
  drainSocket,
  __reset,
  __pendingCount,
  DEFAULT_TIMEOUT_MS,
};
