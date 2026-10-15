const { createHash, timingSafeEqual, randomUUID } = require("crypto");
const { decodeJWT, safeJsonParse } = require("../http");

const PROMPT_PREFIX = "android-browser-encrypted:";
const PROTOCOL_PREFIX = "anythingllm-android.";
const pending = new Map();
const HANDOFF_TTL = 60_000;
const MAX_PENDING = 100;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;

function hash(value) {
  return createHash("sha256").update(value).digest();
}

function sessionToken(request) {
  const authorization = request.headers?.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  return (
    String(request.headers?.["sec-websocket-protocol"] || "")
      .split(",")
      .map((part) => part.trim())
      .find((part) => part.startsWith("anythingllm-session."))
      ?.slice(20) || ""
  );
}

function scope(invocation) {
  return JSON.stringify([
    invocation.workspace_id,
    invocation.user_id ?? null,
    invocation.thread_id ?? null,
  ]);
}

// Called only inside the validated, all-role browser chat routes. A separate
// random browser capability prevents another tab, including the same user's
// tab, from binding its device to this invocation.
function fromResponse(request, response, binding) {
  if (binding == null) return null;
  if (
    typeof binding.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(binding.token) ||
    typeof binding.connected !== "boolean"
  )
    throw new Error("Invalid Android connection. Reconnect your device.");
  if (
    response.locals.multiUserMode &&
    (!response.locals.browserSessionUserId ||
      response.locals.browserSessionUserId !== response.locals.user?.id)
  )
    throw new Error("Android browser authentication is required.");
  return {
    keyHash: hash(binding.token),
    authHash: hash(sessionToken(request)),
    multiUser: response.locals.multiUserMode === true,
    verifyJwt:
      response.locals.multiUserMode === true ||
      (process.env.NODE_ENV !== "development" &&
        !!process.env.AUTH_TOKEN &&
        !!process.env.JWT_SECRET),
    connected: binding.connected,
  };
}

function remove(uuid) {
  const entry = pending.get(uuid);
  if (entry) clearTimeout(entry.timer);
  pending.delete(uuid);
}

function cache(invocation, context) {
  if (!context) return;
  remove(invocation.uuid);
  if (pending.size >= MAX_PENDING) remove(pending.keys().next().value);
  const timer = setTimeout(() => remove(invocation.uuid), HANDOFF_TTL);
  timer.unref?.();
  pending.set(invocation.uuid, {
    ...context,
    owner: scope(invocation),
    timer,
  });
}

async function fromSocket(request, invocation) {
  const entry = pending.get(invocation.uuid);
  if (!entry) {
    if (invocation.prompt?.startsWith(PROMPT_PREFIX))
      throw new Error("android_context_unavailable");
    return null;
  }
  const key = String(request.headers?.["sec-websocket-protocol"] || "")
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.startsWith(PROTOCOL_PREFIX))
    ?.slice(PROTOCOL_PREFIX.length);
  if (
    !key ||
    !/^[a-f0-9]{64}$/.test(key) ||
    !timingSafeEqual(hash(key), entry.keyHash) ||
    !timingSafeEqual(hash(sessionToken(request)), entry.authHash) ||
    scope(invocation) !== entry.owner
  )
    throw new Error("android_auth_required");

  let caller = null;
  const identity = require("../MCP/personalCaller");
  if (entry.multiUser) caller = await identity.fromSocket(request, invocation);
  const assert = async (current = invocation) => {
    if (scope(current) !== entry.owner)
      throw new Error("android_auth_required");
    const token = sessionToken(request);
    if (!timingSafeEqual(hash(token), entry.authHash))
      throw new Error("android_auth_required");
    // HTTP validated password-mode tokens as well as multi-user tokens. Recheck
    // signature/expiry on every frame and tool call without treating a shared
    // password or a no-password installation as a multi-user identity.
    if (entry.verifyJwt) {
      const payload = decodeJWT(token);
      if (!payload || (entry.multiUser ? !payload.id : !payload.p))
        throw new Error("android_auth_required");
    }
    if (entry.multiUser) await identity.assert(caller, current.workspace);
  };
  await assert();
  // Denied/expired viewers must not consume the owner's handoff.
  remove(invocation.uuid);
  return Object.freeze({ connected: entry.connected, assert });
}

