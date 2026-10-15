require("../utils/lark/_polyfill");
jest.mock("../../utils/agents/defaults", () => ({
  USER_AGENT: { name: "USER", getDefinition: () => ({}) },
  WORKSPACE_AGENT: {
    name: "@agent",
    getDefinition: async () => ({ functions: [] }),
  },
}));
const crypto = require("crypto");
const JWT = require("jsonwebtoken");
const { EventEmitter } = require("events");
const prisma = require("../../utils/prisma");
const {
  WorkspaceAgentInvocation: Invocation,
} = require("../../models/workspaceAgentInvocation");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { WorkspaceThread } = require("../../models/workspaceThread");
const { User } = require("../../models/user");
const { AgentHandler } = require("../../utils/agents");
const AIbitat = require("../../utils/agents/aibitat");
const { Telemetry } = require("../../models/telemetry");
const { agentWebsocket } = require("../../endpoints/agentWebsocket");
const bridge = require("../../utils/agents/androidBridge");
let workspace, owner, other, thread, wsRoute, httpRoutes;
const deviceKey = "f".repeat(64);
beforeAll(async () => {
  process.env.JWT_SECRET = "android-fixture-session";
  process.env.OPEN_AI_KEY = "fixture";
  process.env.LLM_PROVIDER = "openai";
  workspace = await prisma.workspaces.create({
    data: {
      name: "Android fixture",
      slug: crypto.randomUUID(),
      agentProvider: "openai",
      agentModel: "fixture",
      chatMode: "chat",
    },
  });
  owner = await prisma.users.create({
    data: {
      username: crypto.randomUUID(),
      password: "fixture",
      role: "default",
    },
  });
  other = await prisma.users.create({
    data: {
      username: crypto.randomUUID(),
      password: "fixture",
      role: "manager",
    },
  });
  for (const user of [owner, other])
    await prisma.workspace_users.create({
      data: { workspace_id: workspace.id, user_id: user.id },
    });
  thread = await prisma.workspace_threads.create({
    data: {
      name: "Android",
      slug: crypto.randomUUID(),
      workspace_id: workspace.id,
      user_id: owner.id,
    },
  });
  agentWebsocket({
    ws: (_path, callback) => {
      wsRoute = callback;
    },
  });
  httpRoutes = {};
  require("../../endpoints/chat").chatEndpoints({
    post: (url, ...handlers) => {
      httpRoutes[url] = handlers.at(-1);
    },
  });
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await prisma.workspaces.delete({ where: { id: workspace.id } });
  for (const user of [owner, other])
    await prisma.users.delete({ where: { id: user.id } });
  await prisma.$disconnect();
});
function token(user = owner) {
  return JWT.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: "1h" });
}
function socket() {
  const s = new EventEmitter();
  s.OPEN = 1;
  s.readyState = 1;
  s.send = jest.fn();
  s.rawSend = s.send;
  s.close = jest.fn(() => {
    s.readyState = 3;
    s.emit("close");
  });
  return s;
}
async function createThroughHttp(session, multiUser = true) {
  jest.spyOn(Telemetry, "sendTelemetry").mockResolvedValue();
  jest.spyOn(User, "canSendChat").mockResolvedValue(true);
  jest.spyOn(WorkspaceThread, "autoRenameThread").mockResolvedValue();
  const chunks = [];
  const response = {
    locals: {
      workspace,
      thread,
      multiUserMode: multiUser,
      user: multiUser ? owner : null,
      browserSessionUserId: multiUser ? owner.id : null,
    },
    setHeader() {},
    flushHeaders() {},
    flush() {},
    end() {},
    write: (chunk) =>
      chunks.push(JSON.parse(chunk.replace(/^data: /, "").trim())),
  };
  await httpRoutes["/workspace/:slug/thread/:threadSlug/stream-chat"](
    {
      header: (name) =>
        name.toLowerCase() === "authorization" && session
          ? "Bearer " + session
          : null,
      headers: session ? { authorization: "Bearer " + session } : {},
      body: {
        message: "ดูหน้าจอมือถือของฉัน",
        androidBridge: { token: deviceKey, connected: true },
        conversationHistory: [
          { role: "assistant", content: "private Android previous reply" },
        ],
      },
    },
    response
  );
  const uuid = chunks.find(
    (chunk) => chunk.type === "agentInitWebsocketConnection"
  )?.websocketUUID;
  expect(uuid).toBeTruthy();
  expect(WorkspaceThread.autoRenameThread).not.toHaveBeenCalled();
  return uuid;
}
function wsRequest(uuid, session, key = deviceKey) {
  return {
    params: { uuid },
    headers: {
      "sec-websocket-protocol": [
        "anythingllm-agent",
        ...(session ? ["anythingllm-session." + session] : []),
        "anythingllm-android." + key,
      ].join(", "),
    },
  };
}

