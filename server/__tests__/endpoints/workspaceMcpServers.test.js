/* global jest */
require("../utils/lark/_polyfill");
const { describe, beforeEach, it, expect } = require("@jest/globals");
jest.mock("../../models/workspace", () => ({ Workspace: { get: jest.fn() } }));
jest.mock("../../models/workspaceMcpServer", () => ({
  WorkspaceMcpServer: {
    create: jest.fn(),
    find: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("../../models/workspaceMcpConnection", () => ({
  WorkspaceMcpConnection: { find: jest.fn(), isAllowed: jest.fn() },
}));
jest.mock("../../utils/MCP", () => jest.fn());
jest.mock("../../models/systemSettings");
const { Workspace } = require("../../models/workspace");
const { WorkspaceMcpServer } = require("../../models/workspaceMcpServer");
const {
  WorkspaceMcpConnection,
} = require("../../models/workspaceMcpConnection");
const { SystemSettings } = require("../../models/systemSettings");
const MCP = require("../../utils/MCP");
const { MASKED_SECRET } = require("../../utils/MCP/serverConfig");
const {
  workspaceMcpServersEndpoints,
} = require("../../endpoints/workspaceMcpServers");
const root = "/workspace/:slug/mcp-servers";
const config = {
  url: "https://mcp.example.com/mcp",
  type: "http",
  headers: {
    Authorization: "Bearer private-secret",
    Accept: "application/json",
  },
};
let routes, mcp;
async function invoke(
  method,
  path = root,
  body,
  { role = "admin", slug = "legal", name = "erp" } = {}
) {
  const route = routes[`${method} ${path}`];
  const response = {
    locals: { user: { id: 8, role } },
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    sendStatus(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    end() {
      return this;
    },
  };
  const request = { params: { slug, name }, body, headers: {} };
  let allowed = false;
  await route.middlewares[1](request, response, () => {
    allowed = true;
  });
  if (allowed) await route.handler(request, response);
  return response;
}
describe("workspace MCP server endpoints", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    Workspace.get.mockResolvedValue({ id: 5, slug: "legal" });
    WorkspaceMcpServer.find.mockResolvedValue(null);
    WorkspaceMcpServer.create.mockResolvedValue({
      config: "encrypted-row-secret",
    });
    WorkspaceMcpServer.update.mockResolvedValue({
      config: "encrypted-row-secret",
    });
    WorkspaceMcpConnection.find.mockResolvedValue({
      enabled: true,
      access_token: "token-secret",
      refresh_token: "refresh-secret",
      expires_at: null,
    });
    WorkspaceMcpConnection.isAllowed.mockResolvedValue(true);
    mcp = {
      mcpServerConfigs: [{ name: "shared", server: config }],
      workspaceServerConfigs: jest
        .fn()
        .mockResolvedValue([
          { name: "erp", server: config, owner: "workspace" },
        ]),
      findServerConfig: jest
        .fn()
        .mockResolvedValue({ name: "erp", server: config, owner: "workspace" }),
      stopWorkspaceServer: jest.fn(),
      probeServerConfig: jest.fn().mockResolvedValue({
        tools: [
          {
            name: "lookup",
            description: "Find",
            inputSchema: {},
            extra: "omit",
          },
        ],
        latencyMs: 4,
      }),
      callServerTool: jest
        .fn()
        .mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
    };
    MCP.mockImplementation(() => mcp);
    MCP.returnMCPResult = jest.fn((result) =>
      typeof result === "string" ? result : JSON.stringify(result)
    );
    routes = {};
    const app = Object.fromEntries(
      ["get", "post", "put", "delete"].map((method) => [
        method,
        (path, middlewares, handler) => {
          routes[`${method} ${path}`] = { middlewares, handler };
        },
      ])
    );
    workspaceMcpServersEndpoints(app);
  });
  it("retains session validation on every route", () => {
    const {
      validatedRequest,
    } = require("../../utils/middleware/validatedRequest");
    for (const route of Object.values(routes))
      expect(route.middlewares[0]).toBe(validatedRequest);
  });
  it("lists masked owned and global configs without encrypted rows or tokens", async () => {
    const response = await invoke("get");
    expect(response.statusCode).toBe(200);
    expect(
      response.body.servers.map(({ name, owner }) => ({ name, owner }))
    ).toEqual([
      { name: "erp", owner: "workspace" },
      { name: "shared", owner: "global" },
    ]);
    expect(response.body.servers[0]).toMatchObject({
      config: { headers: { Authorization: MASKED_SECRET } },
      enabled: true,
      connected: true,
      needsReauth: false,
      expiresAt: null,
    });
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });
  it("shadows global names with owned configs", async () => {
    mcp.mcpServerConfigs.push({
      name: "erp",
      server: { url: "https://other.example.com" },
    });
    expect((await invoke("get")).body.servers).toHaveLength(2);
  });
  it("limits manager list to membership and anythingllm", async () => {
    const response = await invoke("get", root, undefined, { role: "manager" });
    expect(Workspace.get).toHaveBeenCalledWith({
      slug: "legal",
      workspace_users: { some: { user_id: 8 } },
    });
    expect(response.body.servers[0].config).toEqual({ anythingllm: null });
    Workspace.get.mockResolvedValue(null);
    expect(
      (await invoke("get", root, undefined, { role: "manager" })).statusCode
    ).toBe(404);
  });
  it("creates form config without returning encrypted row", async () => {
    const response = await invoke("post", root, { name: "fresh", config });
    expect(response.statusCode).toBe(201);
    expect(response.body).toEqual({ created: ["fresh"], errors: [] });
    expect(WorkspaceMcpServer.create).toHaveBeenCalledWith(5, "fresh", config);
  });
  it("creates valid batch entries and reports separate errors", async () => {
    const response = await invoke("post", root, {
      mcpServers: { fresh: config, bad: { command: "node" } },
    });
    expect(response.statusCode).toBe(201);
    expect(response.body).toEqual({
      created: ["fresh"],
      errors: [{ name: "bad", error: "stdio_not_supported" }],
    });
  });
  it.each([
    [{ command: "node" }, "stdio_not_supported"],
    [{ ...config, unexpected: true }, "unknown_field"],
    [{ ...config, url: "http://127.0.0.1" }, "invalid_url"],
  ])("rejects invalid create config %p", async (value, error) => {
    const response = await invoke("post", root, {
      name: "fresh",
      config: value,
    });
    expect(response.statusCode).toBe(400);
    expect(response.body.errors[0].error).toBe(error);
    expect(WorkspaceMcpServer.create).not.toHaveBeenCalled();
  });
  it.each(["global", "owned"])("rejects %s name conflict", async (owner) => {
    if (owner === "owned")
      WorkspaceMcpServer.find.mockResolvedValue({ config });
    const response = await invoke("post", root, {
      name: owner === "global" ? "shared" : "erp",
      config,
    });
    expect(response.statusCode).toBe(409);
    expect(response.body.errors[0].error).toBe("name_conflict");
    expect(WorkspaceMcpServer.create).not.toHaveBeenCalled();
  });
  it("merges sentinel and stops updated owned client without forwarding ciphertext", async () => {
    WorkspaceMcpServer.find.mockResolvedValue({ config });
    const incoming = { ...config, headers: { Authorization: MASKED_SECRET } };
    const response = await invoke("put", `${root}/:name`, { config: incoming });
    expect(response.statusCode).toBe(200);
    expect(WorkspaceMcpServer.update).toHaveBeenCalledWith(5, "erp", {
      ...config,
      headers: { Authorization: config.headers.Authorization },
    });
    expect(mcp.stopWorkspaceServer).toHaveBeenCalledWith(5, "erp");
    expect(response.body.server).toEqual({
      name: "erp",
      owner: "workspace",
      config: incoming,
    });
  });
  it("stops before deleting owned server", async () => {
    WorkspaceMcpServer.find.mockResolvedValue({ config });
    expect((await invoke("delete", `${root}/:name`)).body).toEqual({
      success: true,
    });
    expect(mcp.stopWorkspaceServer).toHaveBeenCalledWith(5, "erp");
    expect(WorkspaceMcpServer.delete).toHaveBeenCalledWith(5, "erp");
    expect(mcp.stopWorkspaceServer.mock.invocationCallOrder[0]).toBeLessThan(
      WorkspaceMcpServer.delete.mock.invocationCallOrder[0]
    );
  });
  it.each(["put", "delete"])(
    "cannot %s global or other workspace server",
    async (method) => {
      expect(
        (await invoke(method, `${root}/:name`, { config })).statusCode
      ).toBe(404);
      expect(WorkspaceMcpServer.update).not.toHaveBeenCalled();
      expect(WorkspaceMcpServer.delete).not.toHaveBeenCalled();
    }
  );
  it("probes draft without saving and projects tool metadata", async () => {
    const response = await invoke("post", `${root}/test`, { config });
    expect(response.body).toEqual({
      success: true,
      tools: [{ name: "lookup", description: "Find", inputSchema: {} }],
      latencyMs: 4,
    });
    expect(mcp.probeServerConfig).toHaveBeenCalledWith(config, {});
    expect(WorkspaceMcpServer.create).not.toHaveBeenCalled();
  });
  it("rejects private draft URL before probe", async () => {
    const response = await invoke("post", `${root}/test`, {
      config: { url: "http://127.0.0.1/mcp" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body.error).toBe("invalid_url");
    expect(mcp.probeServerConfig).not.toHaveBeenCalled();
  });
  it.each(["workspace", "global"])(
    "probes saved %s OAuth with workspace token",
    async (owner) => {
      const oauth = { ...config, anythingllm: { perWorkspaceAuth: true } };
      mcp.findServerConfig.mockResolvedValue({ server: oauth, owner });
      expect(
        (await invoke("post", `${root}/test`, { name: "erp" })).statusCode
      ).toBe(200);
      expect(mcp.probeServerConfig).toHaveBeenCalledWith(oauth, {
        accessToken: "token-secret",
      });
      WorkspaceMcpConnection.find.mockResolvedValue(null);
      expect(
        (await invoke("post", `${root}/test`, { name: "erp" })).body.error
      ).toBe("not_connected");
    }
  );
  it.each([
    ["MCP probe timeout", "probe_timeout"],
    ["Authorization: Bearer private-secret", "probe_failed"],
  ])("maps probe errors safely", async (message, error) => {
    mcp.probeServerConfig.mockRejectedValue(new Error(message));
    expect((await invoke("post", `${root}/test`, { config })).body).toEqual({
      success: false,
      error,
    });
  });
  it("calls selected server with validated tool request", async () => {
    const response = await invoke("post", `${root}/:name/call`, {
      toolName: "lookup",
      arguments: { id: 1 },
    });
    expect(response.body).toEqual({
      success: true,
      result: '{"content":[{"type":"text","text":"ok"}]}',
      latencyMs: expect.any(Number),
      truncated: false,
    });
    expect(mcp.callServerTool).toHaveBeenCalledWith(
      { id: 5, slug: "legal" },
      "erp",
      { name: "lookup", arguments: { id: 1 } }
    );
  });
  it("truncates UTF-8 result within 64 KB without split codepoints", async () => {
    mcp.callServerTool.mockResolvedValue("€".repeat(30000));
    const { body } = await invoke("post", `${root}/:name/call`, {
      toolName: "lookup",
      arguments: {},
    });
    expect(body.truncated).toBe(true);
    expect(Buffer.byteLength(body.result)).toBeLessThanOrEqual(65536);
    expect(body.result).not.toContain("�");
  });
  it("honors configured call result byte limit", async () => {
    process.env.MCP_CALL_RESULT_MAX_BYTES = "5";
    try {
      mcp.callServerTool.mockResolvedValue("€€");
      const { body } = await invoke("post", `${root}/:name/call`, {
        toolName: "lookup",
        arguments: {},
      });
      expect(body.result).toBe("€");
      expect(body.truncated).toBe(true);
    } finally {
      delete process.env.MCP_CALL_RESULT_MAX_BYTES;
    }
  });
  it("rejects call to other workspace server before execution", async () => {
    mcp.findServerConfig.mockResolvedValue(null);
    expect(
      (
        await invoke("post", `${root}/:name/call`, {
          toolName: "lookup",
          arguments: {},
        })
      ).statusCode
    ).toBe(404);
    expect(mcp.callServerTool).not.toHaveBeenCalled();
  });
  it("rejects disabled server and sanitizes SDK failure", async () => {
    WorkspaceMcpConnection.isAllowed.mockResolvedValue(false);
    expect(
      (
        await invoke("post", `${root}/:name/call`, {
          toolName: "lookup",
          arguments: {},
        })
      ).body.error
    ).toBe("not_enabled");
    expect(mcp.callServerTool).not.toHaveBeenCalled();
    WorkspaceMcpConnection.isAllowed.mockResolvedValue(true);
    mcp.callServerTool.mockRejectedValue(
      new Error("Authorization: Bearer private-secret")
    );
    expect(
      (
        await invoke("post", `${root}/:name/call`, {
          toolName: "lookup",
          arguments: {},
        })
      ).body
    ).toEqual({ success: false, error: "call_failed" });
  });
  it.each([
    { toolName: "", arguments: {} },
    { toolName: "lookup", arguments: [] },
    { toolName: 4, arguments: {} },
    { toolName: "lookup" },
  ])("rejects malformed call %p", async (body) => {
    expect((await invoke("post", `${root}/:name/call`, body)).statusCode).toBe(
      400
    );
    expect(mcp.callServerTool).not.toHaveBeenCalled();
  });
  it("shares busy guard between saved test and call, releases after failure", async () => {
    let reject;
    mcp.probeServerConfig.mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        })
    );
    const pending = invoke("post", `${root}/test`, { name: "erp" });
    while (!reject) await Promise.resolve();
    expect(
      (
        await invoke("post", `${root}/:name/call`, {
          toolName: "lookup",
          arguments: {},
        })
      ).body.error
    ).toBe("busy");
    reject(new Error("secret"));
    await pending;
    expect(
      (
        await invoke("post", `${root}/:name/call`, {
          toolName: "lookup",
          arguments: {},
        })
      ).statusCode
    ).toBe(200);
  });
  it.each([
    ["post", root],
    ["put", `${root}/:name`],
    ["delete", `${root}/:name`],
    ["post", `${root}/test`],
    ["post", `${root}/:name/call`],
  ])("rejects manager mutation %s %s", async (method, path) => {
    expect(
      (await invoke(method, path, { config }, { role: "manager" })).statusCode
    ).toBe(401);
    expect(Workspace.get).not.toHaveBeenCalled();
  });
  it.each(["", [], null])("rejects invalid slug %p", async (slug) => {
    expect((await invoke("get", root, undefined, { slug })).statusCode).toBe(
      400
    );
    expect(Workspace.get).not.toHaveBeenCalled();
  });
  it.each(["UPPER", "a", "bad/name"])(
    "rejects invalid name %s",
    async (name) => {
      expect(
        (await invoke("delete", `${root}/:name`, undefined, { name }))
          .statusCode
      ).toBe(400);
      expect(WorkspaceMcpServer.find).not.toHaveBeenCalled();
    }
  );
});
