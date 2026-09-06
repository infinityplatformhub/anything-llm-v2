/* global jest */
const {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} = require("@jest/globals");

jest.mock("../../../utils/http", () => ({ safeJsonParse: JSON.parse }));
jest.mock("../../../utils/helpers/shell", () => ({
  patchShellEnvironmentPath: jest.fn(),
}));
jest.mock("../../../models/workspaceMcpConnection", () => ({
  WorkspaceMcpConnection: {
    find: jest.fn(),
    list: jest.fn(),
    saveTokens: jest.fn(),
    isAllowed: jest.fn(),
  },
}));
jest.mock("../../../utils/MCP/oauth", () => ({ refreshTokens: jest.fn() }));
jest.mock("../../../models/systemSettings", () => ({ SystemSettings: {} }));
jest.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    listTools: jest
      .fn()
      .mockResolvedValue({ tools: [{ name: "read", inputSchema: {} }] }),
    callTool: jest.fn().mockResolvedValue({ content: [] }),
  })),
}));
for (const [path, name] of [
  ["stdio", "StdioClientTransport"],
  ["sse", "SSEClientTransport"],
  ["streamableHttp", "StreamableHTTPClientTransport"],
]) {
  jest.doMock(`@modelcontextprotocol/sdk/client/${path}.js`, () => ({
    [name]: jest.fn().mockImplementation(() => ({ close: jest.fn() })),
  }));
}
const fs = require("fs");
const Hypervisor = require("../../../utils/MCP/hypervisor");
const Layer = require("../../../utils/MCP");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport: Transport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const {
  WorkspaceMcpConnection: Connection,
} = require("../../../models/workspaceMcpConnection");
const { refreshTokens } = require("../../../utils/MCP/oauth");
const { discover } = jest.requireActual("../../../utils/MCP/oauth");
const workspace = { id: 7 };
let layer, configs, row, log;
beforeEach(() => {
  jest.clearAllMocks();
  Hypervisor._instance = undefined;
  Layer._instance = undefined;
  log = jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(fs, "existsSync").mockReturnValue(true);
  layer = new Layer();
  configs = [
    {
      name: "remote",
      server: {
        type: "http",
        url: "https://mcp.example/mcp",
        anythingllm: { perWorkspaceAuth: true },
      },
    },
  ];
  Object.defineProperty(layer, "mcpServerConfigs", { get: () => configs });
  row = {
    enabled: true,
    server_name: "remote",
    access_token: "secret-access",
    refresh_token: "secret-refresh",
    expires_at: new Date(Date.now() + 3600000),
  };
  Connection.find.mockImplementation(async () => row);
  Connection.list.mockImplementation(async () => [row]);
  Connection.isAllowed.mockResolvedValue(true);
  Connection.saveTokens.mockImplementation(
    async (_id, _name, tokens) => (row = { ...row, ...tokens })
  );
  refreshTokens.mockResolvedValue({
    access_token: "secret-new",
    expires_at: new Date(Date.now() + 3600000),
  });
});
afterEach(() => {
  expect(JSON.stringify(log.mock.calls)).not.toMatch(
    /secret-access|secret-refresh|secret-new/
  );
  jest.restoreAllMocks();
});
describe("OAuth refresh error contract", () => {
  it.each(["invalid_grant", "secret-access", undefined])(
    "exposes status and only whitelisted code: %s",
    async (code) => {
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: code,
          error_description: "secret-refresh",
        }),
      });
      let caught;
      try {
        await discover("https://mcp.example/mcp");
      } catch (error) {
        caught = error;
      }
      expect(caught.message).toBe("oauth_request_failed");
      expect(caught.status).toBe(400);
      expect(caught.code).toBe(code === "invalid_grant" ? code : undefined);
      expect(JSON.stringify(caught)).not.toMatch(
        /secret-access|secret-refresh/
      );
    }
  );
});
describe("workspace MCP runtime", () => {
  it("isolates clients by workspace and injects latest bearer header", async () => {
    await layer.bootWorkspaceServer(workspace, "remote");
    row = { ...row, access_token: "second-workspace" };
    await layer.bootWorkspaceServer({ id: 8 }, "remote");
    expect(Object.keys(layer.mcps)).toEqual(["7:remote", "8:remote"]);
    expect(Transport.mock.calls[0][1].requestInit.headers.authorization).toBe(
      "Bearer secret-access"
    );
    expect(Transport.mock.calls[1][1].requestInit.headers.authorization).toBe(
      "Bearer second-workspace"
    );
  });
  it("refreshes within sixty seconds, saves tokens, and uses fresh header", async () => {
    row.expires_at = new Date(Date.now() + 1000);
    await layer.bootWorkspaceServer(workspace, "remote");
    expect(refreshTokens).toHaveBeenCalledWith(
      "secret-refresh",
      "https://mcp.example/mcp"
    );
    expect(Connection.saveTokens).toHaveBeenCalledWith(
      7,
      "remote",
      expect.objectContaining({ access_token: "secret-new" })
    );
    expect(Transport.mock.calls[0][1].requestInit.headers.authorization).toBe(
      "Bearer secret-new"
    );
  });
  it("marks rejected refresh as reauthentication required without booting", async () => {
    row.expires_at = new Date(0);
    refreshTokens.mockRejectedValueOnce(
      Object.assign(new Error("secret-refresh"), { status: 401 })
    );
    await expect(
      layer.bootWorkspaceServer(workspace, "remote")
    ).rejects.toThrow("MCP authentication required");
    expect(row.refresh_token).toBeNull();
    expect(Client).not.toHaveBeenCalled();
    expect(layer.mcps).toEqual({});
  });
  it("rejects stdio with workspace authentication", async () => {
    configs[0].server = {
      command: "node",
      anythingllm: { perWorkspaceAuth: true },
    };
    await expect(
      layer.bootWorkspaceServer(workspace, "remote")
    ).rejects.toThrow(/remote transport/);
    expect(Client).not.toHaveBeenCalled();
  });
  it("skips workspace servers on global boot and manual global start", async () => {
    await layer.bootMCPServers();
    expect(Client).not.toHaveBeenCalled();
    expect((await layer.startMCPServer("remote")).success).toBe(false);
    expect(Client).not.toHaveBeenCalled();
  });
  it("stops and removes only selected workspace client", async () => {
    await layer.bootWorkspaceServer(workspace, "remote");
    const client = layer.mcps["7:remote"];
    await layer.stopWorkspaceServer(7, "remote");
    expect(client.close).toHaveBeenCalled();
    expect(layer.mcps["7:remote"]).toBeUndefined();
  });
  it("returns stable plugin names and resolves workspace client at call time", async () => {
    expect(await layer.activeMCPServers(workspace)).toEqual(["@@mcp_remote"]);
    const aibitat = {
      handlerProps: { invocation: { workspace }, log: jest.fn() },
      introspect: jest.fn(),
      function: jest.fn(),
    };
    const plugins = await layer.convertServerToolsToPlugins("remote", aibitat);
    plugins[0].plugin().setup(aibitat);
    const handler = aibitat.function.mock.calls[0][0].handler;
    await handler({});
    expect(layer.mcps["7:remote"].callTool).toHaveBeenCalledTimes(1);
    Connection.isAllowed.mockResolvedValue(false);
    expect(await handler({})).toMatch(/not enabled/);
    expect(layer.mcps["7:remote"].callTool).toHaveBeenCalledTimes(1);
  });
  it("rechecks allowlist for already attached global tools", async () => {
    configs[0].server.anythingllm = {};
    layer.mcps.remote = new Client();
    const aibitat = {
      handlerProps: { invocation: { workspace }, log: jest.fn() },
      introspect: jest.fn(),
      function: jest.fn(),
    };
    const plugins = await layer.convertServerToolsToPlugins("remote", aibitat);
    plugins[0].plugin().setup(aibitat);
    Connection.isAllowed.mockResolvedValue(false);
    expect(await aibitat.function.mock.calls[0][0].handler({})).toMatch(
      /not enabled/
    );
    expect(layer.mcps.remote.callTool).not.toHaveBeenCalled();
  });
  it("retains credentials on transient refresh failure", async () => {
    row.expires_at = new Date(0);
    refreshTokens.mockRejectedValueOnce(
      Object.assign(new Error("secret-refresh"), { status: 503 })
    );
    await expect(
      layer.bootWorkspaceServer(workspace, "remote")
    ).rejects.toThrow("MCP token refresh unavailable");
    expect(Connection.saveTokens).not.toHaveBeenCalled();
    expect(Client).not.toHaveBeenCalled();
  });
  it("keeps OAuth catalog visible without leaking scoped process keys", async () => {
    await layer.bootWorkspaceServer(workspace, "remote");
    expect(await layer.servers()).toEqual([
      expect.objectContaining({ name: "remote", running: false, tools: [] }),
    ]);
  });
  it("does not restore credentials cleared during refresh", async () => {
    row.expires_at = new Date(0);
    refreshTokens.mockImplementationOnce(async () => {
      row = { ...row, access_token: null, refresh_token: null };
      return { access_token: "secret-new" };
    });
    await expect(
      layer.bootWorkspaceServer(workspace, "remote")
    ).rejects.toThrow("MCP connection changed during refresh");
    expect(Connection.saveTokens).not.toHaveBeenCalled();
    expect(layer.mcps).toEqual({});
  });
  it("deduplicates concurrent boots", async () => {
    await Promise.all([
      layer.bootWorkspaceServer(workspace, "remote"),
      layer.bootWorkspaceServer(workspace, "remote"),
    ]);
    expect(Client).toHaveBeenCalledTimes(1);
  });
  it("replaces stale singleton token without changing global instances", async () => {
    await layer.bootWorkspaceServer(workspace, "remote");
    const first = layer.mcps["7:remote"];
    row.access_token = "secret-new";
    await layer.bootWorkspaceServer(workspace, "remote");
    expect(first.close).toHaveBeenCalled();
    expect(Transport.mock.calls[1][1].requestInit.headers.authorization).toBe(
      "Bearer secret-new"
    );
    configs.push({
      name: "global",
      server: { type: "http", url: "https://mcp.example/public" },
    });
    await layer.bootMCPServers();
    expect(layer.mcps.global).toBeDefined();
    expect(await layer.activeMCPServers()).toEqual(["@@mcp_global"]);
  });
  it("marks reauth and closes client after second tool 401", async () => {
    await layer.bootWorkspaceServer(workspace, "remote");
    layer.mcps["7:remote"].callTool.mockRejectedValueOnce({ code: 401 });
    const retry = {
      connect: jest.fn().mockResolvedValue(),
      close: jest.fn().mockResolvedValue(),
      callTool: jest.fn().mockRejectedValue({ code: 401 }),
    };
    Client.mockImplementationOnce(() => retry);
    await expect(
      layer.callWorkspaceTool(workspace, "remote", {})
    ).rejects.toThrow("MCP authentication required");
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(retry.callTool).toHaveBeenCalledTimes(1);
    expect(retry.close).toHaveBeenCalled();
    expect(row.refresh_token).toBeNull();
    expect(layer.mcps).toEqual({});
  });
  it("does not refresh twice if reconnect itself returns 401", async () => {
    await layer.bootWorkspaceServer(workspace, "remote");
    layer.mcps["7:remote"].callTool.mockRejectedValueOnce({ code: 401 });
    Client.mockImplementationOnce(() => ({
      connect: jest.fn().mockRejectedValue({ code: 401 }),
      close: jest.fn().mockResolvedValue(),
    }));
    await expect(
      layer.callWorkspaceTool(workspace, "remote", {})
    ).rejects.toThrow("MCP authentication required");
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(row.refresh_token).toBeNull();
  });
  it("refreshes and reconnects once after tool 401", async () => {
    await layer.bootWorkspaceServer(workspace, "remote");
    const first = layer.mcps["7:remote"];
    first.callTool.mockRejectedValueOnce(
      Object.assign(new Error("secret-access"), { code: 401 })
    );
    await layer.callWorkspaceTool(workspace, "remote", {
      name: "read",
      arguments: {},
    });
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalled();
    expect(layer.mcps["7:remote"].callTool).toHaveBeenCalledTimes(1);
  });
});