test("default-role HTTP → owner websocket → device tool → model includes image and UI, with no shared private history", async () => {
  const session = token(),
    uuid = await createThroughHttp(session);
  const stored = await Invocation.get({ uuid });
  expect(stored.prompt.startsWith(bridge.PROMPT_PREFIX)).toBe(true);
  expect(stored.prompt).not.toContain("ดูหน้าจอ");
  const OpenAIProvider = require("../../utils/agents/aibitat/providers/openai");
  const provider = new OpenAIProvider({ options: { apiKey: "fixture" } });
  jest.spyOn(provider, "supportsAgentStreaming", "get").mockReturnValue(false);
  const request = jest
    .spyOn(provider.client.responses, "create")
    .mockResolvedValueOnce({
      output: [
        {
          type: "function_call",
          name: "android_inspect",
          call_id: "inspect-1",
          arguments: '{"screenshot":true}',
        },
      ],
    })
    .mockResolvedValueOnce({
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: "private Android screen summary" },
          ],
        },
      ],
    });
  jest
    .spyOn(AIbitat.prototype, "getProviderForConfig")
    .mockReturnValue(provider);
  jest
    .spyOn(AIbitat.prototype, "start")
    .mockImplementation(async function (input) {
      this.newMessage(input);
      await this.reply({ from: "@agent", to: "USER" });
    });
  const s = socket();
  s.rawSend.mockImplementation((raw) => {
    const data = JSON.parse(raw);
    if (data.type === "androidCommand")
      queueMicrotask(() =>
        s.emit(
          "message",
          JSON.stringify({
            type: "androidResult",
            id: data.id,
            result: {
              width: 1080,
              height: 2400,
              nodes: [
                { text: "private Android UI label", bounds: "[0,0][200,80]" },
              ],
              image: {
                mime: "image/jpeg",
                data: "/9j/2Q==",
                width: 720,
                height: 1600,
              },
            },
          })
        )
      );
  });
  await wsRoute(s, wsRequest(uuid, session));
  expect(request).toHaveBeenCalledTimes(2);
  const payload = request.mock.calls[1][0];
  expect(JSON.stringify(payload)).toContain("private Android UI label");
  expect(JSON.stringify(payload)).toContain("data:image/jpeg;base64,/9j/2Q==");
  expect(JSON.stringify(request.mock.calls[0][0])).toContain(
    "private Android previous reply"
  );
  await new Promise((resolve) => setTimeout(resolve, 75));
  const rows = await WorkspaceChats.where({
    workspaceId: workspace.id,
    user_id: owner.id,
  });
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((row) => row.include === false)).toBe(true);
  expect(JSON.stringify(rows)).not.toContain("private Android screen summary");
  expect(JSON.stringify(rows)).not.toContain("private Android UI label");
  s.close();
});

test.each(["other-user", "same-user-other-browser"])(
  "%s cannot initialize or consume the device handoff",
  async (mode) => {
    const session = token(),
      uuid = await createThroughHttp(session);
    const init = jest.spyOn(AgentHandler.prototype, "init");
    const denied = socket();
    await wsRoute(
      denied,
      wsRequest(
        uuid,
        mode === "other-user" ? token(other) : session,
        mode === "same-user-other-browser" ? "e".repeat(64) : deviceKey
      )
    );
    expect(denied.close).toHaveBeenCalled();
    expect(init).not.toHaveBeenCalled();
    expect(denied.rawSend).not.toHaveBeenCalled();
    jest
      .spyOn(AIbitat.prototype, "start")
      .mockImplementation(async function () {
        expect(this.agents.get("@agent").functions).toContain(
          "android_inspect"
        );
      });
    const allowed = socket();
    await wsRoute(allowed, wsRequest(uuid, session));
    expect(allowed.close).not.toHaveBeenCalled();
    allowed.close();
  }
);

