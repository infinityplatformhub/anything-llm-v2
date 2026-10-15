/* global jest */
const {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} = require("@jest/globals");
require("../utils/lark/_polyfill");
jest.mock("../../utils/agents", () => ({ AgentHandler: jest.fn() }));
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn().mockResolvedValue() },
}));
jest.mock("../../utils/MCP", () => jest.fn());
jest.mock("../../utils/agents/aibitat/plugins/websocket", () => ({
  WEBSOCKET_BAIL_COMMANDS: [],
}));
const { EventEmitter } = require("events");
const crypto = require("crypto");
const JWT = require("jsonwebtoken");
const prisma = require("../../utils/prisma");
const { AgentHandler } = require("../../utils/agents");
const Layer = require("../../utils/MCP");
const caller = require("../../utils/MCP/personalCaller");
const {
  WorkspaceAgentInvocation,
} = require("../../models/workspaceAgentInvocation");
const { agentWebsocket } = require("../../endpoints/agentWebsocket");
let workspace, a, b;
beforeAll(async () => {
  process.env.JWT_SECRET = "socket-endpoint-test";
  workspace = await prisma.workspaces.create({
    data: { name: "Socket endpoint", slug: crypto.randomUUID() },
  });
  for (const name of ["a", "b"]) {
    const user = await prisma.users.create({
      data: { username: name + crypto.randomUUID(), password: "unused" },
    });
    await prisma.workspace_users.create({
      data: { workspace_id: workspace.id, user_id: user.id },
    });
    if (name === "a") a = user;
    else b = user;
  }
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});
afterAll(async () => {
  await prisma.workspaces.delete({ where: { id: workspace.id } });
  for (const user of [a, b])
    await prisma.users.delete({ where: { id: user.id } });
  await prisma.$disconnect();
});
describe("actual agent websocket endpoint personal exposure", () => {
  it.each(["owner", "other", "anonymous", "api-only"])(
    "preserves ordinary chats but only owner session gets personal identity: %s",
    async (mode) => {
      Layer.mockImplementation(() => ({
        workspaceServerConfigs: async () => [],
        mcpServerConfigs: [
          { name: "legacy", server: { url: "https://legacy.example/mcp" } },
          { name: "personal", server: { anythingllm: { perUserAuth: true } } },
        ],
      }));
      const handler = {
        invocation: { uuid: "known", user_id: a.id, workspace },
        init: jest.fn(),
        createAIbitat: jest.fn().mockResolvedValue(),
        startAgentCluster: jest.fn().mockResolvedValue(),
      };
      const legacyTool = jest.fn();
      jest
        .spyOn(WorkspaceAgentInvocation, "getWithWorkspace")
        .mockResolvedValue(handler.invocation);
      const personalTool = jest.fn();
      handler.startAgentCluster.mockImplementation(async () => {
        legacyTool();
        if (handler.invocation.mcpCaller) {
          await caller.assert(handler.invocation.mcpCaller, workspace);
          personalTool();
        }
      });
      handler.init.mockResolvedValue(handler);
      AgentHandler.mockImplementation(() => handler);
      let route;
      agentWebsocket({ ws: (_path, fn) => (route = fn) });
      const socket = new EventEmitter();
      socket.close = jest.fn();
      socket.send = jest.fn();
      socket.OPEN = 1;
      socket.readyState = 1;
      const headers = {};
      if (["owner", "other"].includes(mode))
        headers["sec-websocket-protocol"] =
          "anythingllm-agent, anythingllm-session." +
          JWT.sign(
            { id: mode === "owner" ? a.id : b.id },
            process.env.JWT_SECRET
          );
      if (mode === "api-only") headers.authorization = "Bearer fixture-api-key";
      await route(socket, { params: { uuid: "known" }, headers });
      expect(handler.startAgentCluster).toHaveBeenCalledTimes(1);
      expect(legacyTool).toHaveBeenCalledTimes(1);
      expect(personalTool).toHaveBeenCalledTimes(mode === "owner" ? 1 : 0);
      expect(socket.close).not.toHaveBeenCalled();
      if (mode === "owner")
        expect(
          await caller.assert(handler.invocation.mcpCaller, workspace)
        ).toBe(a.id);
      else {
        expect(handler.invocation.mcpCaller).toBeNull();
        await expect(
          caller.assert(handler.invocation.mcpCaller, workspace)
        ).rejects.toThrow("personal_auth_required");
      }
    }
  );
});
