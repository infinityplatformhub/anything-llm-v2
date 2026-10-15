require("../lark/_polyfill");
const { EventEmitter } = require("events");
const { randomUUID } = require("crypto");
const bridge = require("../../../utils/agents/androidBridge");
const {
  androidPlugin,
} = require("../../../utils/agents/aibitat/plugins/android");

const key = "a".repeat(64);
function invocation() {
  return {
    uuid: randomUUID(),
    workspace_id: 9,
    user_id: null,
    thread_id: 12,
    workspace: { id: 9 },
    prompt: bridge.PROMPT_PREFIX + "encrypted-fixture",
  };
}
function socket() {
  const s = new EventEmitter();
  s.OPEN = 1;
  s.readyState = 1;
  s.send = jest.fn();
  return s;
}
function cache(inv) {
  const context = bridge.fromResponse(
    { headers: {} },
    { locals: { multiUserMode: false } },
    { token: key, connected: true }
  );
  bridge.cache(inv, context);
}
const request = (token = key) => ({
  headers: {
    "sec-websocket-protocol": "anythingllm-agent, anythingllm-android." + token,
  },
});

test("another browser or thread cannot consume the original browser's one-shot handoff", async () => {
  const inv = invocation();
  cache(inv);
  await expect(bridge.fromSocket(request("b".repeat(64)), inv)).rejects.toThrow(
    "android_auth_required"
  );
  await expect(
    bridge.fromSocket(request(), { ...inv, thread_id: 13 })
  ).rejects.toThrow("android_auth_required");
  const context = await bridge.fromSocket(request(), inv);
  await expect(context.assert(inv)).resolves.toBeUndefined();
  await expect(bridge.fromSocket(request(), inv)).rejects.toThrow(
    "android_context_unavailable"
  );
});

test("expired handoffs and a restarted backend fail closed rather than loading private prompts", async () => {
  jest.useFakeTimers();
  try {
    const inv = invocation();
    cache(inv);
    jest.advanceTimersByTime(60_001);
    await expect(bridge.fromSocket(request(), inv)).rejects.toThrow(
      "android_context_unavailable"
    );
    await expect(bridge.fromSocket(request(), invocation())).rejects.toThrow(
      "android_context_unavailable"
    );
  } finally {
    jest.useRealTimers();
  }
});

test("only the initiating websocket can complete a device RPC", async () => {
  const inv = invocation();
  cache(inv);
  const context = await bridge.fromSocket(request(), inv);
  const owner = socket(),
    other = socket();
  const rpc = bridge.createRpc(owner, context, inv);
  bridge.createRpc(other, context, inv);
  const operation = rpc.call("tap", { x: 20, y: 30 });
  await Promise.resolve();
  await Promise.resolve();
  const command = JSON.parse(owner.send.mock.calls[0][0]);
  const response = JSON.stringify({
    type: "androidResult",
    id: command.id,
    result: { success: true },
  });
  expect(other.handleAndroidResponse(response)).toBe(true);
  let complete = false;
  operation.then(() => {
    complete = true;
  });
  await Promise.resolve();
  expect(complete).toBe(false);
  owner.handleAndroidResponse(response);
  await expect(operation).resolves.toEqual({ success: true });
  rpc.stop();
});

test("disconnect rejects pending actions and prevents subsequent commands", async () => {
  const inv = invocation();
  cache(inv);
  const context = await bridge.fromSocket(request(), inv);
  const s = socket(),
    rpc = bridge.createRpc(s, context, inv);
  const operation = rpc.call("key", { key: "HOME" });
  await Promise.resolve();
  await Promise.resolve();
  const rejection = expect(operation).rejects.toThrow("stopped");
  s.emit("close");
  await rejection;
  await expect(rpc.call("tap", { x: 1, y: 2 })).rejects.toThrow("disconnected");
});

test.each([
  ["shell", { command: "rm -rf /sdcard" }],
  ["open_app", { packageName: "com.example; input keyevent 3" }],
  ["tap", { x: NaN, y: 2 }],
  ["swipe", { x1: 0, y1: 0, x2: 10, y2: 10, duration: 9999 }],
  ["type", { text: "x".repeat(8193) }],
  ["key", { key: "POWER" }],
])("rejects unsupported or unsafe typed command %s", (action, args) => {
  expect(() => bridge.validateCommand(action, args)).toThrow("Invalid Android");
});

test("inspection uses real image attachments and keeps base64 out of tool text", async () => {
  const functions = new Map();
  const ai = {
    onAbort: jest.fn(),
    function: (fn) => functions.set(fn.name, fn),
    addToolAttachment: jest.fn(),
  };
  const rpc = {
    stop: jest.fn(),
    call: jest.fn().mockResolvedValue({
      width: 1080,
      height: 2400,
      nodes: [{ text: "ค้นหา", bounds: "[10,20][100,80]" }],
      image: {
        mime: "image/jpeg",
        data: "/9j/fixture",
        width: 720,
        height: 1600,
      },
    }),
  };
  androidPlugin(rpc).setup(ai);
  const result = await functions.get("android_inspect").handler({});
  expect(JSON.parse(result)).toMatchObject({
    width: 1080,
    screenshotWidth: 720,
    nodes: [{ text: "ค้นหา" }],
  });
  expect(result).not.toContain("/9j/fixture");
  expect(ai.addToolAttachment).toHaveBeenCalledWith({
    name: "android-screen.jpg",
    mime: "image/jpeg",
    contentString: "data:image/jpeg;base64,/9j/fixture",
  });
});
