// Sentinel for the single-user-mode key whose user_id is null. A real user id is
// never null, so this cannot collide with one.
const SINGLE_USER_KEY = "__single_user__";

const NOT_CONNECTED_ERROR = "Browser extension is not connected.";
const NO_USER_ERROR =
  "This agent run has no user, so there is no browser to drive.";
const LEGACY_KEY_ERROR =
  "This browser extension key predates multi-user mode and is not tied to a user. Reconnect the extension to get a key bound to your account.";

/** @type {Map<number|string, object>} one socket per user — see plan Global Constraints */
const sockets = new Map();

function keyFor(userId) {
  return userId === null ? SINGLE_USER_KEY : userId;
}

/**
 * Bind a socket to a user, replacing whatever that user had connected before.
 * @param {{userId: number|null, socket: object}} args
 * @returns {{evicted: object|null}} the socket displaced by this one, if any
 */
function register({ userId, socket }) {
  const key = keyFor(userId);
  const previous = sockets.get(key) ?? null;
  sockets.set(key, socket);
  return { evicted: previous === socket ? null : previous };
}

/**
 * Drop a user's socket, but only when it is still the one passed in.
 * @param {{userId: number|null, socket: object}} args
 * @returns {void}
 */
function unregister({ userId, socket }) {
  const key = keyFor(userId);
  // Only drop the entry when it is still this socket. A socket that closes late
  // must not evict the replacement that already took its place.
  if (sockets.get(key) === socket) sockets.delete(key);
}

function connectedSocketFor(key) {
  const socket = sockets.get(key) ?? null;
  return socket
    ? { socket, error: null }
    : { socket: null, error: NOT_CONNECTED_ERROR };
}

/**
 * Find the socket an agent run is allowed to command.
 * @param {{userId: number|null|undefined, multiUserMode: boolean}} args
 *   `userId === undefined` means the run has no user at all (e.g. a scheduled job).
 *   `userId === null` is the single-user-mode key.
 * @returns {{socket: object|null, error: string|null}}
 */
function resolve({ userId, multiUserMode }) {
  // No user on the run at all: never fall back to whoever happens to be online.
  if (userId === undefined) return { socket: null, error: NO_USER_ERROR };

  if (userId === null) {
    // A null key is legitimate only while the instance has no users to confuse
    // it with. Once multi-user mode is on it must not match anybody.
    if (multiUserMode) return { socket: null, error: LEGACY_KEY_ERROR };
    return connectedSocketFor(SINGLE_USER_KEY);
  }

  return connectedSocketFor(userId);
}

/** Test-only: clear module state between cases. */
function __reset() {
  sockets.clear();
}

module.exports = { register, unregister, resolve, __reset, SINGLE_USER_KEY };
