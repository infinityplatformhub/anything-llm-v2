// Private conversation text stays in the browser. This cache only bridges the
// authenticated HTTP request to its websocket, and is consumed after owner checks.
const pending = new Map();
const MAX_PENDING = 100;
const MAX_MESSAGES = 40;
const MAX_BYTES = 256 * 1024;
const HANDOFF_TTL_MS = 60_000;

function scope(invocation) {
  if (
    (!Number.isInteger(invocation?.user_id) || invocation.user_id <= 0) &&
    invocation?.browserDeviceUsed !== true
  )
    return null;
  return JSON.stringify([
    invocation.workspace_id,
    invocation.user_id ?? null,
    invocation.thread_id ?? null,
  ]);
}

function remove(uuid) {
  const entry = pending.get(uuid);
  if (entry) clearTimeout(entry.timer);
  pending.delete(uuid);
}

function cacheInvocationHistory(invocation, history) {
  const owner = scope(invocation);
  if (!owner || !Array.isArray(history)) return;
  const messages = history
    .filter(
      (message) =>
        (message?.role === "user" || message?.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim() &&
        (!message.type || message.type === "textResponse")
    )
    .slice(-MAX_MESSAGES)
    .map(({ role, content }) => ({ role, content }));
  let bytes = 0;
  const bounded = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    bytes += Buffer.byteLength(messages[i].content, "utf8");
    if (bytes > MAX_BYTES) break;
    bounded.unshift(messages[i]);
  }
  if (!bounded.length) return;
  remove(invocation.uuid);
  if (pending.size >= MAX_PENDING) remove(pending.keys().next().value);
  const timer = setTimeout(() => remove(invocation.uuid), HANDOFF_TTL_MS);
  timer.unref?.();
  pending.set(invocation.uuid, { owner, messages: bounded, timer });
}

function getAndClearInvocationHistory(invocation) {
  const entry = pending.get(invocation.uuid);
  if (!entry || entry.owner !== scope(invocation)) return [];
  remove(invocation.uuid);
  // Normal chat continues to use authoritative persisted history. Browser
  // replay is only needed for owner-verified Personal MCP conversations.
  return invocation.personalMcpUsed === true ||
    invocation.browserDeviceUsed === true
    ? entry.messages
    : [];
}

module.exports = { cacheInvocationHistory, getAndClearInvocationHistory };
