// Sentinel for the single-user-mode key whose user_id is null.
//
// The invariant that protects this module is "every userId reaching it is an
// integer or null" — true today (browser_extension_api_keys.user_id and
// workspace_agent_invocations.user_id are both `Int?`), but nothing outside
// this file guarantees it stays true. So the sentinel does not share a
// keyspace with user keys: keyFor() prefixes every user key with "u:", which
// no sentinel value can collide with whatever type a caller passes. `resolve`
// additionally rejects a non-integer userId outright — see the check there.
const SINGLE_USER_KEY = "__single_user__";

const NOT_CONNECTED_ERROR = "Browser extension is not connected.";
const NO_USER_ERROR =
  "This agent run has no user, so there is no browser to drive.";
const LEGACY_KEY_ERROR =
  "This browser extension key predates multi-user mode and is not tied to a user. Reconnect the extension to get a key bound to your account.";

// Per-process state. An AnythingLLM instance running more than one server
// process does NOT share this map: the extension's WebSocket lands in one
// process and an agent run may land in another, which reports the extension as
// offline even though it is connected — an availability bug that presents as a
// flaky feature. It fails closed, never open, so it is not a security hole.
// Upgrade path when horizontal scaling is needed: move the map to a shared
// store (Redis) and replace the socket object with a handle addressable across
// processes, so `resolve` can return a proxy that forwards to the owning node.
/** @type {Map<string, object>} one socket per user — see plan Global Constraints */
const sockets = new Map();

/**
 * Namespaced so no userId of any type can collide with SINGLE_USER_KEY.
 *
 * The integer guard lives here, not in the callers, because namespacing
 * stringifies the key: `u:${"7"}` and `u:${7}` are the same string, as are
 * `u:${new Number(7)}`, `u:${[7]}` and `u:${7n}`. A raw Map kept those apart by
 * key identity; a string key does not. So a cross-type id at WRITE time takes
 * over or evicts a legitimate integer-id user, and no check on the read side
 * can see it — the value `resolve` receives (`7`) is genuinely valid, and the
 * corruption happened one function away under a different value. Key derivation
 * is the one choke point all three entry points share.
 * @throws {TypeError} when userId is neither an integer nor null.
 */
function keyFor(userId) {
  if (userId === null) return SINGLE_USER_KEY;
  if (!Number.isInteger(userId))
    throw new TypeError("registry keys must be an integer userId or null.");
  return `u:${userId}`;
}

/**
 * Bind a socket to a user, replacing whatever that user had connected before.
 * @param {{userId: number|null, socket: object}} args
 * @returns {{evicted: object|null}} the socket displaced by this one, if any
 * @throws {TypeError} when `socket` is missing — storing a blank entry would
 *   occupy the key and muddle the `evicted` result of the next register — or
 *   when `userId` is neither an integer nor null (see keyFor). A throw, not a
 *   silent refusal: the caller must not be left believing a socket is bound.
 */
function register({ userId, socket }) {
  if (!socket) throw new TypeError("register() requires a socket.");
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
  // Asymmetric with register on purpose: a close handler must never be crashed
  // by a bad id, and there is nothing to drop anyway. register throws instead,
  // because a register that silently does nothing leaves the caller believing a
  // socket is bound when it is not.
  if (userId !== null && !Number.isInteger(userId)) return;
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
 *   `multiUserMode` is required and must be a real boolean — pass
 *   `await SystemSettings.isMultiUserMode()`.
 * @returns {{socket: object|null, error: string|null}}
 * @throws {TypeError} when `multiUserMode` is not a boolean.
 */
function resolve({ userId, multiUserMode }) {
  // Required, and required to be a boolean: `undefined` is falsy, so an omitted
  // argument would otherwise silently open the legacy null key in multi-user
  // mode. A throw rather than a returned error because a non-boolean flag is a
  // programmer error, and the `error` channel carries text a human reads in an
  // agent transcript.
  if (typeof multiUserMode !== "boolean")
    throw new TypeError(
      "resolve() requires an explicit boolean multiUserMode — pass await SystemSettings.isMultiUserMode()."
    );

  // No user on the run at all: never fall back to whoever happens to be online.
  if (userId === undefined) return { socket: null, error: NO_USER_ERROR };

  // `resolve` is the lower-trust entry point — its userId is threaded out of an
  // invocation record through code later tasks will extend, where a string or a
  // re-parsed JSON field can appear. Fail closed, and leak no detail about why.
  if (userId !== null && !Number.isInteger(userId))
    return { socket: null, error: NOT_CONNECTED_ERROR };

  if (userId === null) {
    // A null key is legitimate only while the instance has no users to confuse
    // it with. Once multi-user mode is on it must not match anybody.
    if (multiUserMode) return { socket: null, error: LEGACY_KEY_ERROR };
    return connectedSocketFor(SINGLE_USER_KEY);
  }

  return connectedSocketFor(keyFor(userId));
}

/** Test-only: clear module state between cases. */
function __reset() {
  sockets.clear();
}

module.exports = { register, unregister, resolve, __reset, SINGLE_USER_KEY };