test("single-user no-password installations still require their browser's capability", async () => {
  const previousAuth = process.env.AUTH_TOKEN;
  delete process.env.AUTH_TOKEN;
  try {
    const uuid = await createThroughHttp(null, false);
    jest
      .spyOn(AIbitat.prototype, "start")
      .mockImplementation(async function () {
        expect(this.browserDeviceUsed).toBe(true);
        expect(this.chats.map((chat) => chat.content)).toContain(
          "private Android previous reply"
        );
      });
    const denied = socket();
    await wsRoute(denied, wsRequest(uuid, null, "0".repeat(64)));
    expect(denied.close).toHaveBeenCalled();
    const allowed = socket();
    await wsRoute(allowed, wsRequest(uuid, null));
    expect(allowed.close).not.toHaveBeenCalled();
    allowed.close();
  } finally {
    if (previousAuth === undefined) delete process.env.AUTH_TOKEN;
    else process.env.AUTH_TOKEN = previousAuth;
  }
});

test("single-user password sessions bind without requiring a multi-user account", async () => {
  const previousAuth = process.env.AUTH_TOKEN;
  process.env.AUTH_TOKEN = "android-fixture-password";
  try {
    const { EncryptionManager } = require("../../utils/EncryptionManager");
    const session = JWT.sign(
      { p: new EncryptionManager().encrypt(process.env.AUTH_TOKEN) },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );
    const uuid = await createThroughHttp(session, false);
    jest
      .spyOn(AIbitat.prototype, "start")
      .mockImplementation(async function () {
        expect(this.browserDeviceUsed).toBe(true);
        expect(this.agents.get("@agent").functions).toContain(
          "android_control"
        );
      });
    const allowed = socket();
    await wsRoute(allowed, wsRequest(uuid, session));
    expect(allowed.close).not.toHaveBeenCalled();
    allowed.close();
  } finally {
    if (previousAuth === undefined) delete process.env.AUTH_TOKEN;
    else process.env.AUTH_TOKEN = previousAuth;
  }
});

test("revoking workspace membership stops a bound Android session before further frames", async () => {
  const session = token(),
    uuid = await createThroughHttp(session);
  jest.spyOn(AIbitat.prototype, "start").mockResolvedValue();
  const s = socket();
  await wsRoute(s, wsRequest(uuid, session));
  await prisma.workspace_users.deleteMany({
    where: { workspace_id: workspace.id, user_id: owner.id },
  });
  try {
    s.emit(
      "message",
      JSON.stringify({ type: "awaitingFeedback", feedback: "control Android" })
    );
    for (
      let attempt = 0;
      attempt < 20 && s.close.mock.calls.length === 0;
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(s.close).toHaveBeenCalled();
  } finally {
    await prisma.workspace_users.create({
      data: { workspace_id: workspace.id, user_id: owner.id },
    });
  }
});

test("Android and an existing private Personal MCP conversation can share the same owner-verified invocation", async () => {
  await require("../../models/personalMcpContext").PersonalMcpContext.mark({
    workspace_id: workspace.id,
    user_id: owner.id,
    thread_id: thread.id,
  });
  const session = token(),
    uuid = await createThroughHttp(session);
  jest
    .spyOn(AIbitat.prototype, "start")
    .mockImplementation(async function (input) {
      expect(this.personalMcpUsed).toBe(true);
      expect(this.browserDeviceUsed).toBe(true);
      expect(input.content).toBe("ดูหน้าจอมือถือของฉัน");
      expect(this.agents.get("@agent").functions).toContain("android_inspect");
      expect(this.chats.map((chat) => chat.content)).toContain(
        "private Android previous reply"
      );
    });
  const allowed = socket();
  await wsRoute(allowed, wsRequest(uuid, session));
  expect(allowed.close).not.toHaveBeenCalled();
  allowed.close();
});
