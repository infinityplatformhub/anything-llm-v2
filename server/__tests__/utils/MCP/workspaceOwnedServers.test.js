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
jest.mock("../../../models/workspaceMcpServer", () => ({
  WorkspaceMcpServer: { find: jest.fn(), listDecrypted: jest.fn() },
}));
jest.mock("../../../models/workspaceMcpConnection", () => ({
  WorkspaceMcpConnection: {
    find: jest.fn(),
    list: jest.fn(),
    isAllowed: jest.fn(),
    saveTokens: jest.fn(),
  },
}));
jest.mock("../../../models/systemSettings", () => ({ SystemSettings: {} }));
jest.mock("../../../utils/MCP/oauth", () => ({
  ...jest.requireActual("../../../utils/MCP/oauth"),
  refreshTokens: jest.fn(),
}));
jest.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: jest.fn(),
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
  SSEClientTransport,
} = require("@modelcontextprotocol/sdk/client/sse.js");
const {
  WorkspaceMcpServer: Server,
} = require("../../../models/workspaceMcpServer");
const {
  WorkspaceMcpConnection: Connection,
} = require("../../../models/workspaceMcpConnection");
const { refreshTokens } = require("../../../utils/MCP/oauth");
const workspace = { id: 7 };
let layer, configs, owned, connection, client, log, warn;
const tools = [
  {
    name: "read",
    description: "Read company",
    inputSchema: { type: "object" },
  },
];
function aibitat(ws = workspace) {
  return {
    handlerProps: { invocation: { workspace: ws }, log: jest.fn() },
    introspect: jest.fn(),
    function: jest.fn(),
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  Hypervisor._instance = undefined;
  Layer._instance = undefined;
  log = jest.spyOn(console, "log").mockImplementation(() => {});
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(fs, "existsSync").mockReturnValue(true);
  configs = [];
  owned = [
    {
      name: "erp",
      config: {
        type: "http",
        url: "https://mcp.example/mcp",
        headers: { Authorization: "Bearer secret-config" },
      },
    },
  ];
  connection = { enabled: true, server_name: "erp" };
  Server.listDecrypted.mockImplementation(async (id) =>
    id === 7 ? owned : []
  );
  Server.find.mockImplementation(async (id, name) =>
    id === 7 ? owned.find((row) => row.name === name) || null : null
  );
  Connection.find.mockImplementation(async () => connection);
  Connection.list.mockImplementation(async () => [connection]);
  Connection.isAllowed.mockResolvedValue(true);
  Client.mockImplementation(() => {
    client = {
      connect: jest.fn().mockResolvedValue(),
      close: jest.fn().mockResolvedValue(),
      listTools: jest.fn().mockResolvedValue({ tools }),
      callTool: jest.fn().mockResolvedValue({ content: [] }),
    };
    return client;
  });
  layer = new Layer();
  Object.defineProperty(layer, "mcpServerConfigs", { get: () => configs });
});
afterEach(() => {
  expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls])).not.toContain(
    "secret-config"
  );
  jest.useRealTimers();
  jest.restoreAllMocks();
});
describe("workspace-owned MCP runtime", () => {
  it("lists decrypted configs with ownership", async () => {
    expect(await layer.workspaceServerConfigs(7)).toEqual([
      { name: "erp", server: owned[0].config, owner: "workspace" },
    ]);
  });
  it("boots non-OAuth with saved headers under workspace key only", async () => {
    expect(await layer.activeMCPServers(workspace)).toEqual(["@@mcp_erp"]);
    expect(Object.keys(layer.mcps)).toEqual(["7:erp"]);
    expect(Transport.mock.calls[0][1].requestInit.headers).toEqual(
      owned[0].config.headers
    );
    expect(refreshTokens).not.toHaveBeenCalled();
  });
  it("requires enabled even without OAuth", async () => {
    connection.enabled = false;
    expect(await layer.activeMCPServers(workspace)).toEqual([]);
    await expect(layer.bootWorkspaceServer(workspace, "erp")).rejects.toThrow(
      "not enabled for this workspace"
    );
    expect(Client).not.toHaveBeenCalled();
  });
  it("shadows global only in owning workspace and warns once", async () => {
    configs = [
      {
        name: "erp",
        server: { type: "http", url: "https://shared.example/mcp" },
      },
    ];
    expect((await layer.findServerConfig("erp", workspace)).owner).toBe(
      "workspace"
    );
    await layer.findServerConfig("erp", workspace);
    expect(await layer.findServerConfig("erp", { id: 8 })).toEqual({
      ...configs[0],
      owner: "global",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await layer.activeMCPServers(workspace)).toEqual(["@@mcp_erp"]);
    expect(layer.mcps["7:erp"]).toBeDefined();
  });
  it("unknown or invalid workspace resolves global only", async () => {
    expect(await layer.findServerConfig("erp", { id: -1 })).toBeNull();
    expect(Server.find).not.toHaveBeenCalled();
    expect(await layer.activeMCPServers({ id: 8 })).toEqual([]);
    expect(Client).not.toHaveBeenCalled();
  });
  it("stops old client after update and reboots updated headers", async () => {
    const first = await layer.bootWorkspaceServer(workspace, "erp");
    owned[0].config.headers.Authorization = "Bearer changed";
    await layer.stopWorkspaceServer(7, "erp");
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(layer.mcps["7:erp"]).toBeUndefined();
    const next = await layer.bootWorkspaceServer(workspace, "erp");
    expect(next).not.toBe(first);
    expect(Transport.mock.calls[1][1].requestInit.headers.Authorization).toBe(
      "Bearer changed"
    );
  });
  it("reuses matching client but reconnects when config fingerprint changes", async () => {
    const first = await layer.bootWorkspaceServer(workspace, "erp");
    expect(await layer.bootWorkspaceServer(workspace, "erp")).toBe(first);
    owned[0].config.url = "https://mcp.example/changed";
    expect(await layer.bootWorkspaceServer(workspace, "erp")).not.toBe(first);
    expect(first.close).toHaveBeenCalledTimes(1);
  });
  it("deduplicates simultaneous workspace boots", async () => {
    const [first, second] = await Promise.all([
      layer.bootWorkspaceServer(workspace, "erp"),
      layer.bootWorkspaceServer(workspace, "erp"),
    ]);
    expect(first).toBe(second);
    expect(Client).toHaveBeenCalledTimes(1);
  });
  it("requires tokens for workspace-owned OAuth", async () => {
    owned[0].config.anythingllm = { perWorkspaceAuth: true };
    expect(await layer.activeMCPServers(workspace)).toEqual([]);
    connection.access_token = "oauth-access";
    connection.refresh_token = "oauth-refresh";
    expect(await layer.activeMCPServers(workspace)).toEqual(["@@mcp_erp"]);
    expect(Transport.mock.calls[0][1].requestInit.headers.authorization).toBe(
      "Bearer oauth-access"
    );
  });
  it("resolves scoped plugins and handler with workspace suppression", async () => {
    owned[0].config.anythingllm = { suppressedTools: ["hidden"] };
    await layer.activeMCPServers(workspace);
    client.listTools.mockResolvedValue({
      tools: [...tools, { name: "hidden" }],
    });
    const resolve = jest.spyOn(layer, "findServerConfig");
    const ai = aibitat();
    const plugins = await layer.convertServerToolsToPlugins("erp", ai);
    expect(plugins.map((p) => p.name)).toEqual(["erp-read"]);
    plugins[0].plugin().setup(ai);
    const handler = ai.function.mock.calls[0][0].handler;
    const call = jest.spyOn(layer, "callWorkspaceTool");
    await handler({ query: "company" });
    expect(resolve).toHaveBeenCalledWith("erp", workspace);
    expect(call).toHaveBeenCalledWith(workspace, "erp", {
      name: "read",
      arguments: { query: "company" },
    });
    ai.handlerProps.invocation.workspace = { id: 8 };
    expect(await handler({})).toMatch(/not enabled for this workspace/);
    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(
      await layer.convertServerToolsToPlugins("erp", aibitat({ id: 8 }))
    ).toBeNull();
  });
  it("rejects invalid stored configs before workspace transport construction", async () => {
    owned[0].config.url = "http://127.0.0.1/private";
    await expect(layer.bootWorkspaceServer(workspace, "erp")).rejects.toThrow(
      "invalid_url"
    );
    expect(Client).not.toHaveBeenCalled();
  });
  it("keeps non-OAuth connect timeout at 30 seconds and cleans up", async () => {
    jest.useFakeTimers();
    Client.mockImplementationOnce(() => {
      client = {
        connect: jest.fn(() => new Promise(() => {})),
        close: jest.fn().mockResolvedValue(),
      };
      return client;
    });
    const result = expect(
      layer.bootWorkspaceServer(workspace, "erp")
    ).rejects.toThrow("MCP connection failed");
    await jest.advanceTimersByTimeAsync(29999);
    expect(client.close).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await result;
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(layer.mcps).toEqual({});
    expect(layer.workspaceBoots.size).toBe(0);
  });
  it("non-OAuth call 401 stays sanitized without refresh", async () => {
    await layer.bootWorkspaceServer(workspace, "erp");
    client.callTool.mockRejectedValue({
      status: 401,
      message: "secret-config",
    });
    await expect(layer.callWorkspaceTool(workspace, "erp", {})).rejects.toThrow(
      "MCP tool call failed"
    );
    expect(refreshTokens).not.toHaveBeenCalled();
    expect(Connection.saveTokens).not.toHaveBeenCalled();
  });
});
describe("workspace-gated server tool calls", () => {
  const request = { name: "read", arguments: {} };
  it("boots missing global client and reuses shared instance", async () => {
    configs = [
      {
        name: "shared",
        server: { type: "http", url: "https://shared.example/mcp" },
      },
    ];
    expect(await layer.callServerTool(workspace, "shared", request)).toEqual({
      content: [],
    });
    expect(Connection.isAllowed).toHaveBeenCalledWith(7, "shared");
    const first = layer.mcps.shared;
    await layer.callServerTool(workspace, "shared", request);
    expect(layer.mcps.shared).toBe(first);
    expect(Object.keys(layer.mcps)).toEqual(["shared"]);
    expect(first.callTool).toHaveBeenCalledTimes(2);
    expect(Client).toHaveBeenCalledTimes(1);
  });
  it("denies global calls before boot when allowlist blocks", async () => {
    configs = [
      {
        name: "shared",
        server: { type: "http", url: "https://shared.example/mcp" },
      },
    ];
    Connection.isAllowed.mockResolvedValue(false);
    await expect(
      layer.callServerTool(workspace, "shared", request)
    ).rejects.toThrow("not enabled for this workspace");
    expect(Client).not.toHaveBeenCalled();
  });
  it("routes owned and OAuth configs to scoped call helper", async () => {
    const scoped = jest
      .spyOn(layer, "callWorkspaceTool")
      .mockResolvedValue({ content: [] });
    await layer.callServerTool(workspace, "erp", request);
    expect(scoped).toHaveBeenCalledWith(workspace, "erp", request);
    configs = [
      {
        name: "oauth",
        server: {
          url: "https://shared.example/mcp",
          anythingllm: { perWorkspaceAuth: true },
        },
      },
    ];
    await layer.callServerTool(workspace, "oauth", request);
    expect(scoped).toHaveBeenCalledWith(workspace, "oauth", request);
  });
  it("denies invalid workspace and unknown config", async () => {
    await expect(
      layer.callServerTool({ id: -1 }, "erp", request)
    ).rejects.toThrow("not enabled for this workspace");
    await expect(
      layer.callServerTool({ id: 8 }, "erp", request)
    ).rejects.toThrow("not enabled for this workspace");
    expect(Client).not.toHaveBeenCalled();
  });
  it("sanitizes global call failures without token refresh", async () => {
    configs = [{ name: "shared", server: {} }];
    layer.mcps.shared = {
      callTool: jest.fn().mockRejectedValue(new Error("secret-config")),
    };
    await expect(
      layer.callServerTool(workspace, "shared", request)
    ).rejects.toThrow("MCP tool call failed");
    expect(refreshTokens).not.toHaveBeenCalled();
  });
});
describe("temporary MCP probes", () => {
  it("returns tools and latency, closes client, preserves runtime registry", async () => {
    const result = await layer.probeServerConfig(owned[0].config);
    expect(result).toEqual({ tools, latencyMs: expect.any(Number) });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Transport.mock.calls[0][1].requestInit.headers).toEqual(
      owned[0].config.headers
    );
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(layer.mcps).toEqual({});
  });
  it("injects supplied OAuth access token and supports default SSE", async () => {
    const config = { ...owned[0].config };
    delete config.type;
    await layer.probeServerConfig(config, { accessToken: "probe-token" });
    expect(
      SSEClientTransport.mock.calls[0][1].requestInit.headers.authorization
    ).toBe("Bearer probe-token");
  });
  it.each(["connect", "listTools"])(
    "closes and sanitizes %s failure",
    async (method) => {
      Client.mockImplementationOnce(() => {
        client = {
          connect: jest.fn().mockResolvedValue(),
          listTools: jest.fn().mockResolvedValue({ tools }),
          close: jest.fn().mockResolvedValue(),
        };
        client[method].mockRejectedValue(new Error("secret-config"));
        return client;
      });
      await expect(layer.probeServerConfig(owned[0].config)).rejects.toThrow(
        "MCP probe failed"
      );
      expect(client.close).toHaveBeenCalledTimes(1);
      expect(layer.mcps).toEqual({});
    }
  );
  it.each(["connect", "listTools"])(
    "preserves sanitized %s error when cleanup also rejects",
    async (method) => {
      Client.mockImplementationOnce(() => {
        client = {
          connect: jest.fn().mockResolvedValue(),
          listTools: jest.fn().mockResolvedValue({ tools }),
          close: jest.fn().mockRejectedValue(new Error("secret-config")),
        };
        client[method].mockRejectedValue(new Error("secret-config"));
        return client;
      });
      await expect(layer.probeServerConfig(owned[0].config)).rejects.toThrow(
        /^MCP probe failed$/
      );
      expect(client.close).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls).toEqual([["MCP_PROBE_CLEANUP_FAILED"]]);
    }
  );
  it("preserves timeout error when cleanup also rejects", async () => {
    jest.useFakeTimers();
    Client.mockImplementationOnce(() => {
      client = {
        connect: jest.fn(() => new Promise(() => {})),
        close: jest.fn().mockRejectedValue(new Error("secret-config")),
      };
      return client;
    });
    const pending = expect(
      layer.probeServerConfig(owned[0].config)
    ).rejects.toThrow(/^MCP probe timeout$/);
    await jest.advanceTimersByTimeAsync(15000);
    await pending;
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls).toEqual([["MCP_PROBE_CLEANUP_FAILED"]]);
    expect(jest.getTimerCount()).toBe(0);
  });
  it.each(["connect", "listTools"])(
    "times out hung %s after default 15 seconds and closes",
    async (method) => {
      jest.useFakeTimers();
      Client.mockImplementationOnce(() => {
        client = {
          connect: jest.fn().mockResolvedValue(),
          listTools: jest.fn().mockResolvedValue({ tools }),
          close: jest.fn().mockResolvedValue(),
        };
        client[method].mockReturnValue(new Promise(() => {}));
        return client;
      });
      const pending = expect(
        layer.probeServerConfig(owned[0].config)
      ).rejects.toThrow("MCP probe timeout");
      await jest.advanceTimersByTimeAsync(14999);
      expect(client.close).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await pending;
      expect(client.close).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    }
  );
  it("honors environment probe timeout and restores it", async () => {
    const previous = process.env.MCP_PROBE_TIMEOUT_MS;
    process.env.MCP_PROBE_TIMEOUT_MS = "75";
    jest.useFakeTimers();
    Client.mockImplementationOnce(() => ({
      connect: jest.fn(() => new Promise(() => {})),
      close: jest.fn().mockResolvedValue(),
    }));
    try {
      const result = expect(
        layer.probeServerConfig(owned[0].config)
      ).rejects.toThrow("MCP probe timeout");
      await jest.advanceTimersByTimeAsync(75);
      await result;
    } finally {
      if (previous === undefined) delete process.env.MCP_PROBE_TIMEOUT_MS;
      else process.env.MCP_PROBE_TIMEOUT_MS = previous;
    }
  });
  it("sanitizes transport construction and close failures", async () => {
    jest.spyOn(layer, "createHttpTransport").mockImplementationOnce(() => {
      throw new Error("secret-config");
    });
    await expect(layer.probeServerConfig(owned[0].config)).rejects.toThrow(
      "MCP probe failed"
    );
    expect(client.close).toHaveBeenCalledTimes(1);
    Client.mockImplementationOnce(() => ({
      connect: jest.fn().mockResolvedValue(),
      listTools: jest.fn().mockResolvedValue({ tools }),
      close: jest.fn().mockRejectedValue(new Error("secret-config")),
    }));
    await expect(layer.probeServerConfig(owned[0].config)).rejects.toThrow(
      "MCP probe cleanup failed"
    );
  });
  it("honors explicit timeout", async () => {
    jest.useFakeTimers();
    Client.mockImplementationOnce(() => ({
      connect: jest.fn(() => new Promise(() => {})),
      close: jest.fn().mockResolvedValue(),
    }));
    const result = expect(
      layer.probeServerConfig(owned[0].config, { timeoutMs: 50 })
    ).rejects.toThrow("MCP probe timeout");
    await jest.advanceTimersByTimeAsync(50);
    await result;
  });
  it.each([
    { url: "http://127.0.0.1/private" },
    { command: "node" },
    { url: "https://mcp.example", headers: { Authorization: 1 } },
  ])(
    "rejects unvalidated config before transport creation: %j",
    async (config) => {
      await expect(layer.probeServerConfig(config)).rejects.toThrow();
      expect(Client).not.toHaveBeenCalled();
      expect(Transport).not.toHaveBeenCalled();
    }
  );
});