function validateCommand(action, args = {}) {
  const integer = (value, max = 16_384) =>
    Number.isInteger(value) && value >= 0 && value <= max;
  switch (action) {
    case "inspect":
      return { screenshot: args.screenshot !== false };
    case "tap":
      if (integer(args.x) && integer(args.y)) return { x: args.x, y: args.y };
      break;
    case "swipe":
      if (
        [args.x1, args.y1, args.x2, args.y2].every((v) => integer(v)) &&
        integer(args.duration ?? 300, 2_000)
      )
        return {
          x1: args.x1,
          y1: args.y1,
          x2: args.x2,
          y2: args.y2,
          duration: args.duration ?? 300,
        };
      break;
    case "type":
      if (
        typeof args.text === "string" &&
        args.text.length > 0 &&
        Buffer.byteLength(args.text, "utf8") <= 8_192 &&
        !args.text.includes("\0")
      )
        return { text: args.text };
      break;
    case "key":
      if (
        ["BACK", "HOME", "ENTER", "DEL", "APP_SWITCH", "TAB"].includes(args.key)
      )
        return { key: args.key };
      break;
    case "open_app":
      if (
        typeof args.packageName === "string" &&
        args.packageName.length <= 200 &&
        /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/.test(args.packageName)
      )
        return { packageName: args.packageName };
      break;
  }
  throw new Error("Invalid Android action or parameters.");
}

function validateResult(action, result) {
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("Invalid Android response.");
  if (action !== "inspect") return { success: result.success === true };
  if (
    !Number.isInteger(result.width) ||
    !Number.isInteger(result.height) ||
    result.width <= 0 ||
    result.height <= 0 ||
    result.width > 16_384 ||
    result.height > 16_384
  )
    throw new Error("Invalid Android screen dimensions.");
  const value = {
    width: result.width,
    height: result.height,
    nodes: Array.isArray(result.nodes) ? result.nodes.slice(0, 400) : [],
    uiUnavailable: result.uiUnavailable === true,
  };
  // Only JPEG produced by the browser capture path is accepted. Arbitrary URLs,
  // HTML and provider-specific attachments cannot be supplied over this RPC.
  if (result.image) {
    const { data, mime, width, height } = result.image;
    if (
      mime !== "image/jpeg" ||
      typeof data !== "string" ||
      data.length > 1_500_000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data) ||
      !data.startsWith("/9j/") ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width > 1600 ||
      height > 1600
    )
      throw new Error("Invalid Android screenshot.");
    value.image = { data, mime, width, height };
  }
  return value;
}

function createRpc(socket, context, invocation) {
  const requests = new Map();
  let closed = false;
  const stop = () => {
    closed = true;
    for (const request of requests.values()) {
      clearTimeout(request.timer);
      request.reject(
        new Error("Android session stopped. Reconnect or send a new message.")
      );
    }
    requests.clear();
  };
  socket.on("close", stop);
  socket.handleAndroidResponse = (message) => {
    const data = safeJsonParse(message, {});
    if (data.type !== "androidResult") return false;
    const request = requests.get(data.id);
    if (!request) return true;
    requests.delete(data.id);
    clearTimeout(request.timer);
    if (Buffer.byteLength(String(message), "utf8") > MAX_RESULT_BYTES) {
      request.reject(new Error("Android response is too large."));
      return true;
    }
    context
      .assert(invocation)
      .then(() => {
        if (closed) throw new Error("Android session stopped.");
        if (data.error)
          throw new Error(
            "Android action failed. Check the connection and device screen."
          );
        request.resolve(validateResult(request.action, data.result));
      })
      .catch(request.reject);
    return true;
  };
  return {
    stop,
    async call(action, args) {
      const parameters = validateCommand(action, args);
      await context.assert(invocation);
      if (closed || socket.readyState !== socket.OPEN)
        throw new Error("Android session is disconnected.");
      if (requests.size >= 16)
        throw new Error("Too many Android actions are pending.");
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          requests.delete(id);
          if (!closed && socket.readyState === socket.OPEN)
            socket.send(JSON.stringify({ type: "androidCancel", id }));
          reject(
            new Error("Android action timed out. Check the device connection.")
          );
        }, 30_000);
        timer.unref?.();
        requests.set(id, { resolve, reject, timer, action });
        socket.send(
          JSON.stringify({
            type: "androidCommand",
            id,
            action,
            args: parameters,
          })
        );
      });
    },
  };
}

module.exports = {
  PROMPT_PREFIX,
  PROTOCOL_PREFIX,
  fromResponse,
  cache,
  fromSocket,
  createRpc,
  validateCommand,
};
