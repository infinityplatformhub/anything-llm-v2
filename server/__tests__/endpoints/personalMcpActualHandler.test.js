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
  PersonalMcpContext: Context,
} = require("../../models/personalMcpContext");
const {
  WorkspaceAgentInvocation: Invocation,
} = require("../../models/workspaceAgentInvocation");
const { AgentHandler } = require("../../utils/agents");
const AIbitat = require("../../utils/agents/aibitat");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { Telemetry } = require("../../models/telemetry");
const { agentWebsocket } = require("../../endpoints/agentWebsocket");
const { WORKSPACE_AGENT } = require("../../utils/agents/defaults");
const Layer = require("../../utils/MCP");
const { WorkspaceMcpServer } = require("../../models/workspaceMcpServer");
const { PersonalMcpGrant: Grant } = require("../../models/personalMcpGrant");
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const { WorkspaceParsedFiles } = require("../../models/workspaceParsedFiles");
let workspace, owner, other, route, attachments;
beforeAll(async () => {
  process.env.JWT_SECRET = "private-handler-session";
  process.env.OPEN_AI_KEY = "fixture";
  process.env.LLM_PROVIDER = "openai";
  workspace = await prisma.workspaces.create({
    data: {
      name: "Private handler",
      slug: crypto.randomUUID(),
      agentProvider: "openai",
      agentModel: "fixture",
      chatMode: "automatic",
    },
  });
  owner = await prisma.users.create({
    data: { username: crypto.randomUUID(), password: "fixture" },
  });
  other = await prisma.users.create({
    data: { username: crypto.randomUUID(), password: "fixture" },
  });
  for (const user of [owner, other])
    await prisma.workspace_users.create({
      data: { workspace_id: workspace.id, user_id: user.id },
    });
  await Context.mark({
    workspace_id: workspace.id,
    user_id: owner.id,
    thread_id: null,
  });
  // No current personal definition remains: durable context alone protects follow-ups.
  const { WorkspaceMcpServer } = require("../../models/workspaceMcpServer");
  await WorkspaceMcpServer.create(workspace.id, "removed-personal", {
    url: "https://fixture.example/mcp",
    anythingllm: { perUserAuth: true },
  });
  await WorkspaceMcpServer.delete(workspace.id, "removed-personal");
  agentWebsocket({ ws: (_path, fn) => (route = fn) });
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await prisma.workspaces.delete({ where: { id: workspace.id } });
  for (const user of [owner, other])
    await prisma.users.delete({ where: { id: user.id } });
  await prisma.$disconnect();
});
function socket() {
  const s = new EventEmitter();
  s.OPEN = 1;
  s.readyState = 1;
  s.send = jest.fn();
  s.rawSend = s.send;
  s.close = jest.fn(() => {
    s.readyState = 3;
  });
  return s;
}
function headers(user, expiresIn = "1h") {
  return user
    ? {
        "sec-websocket-protocol":
          "anythingllm-agent, anythingllm-session." +
          JWT.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn }),
      }
    : {};
}
async function followup(
  conversationHistory = [],
  message = "@agent quoted-private-owner-result"
) {
  const created = await Invocation.new({
    workspace,
    user: owner,
    prompt: message,
  });
  const { grepAgents } = require("../../utils/chats/agents");
  const spy = jest.spyOn(Invocation, "new").mockResolvedValue(created);
  await grepAgents({
    uuid: "fixture",
    response: { write: () => {}, flush: () => {} },
    message,
    workspace,
    user: owner,
    attachments: [{ contentString: "private-owner-attachment" }],
    conversationHistory,
  });
  spy.mockRestore();
  return created.invocation;
}
test("same-thread personal follow-up sends the previous stock question to the model after reconnect", async () => {
  const previousPrompt = "สรุป poro playmat ขายได้หรือยัง";
  const previousReply =
    "Poro Playmat Layout 3 ยังไม่มีสต็อก มีของพร้อมขายกี่ผืนครับ? จะลงที่ Red Ball Store Warehouse";
  const conversationHistory = [
    { role: "system", content: "client-supplied-system-must-not-be-promoted" },
    { role: "user", content: previousPrompt },
    {
      role: "assistant",
      type: "statusResponse",
      content: "transport-status-must-not-be-replayed",
    },
    { role: "assistant", content: previousReply },
    { role: "tool", content: "client-supplied-tool-must-not-be-promoted" },
  ];
  jest.spyOn(Telemetry, "sendTelemetry").mockResolvedValue();
  const thread = await prisma.workspace_threads.create({
    data: {
      name: "Follow-up fixture",
      slug: crypto.randomUUID(),
      workspace_id: workspace.id,
      user_id: owner.id,
    },
  });
  await Context.mark({
    workspace_id: workspace.id,
    user_id: owner.id,
    thread_id: thread.id,
  });
  const { WorkspaceThread } = require("../../models/workspaceThread");
  jest.spyOn(WorkspaceThread, "autoRenameThread").mockResolvedValue();
  const routes = {};
  require("../../endpoints/chat").chatEndpoints({
    post: (url, ...handlers) => {
      routes[url] = handlers[handlers.length - 1];
    },
  });
  const chunks = [];
  const response = {
    locals: { workspace, thread, user: owner },
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    flush: jest.fn(),
    end: jest.fn(),
    write: (chunk) =>
      chunks.push(JSON.parse(chunk.replace(/^data: /, "").trim())),
  };
  await routes["/workspace/:slug/thread/:threadSlug/stream-chat"](
    {
      body: {
        message: "1ผืน",
        conversationHistory,
        attachments: [{ contentString: "private-owner-attachment" }],
      },
    },
    response
  );
  const uuid = chunks.find(
    (chunk) => chunk.type === "agentInitWebsocketConnection"
  )?.websocketUUID;
  expect(uuid).toBeTruthy();
  const OpenAIProvider = require("../../utils/agents/aibitat/providers/openai");
  const provider = new OpenAIProvider({ options: { apiKey: "fixture" } });
  jest.spyOn(provider, "supportsAgentStreaming", "get").mockReturnValue(false);
  const request = jest
    .spyOn(provider.client.responses, "create")
    .mockResolvedValue({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "fixture-response" }],
        },
      ],
    });
  jest
    .spyOn(AIbitat.prototype, "getProviderForConfig")
    .mockReturnValue(provider);
  // Exercise the real reply/provider payload without parking on the feedback timer.
  jest
    .spyOn(AIbitat.prototype, "start")
    .mockImplementation(async function (input) {
      this.newMessage(input);
      await this.reply({ from: "@agent", to: "USER" });
    });
  const s = socket();
  await route(s, { params: { uuid }, headers: headers(owner) });
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0].input.slice(1)).toEqual([
    { role: "user", content: [{ type: "input_text", text: previousPrompt }] },
    {
      role: "assistant",
      content: [{ type: "output_text", text: previousReply }],
    },
    {
      role: "user",
      content: [
        { type: "input_text", text: "1ผืน" },
        { type: "input_image", image_url: "private-owner-attachment" },
      ],
    },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const shared = await WorkspaceChats.where({
    workspaceId: workspace.id,
    user_id: owner.id,
    include: true,
  });
  expect(shared).toEqual([]);
});
test.each(["anonymous", "other", "expired"])(
  "actual handler rejects private follow-up before init/files/history/attachments: %s",
  async (mode) => {
    const invocation = await followup([
      { role: "assistant", content: "private-owner-context-before-reconnect" },
    ]);
    expect(invocation.prompt).not.toContain("quoted-private-owner-result");
    const init = jest.spyOn(AgentHandler.prototype, "init");
    const history = jest.spyOn(WorkspaceChats, "where");
    const s = socket();
    await route(s, {
      params: { uuid: invocation.uuid },
      headers:
        mode === "anonymous"
          ? {}
          : headers(
              mode === "other" ? other : owner,
              mode === "expired" ? -1 : "1h"
            ),
    });
    expect(s.close).toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
    expect(init).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    attachments =
      require("../../utils/chats/agents").getAndClearInvocationAttachments(
        invocation.uuid
      );
    expect(JSON.stringify(attachments)).toContain("private-owner-attachment");
    jest.spyOn(Telemetry, "sendTelemetry").mockResolvedValue();
    jest
      .spyOn(AIbitat.prototype, "start")
      .mockImplementation(async function () {
        expect(this.chats.map((message) => message.content)).toContain(
          "private-owner-context-before-reconnect"
        );
      });
    const allowed = socket();
    await route(allowed, {
      params: { uuid: invocation.uuid },
      headers: headers(owner),
    });
    expect(allowed.close).not.toHaveBeenCalled();
  }
);
test("actual owner init decrypts private follow-up, real websocket plugin emits only while membership/session valid", async () => {
  const invocation = await followup();
  jest.spyOn(Telemetry, "sendTelemetry").mockResolvedValue();
  jest
    .spyOn(AIbitat.prototype, "start")
    .mockImplementation(async function (input) {
      expect(input.content).toContain("quoted-private-owner-result");
      expect(JSON.stringify(input.attachments)).toContain(
        "private-owner-attachment"
      );
      this.socket.send("reportStreamEvent", {
        content: "private-owner-response",
      });
    });
  const s = socket();
  const request = {
    params: { uuid: invocation.uuid },
    headers: headers(owner),
  };
  await route(s, request);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(s.close).not.toHaveBeenCalled();
  expect(JSON.stringify(s.rawSend.mock.calls)).toContain(
    "private-owner-response"
  );
});
test.each(["membership", "expiry"])(
  "actual owner socket stops private emissions after %s revocation",
  async (mode) => {
    const invocation = await followup();
    jest.spyOn(Telemetry, "sendTelemetry").mockResolvedValue();
    let instance;
    jest
      .spyOn(AIbitat.prototype, "start")
      .mockImplementation(async function () {
        instance = this;
      });
    const s = socket();
    await route(s, {
      params: { uuid: invocation.uuid },
      headers: headers(owner),
    });
    if (mode === "membership")
      await prisma.workspace_users.deleteMany({
        where: { workspace_id: workspace.id, user_id: owner.id },
      });
    else jest.spyOn(Date, "now").mockReturnValue(Date.now() + 7200000);
    instance.socket.send("reportStreamEvent", {
      content: "private-after-revoke",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(s.close).toHaveBeenCalled();
    expect(JSON.stringify(s.rawSend.mock.calls)).not.toContain(
      "private-after-revoke"
    );
    if (mode === "membership")
      await prisma.workspace_users.create({
        data: { workspace_id: workspace.id, user_id: owner.id },
      });
  }
);
test("actual handler preserves genuinely legacy-only context for an anonymous socket", async () => {
  const { invocation } = await Invocation.new({
    workspace,
    user: other,
    prompt: "@agent legacy-only-input",
  });
  jest.spyOn(Telemetry, "sendTelemetry").mockResolvedValue();
  jest
    .spyOn(AIbitat.prototype, "start")
    .mockImplementation(async function (input) {
      expect(this.personalMcpUsed).toBe(false);
      expect(input.content).toBe("legacy-only-input");
      this.socket.send("reportStreamEvent", {
        content: "legacy-only-response",
      });
    });
  const s = socket();
  await route(s, { params: { uuid: invocation.uuid }, headers: {} });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(s.close).not.toHaveBeenCalled();
  expect(JSON.stringify(s.rawSend.mock.calls)).toContain(
    "legacy-only-response"
  );
});
test.each(["anonymous", "other"])(
  "first connected-personal preparation reserves owner before deferred discovery; rejects %s competitor",
  async (mode) => {
    const config = {
      url: "https://fixture.example/mcp",
      anythingllm: { perUserAuth: true },
    };
    await WorkspaceMcpServer.create(workspace.id, "first-personal", config);
    const grant = await Grant.begin(
      workspace.id,
      other.id,
      "first-personal",
      config
    );
    await Grant.save(
      workspace.id,
      other.id,
      "first-personal",
      grant.version,
      config,
      { access_token: "fixture-connected", refresh_token: "fixture-refresh" }
    );
    const { invocation } = await Invocation.new({
      workspace,
      user: other,
      prompt: "@agent first-owner-sensitive",
      thread: { id: mode === "anonymous" ? 987 : 988 },
    });
    const { grepAgents } = require("../../utils/chats/agents");
    const creation = jest
      .spyOn(Invocation, "new")
      .mockResolvedValue({ invocation });
    await grepAgents({
      uuid: "fixture",
      response: { write: () => {}, flush: () => {} },
      message: "@agent first-owner-sensitive",
      workspace,
      user: other,
      attachments: [{ contentString: "first-owner-attachment" }],
    });
    creation.mockRestore();
    let release, entered;
    const waiting = new Promise((resolve) => (entered = resolve));
    jest
      .spyOn(Layer.prototype, "bootPersonalServer")
      .mockImplementation(async () => {
        entered();
        await new Promise((resolve) => (release = resolve));
        return {};
      });
    jest
      .spyOn(WORKSPACE_AGENT, "getDefinition")
      .mockImplementation(async (_provider, ws, _user, _prompt, identity) => {
        await new Layer().activeMCPServers(ws, identity);
        return { functions: [] };
      });
    jest.spyOn(Telemetry, "sendTelemetry").mockResolvedValue();
    jest.spyOn(AIbitat.prototype, "start").mockResolvedValue();
    const init = jest.spyOn(AgentHandler.prototype, "init");
    const history = jest.spyOn(WorkspaceChats, "where");
    const ownerSocket = socket();
    const pending = route(ownerSocket, {
      params: { uuid: invocation.uuid },
      headers: headers(other),
    });
    await waiting;
    const reserved = await Context.has(invocation);
    const observed = execFileSync(
      process.execPath,
      [
        "-e",
        `const b=require('buffer');b.SlowBuffer||=b.Buffer;const {PersonalMcpContext:C}=require('./models/personalMcpContext');C.has(${JSON.stringify(invocation)}).then(v=>{console.log('RESERVED='+v);return require('./utils/prisma').$disconnect();}).catch(()=>process.exit(1));`,
      ],
      {
        cwd: path.resolve(__dirname, "../.."),
        env: process.env,
        encoding: "utf8",
      }
    );
    expect(observed).toContain("RESERVED=true");
    const before = init.mock.calls.length,
      reads = history.mock.calls.length;
    const competing = socket();
    await route(competing, {
      params: { uuid: invocation.uuid },
      headers: mode === "anonymous" ? {} : headers(owner),
    });
    expect(competing.close).toHaveBeenCalled();
    expect(competing.rawSend).not.toHaveBeenCalled();
    expect(init.mock.calls).toHaveLength(before);
    expect(history.mock.calls).toHaveLength(reads);
    release();
    await pending;
    expect(reserved).toBe(true);
    await WorkspaceMcpServer.delete(workspace.id, "first-personal");
    await prisma.personal_mcp_grants.deleteMany({
      where: { workspace_id: workspace.id, server_name: "first-personal" },
    });
  }
);
test("disconnected personal definition for creator does not reserve genuinely legacy context", async () => {
  const config = {
    url: "https://fixture.example/mcp",
    anythingllm: { perUserAuth: true },
  };
  await WorkspaceMcpServer.create(
    workspace.id,
    "disconnected-personal",
    config
  );
  await Grant.begin(workspace.id, other.id, "disconnected-personal", config);
  const { invocation } = await Invocation.new({
    workspace,
    user: other,
    thread: { id: 989 },
    prompt: "@agent disconnected-legacy",
  });
  jest.spyOn(Telemetry, "sendTelemetry").mockResolvedValue();
  jest
    .spyOn(AIbitat.prototype, "start")
    .mockImplementation(async function (input) {
      expect(input.content).toBe("disconnected-legacy");
      this.socket.send("reportStreamEvent", {
        content: "disconnected-legacy-result",
      });
    });
  const s = socket();
  await route(s, { params: { uuid: invocation.uuid }, headers: {} });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(await Context.has(invocation)).toBe(false);
  expect(s.close).not.toHaveBeenCalled();
  expect(JSON.stringify(s.rawSend.mock.calls)).toContain(
    "disconnected-legacy-result"
  );
  await WorkspaceMcpServer.delete(workspace.id, "disconnected-personal");
});

test.each(
  [
    "malformed-global",
    "empty-file",
    "missing-catalog-block",
    "null-catalog",
    "array-catalog",
    "read-failure",
    "corrupt-shadow",
    "shadow-lookup",
    "corrupt-tokens",
    "missing-tokens",
    "grant-list",
    "grant-find",
    "config-lookup",
  ].flatMap((failure) => ["anonymous", "other"].map((mode) => [failure, mode]))
)(
  "unknown first-use classification %s rejects %s before context side effects; restored owner works",
  async (failure, mode) => {
    const name = `strict-${crypto.randomBytes(6).toString("hex")}`;
    const config = {
      url: "https://fixture.example/mcp",
      anythingllm: { perUserAuth: true },
    };
    const catalogPath = new Layer().mcpServerJSONPath;
    const original = fs.readFileSync(catalogPath, "utf8");
    const validCatalog = JSON.stringify({ mcpServers: { [name]: config } });
    let fault;
    try {
      fs.writeFileSync(catalogPath, validCatalog);
      const row = await Grant.begin(workspace.id, other.id, name, config);
      await Grant.save(workspace.id, other.id, name, row.version, config, {
        access_token: "strict-owner-token",
      });
      const saved = await prisma.personal_mcp_grants.findUnique({
        where: {
          workspace_id_user_id_server_name: {
            workspace_id: workspace.id,
            user_id: other.id,
            server_name: name,
          },
        },
      });
      const { invocation } = await Invocation.new({
        workspace,
        user: other,
        thread: { id: 10000 + Math.floor(Math.random() * 1000000) },
        prompt: "@agent strict-private-input",
      });
      const {
        grepAgents,
        getAndClearInvocationAttachments,
      } = require("../../utils/chats/agents");
      const creation = jest
        .spyOn(Invocation, "new")
        .mockResolvedValue({ invocation });
      await grepAgents({
        uuid: "fixture",
        response: { write: () => {}, flush: () => {} },
        message: "@agent strict-private-input",
        workspace,
        user: other,
        attachments: [{ contentString: "strict-private-attachment" }],
      });
      creation.mockRestore();
      if (failure === "malformed-global")
        fs.writeFileSync(catalogPath, "this is not a JSON catalog");
      if (failure === "empty-file") fs.writeFileSync(catalogPath, "");
      if (failure === "missing-catalog-block")
        fs.writeFileSync(catalogPath, "{}");
      if (failure === "null-catalog") fs.writeFileSync(catalogPath, "null");
      if (failure === "array-catalog") fs.writeFileSync(catalogPath, "[]");
      if (failure === "read-failure") {
        const read = fs.readFileSync.bind(fs);
        fault = jest
          .spyOn(fs, "readFileSync")
          .mockImplementation((file, ...args) => {
            if (file === catalogPath)
              throw new Error("fixture-secret-read-failure");
            return read(file, ...args);
          });
      }
      if (failure === "corrupt-shadow") {
        await WorkspaceMcpServer.create(workspace.id, name, config);
        await prisma.workspace_mcp_servers.update({
          where: { workspace_id_name: { workspace_id: workspace.id, name } },
          data: { config: "corrupt-ciphertext" },
        });
      }
      if (failure === "corrupt-tokens")
        await prisma.personal_mcp_grants.update({
          where: { id: saved.id },
          data: { tokens: "corrupt-tokens" },
        });
      if (failure === "missing-tokens")
        await prisma.personal_mcp_grants.update({
          where: { id: saved.id },
          data: { tokens: null },
        });
      if (failure === "grant-list")
        fault = jest
          .spyOn(prisma.personal_mcp_grants, "findMany")
          .mockRejectedValue(new Error("fixture-secret-grant-failure"));
      if (failure === "grant-find")
        fault = jest
          .spyOn(Grant, "find")
          .mockRejectedValue(new Error("fixture-secret-token-failure"));
      if (failure === "shadow-lookup")
        fault = jest
          .spyOn(prisma.workspace_mcp_servers, "findUnique")
          .mockRejectedValue(new Error("fixture-secret-shadow-failure"));
      if (failure === "config-lookup")
        fault = jest
          .spyOn(Layer, "findServerConfigStrict")
          .mockRejectedValue(new Error("fixture-secret-config-failure"));
      const init = jest.spyOn(AgentHandler.prototype, "init");
      const history = jest.spyOn(WorkspaceChats, "where");
      const files = jest.spyOn(WorkspaceParsedFiles, "getContextFiles");
      const provider = jest.spyOn(AgentHandler.prototype, "checkSetup");
      const definition = jest.spyOn(WORKSPACE_AGENT, "getDefinition");
      jest.spyOn(Telemetry, "sendTelemetry").mockResolvedValue();
      const start = jest
        .spyOn(AIbitat.prototype, "start")
        .mockImplementation(async function (input) {
          this.socket.send("reportStreamEvent", { content: input.content });
        });
      const denied = socket();
      await route(denied, {
        params: { uuid: invocation.uuid },
        headers: mode === "anonymous" ? {} : headers(owner),
      });
      expect(denied.close).toHaveBeenCalled();
      expect(denied.rawSend).not.toHaveBeenCalled();
      for (const spy of [init, history, files, provider, definition, start])
        expect(spy).not.toHaveBeenCalled();
      expect(await Context.has(invocation)).toBe(false);
      const stored = await prisma.workspace_agent_invocations.findUnique({
        where: { uuid: invocation.uuid },
      });
      expect(stored.closed).toBe(false);
      // Independent init must also reject before provider/attachment consumption.
      await expect(
        new AgentHandler({ uuid: invocation.uuid }).init()
      ).rejects.toThrow("personal_context_unavailable");
      for (const spy of [history, files, provider, definition, start])
        expect(spy).not.toHaveBeenCalled();
      fault?.mockRestore();
      fs.writeFileSync(catalogPath, validCatalog);
      if (failure === "corrupt-shadow")
        await WorkspaceMcpServer.update(workspace.id, name, config);
      if (["corrupt-tokens", "missing-tokens"].includes(failure))
        await prisma.personal_mcp_grants.update({
          where: { id: saved.id },
          data: { tokens: saved.tokens },
        });
      const allowed = socket();
      await route(allowed, {
        params: { uuid: invocation.uuid },
        headers: headers(other),
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(allowed.close).not.toHaveBeenCalled();
      expect(await Context.has(invocation)).toBe(true);
      expect(JSON.stringify(allowed.rawSend.mock.calls)).toContain(
        "strict-private-input"
      );
      expect(JSON.stringify(start.mock.calls[0][0].attachments)).toContain(
        "strict-private-attachment"
      );
      expect(getAndClearInvocationAttachments(invocation.uuid)).toEqual([]);
    } finally {
      fault?.mockRestore();
      fs.writeFileSync(catalogPath, original);
      await prisma.workspace_mcp_servers.deleteMany({
        where: { workspace_id: workspace.id, name },
      });
      await prisma.personal_mcp_grants.deleteMany({
        where: { workspace_id: workspace.id, server_name: name },
      });
    }
  }
);

test.each(["deleted", "disabled", "nonpersonal", "unrelated-user"])(
  "actual endpoint preserves healthy %s legacy access without owner reservation",
  async (mode) => {
    const name = `legacy-${crypto.randomBytes(6).toString("hex")}`;
    const config = {
      url: "https://fixture.example/mcp",
      anythingllm: { perUserAuth: true },
    };
    const catalogPath = new Layer().mcpServerJSONPath;
    const original = fs.readFileSync(catalogPath, "utf8");
    try {
      const grantUser = mode === "unrelated-user" ? owner : other;
      const row = await Grant.begin(workspace.id, grantUser.id, name, config);
      await Grant.save(workspace.id, grantUser.id, name, row.version, config, {
        access_token: "fixture",
      });
      if (mode === "disabled")
        await Grant.clear(workspace.id, grantUser.id, name);
      fs.writeFileSync(
        catalogPath,
        JSON.stringify({
          mcpServers:
            mode === "deleted"
              ? {}
              : {
                  [name]:
                    mode === "nonpersonal"
                      ? { command: "node", args: ["fixture.js"] }
                      : config,
                },
        })
      );
      // An unrelated creator must not consult even an unreadable catalog.
      if (mode === "unrelated-user")
        fs.writeFileSync(catalogPath, "not a catalog");
      const { invocation } = await Invocation.new({
        workspace,
        user: other,
        thread: { id: 2000000 + Math.floor(Math.random() * 1000000) },
        prompt: "@agent strict-legacy-input",
      });
      jest.spyOn(Telemetry, "sendTelemetry").mockResolvedValue();
      jest
        .spyOn(AIbitat.prototype, "start")
        .mockImplementation(async function (input) {
          this.socket.send("reportStreamEvent", { content: input.content });
        });
      const s = socket();
      await route(s, { params: { uuid: invocation.uuid }, headers: {} });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(await Context.has(invocation)).toBe(false);
      expect(s.close).not.toHaveBeenCalled();
      expect(JSON.stringify(s.rawSend.mock.calls)).toContain(
        "strict-legacy-input"
      );
    } finally {
      fs.writeFileSync(catalogPath, original);
      await prisma.personal_mcp_grants.deleteMany({
        where: { workspace_id: workspace.id, server_name: name },
      });
    }
  }
);
