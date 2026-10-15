/* global jest */
const {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} = require("@jest/globals");
require("../../utils/lark/_polyfill");
jest.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: jest.fn(() => ({
    connect: jest.fn().mockResolvedValue(),
    close: jest.fn().mockResolvedValue(),
    listTools: jest.fn().mockResolvedValue({
      tools: [
        { name: "read", inputSchema: {} },
        { name: "write", inputSchema: {} },
      ],
    }),
    callTool: jest
      .fn()
      .mockResolvedValue({ content: [{ text: "private-result" }] }),
  })),
}));
for (const [file, name] of [
  ["stdio", "StdioClientTransport"],
  ["sse", "SSEClientTransport"],
  ["streamableHttp", "StreamableHTTPClientTransport"],
])
  jest.doMock(`@modelcontextprotocol/sdk/client/${file}.js`, () => ({
    [name]: jest.fn(() => ({})),
  }));
const fs = require("fs");
const crypto = require("crypto");
const prisma = require("../../../utils/prisma");
const { PersonalMcpGrant: Grant } = require("../../../models/personalMcpGrant");
const caller = require("../../../utils/MCP/personalCaller");
const oauth = require("../../../utils/MCP/oauth");
const Hypervisor = require("../../../utils/MCP/hypervisor");
const Layer = require("../../../utils/MCP");
const { WorkspaceMcpServer } = require("../../../models/workspaceMcpServer");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport: Transport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
let workspace, a, b, ca, cb, layer, config, logs, configuredName;
beforeAll(async () => {
  process.env.SIG_KEY ||= "personal-test-key";
  process.env.SIG_SALT ||= "personal-test-salt";
  workspace = await prisma.workspaces.create({
    data: { name: "Personal runtime", slug: crypto.randomUUID() },
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
  ca = await caller.fromOAuthState(a.id, workspace);
  cb = await caller.fromOAuthState(b.id, workspace);
});
beforeEach(async () => {
  jest.clearAllMocks();
  logs = jest.spyOn(console, "log").mockImplementation(() => {});
  const existsSync = fs.existsSync;
  jest
    .spyOn(fs, "existsSync")
    .mockImplementation((file) =>
      String(file).endsWith("anythingllm_mcp_servers.json")
        ? true
        : existsSync(file)
    );
  Hypervisor._instance = undefined;
  Layer._instance = undefined;
  layer = new Layer();
  configuredName = 'medusa';
  config = {
    url: "https://medusa.example/mcp",
    type: "http",
    anythingllm: { perUserAuth: true, suppressedTools: ["write"] },
  };
  Object.defineProperty(layer, "mcpServerConfigs", {
    get: () => [{ name: configuredName, server: config }],
  });
  jest.spyOn(layer, "workspaceServerConfigs").mockResolvedValue([]);
  jest.spyOn(layer, "findServerConfig").mockImplementation(async () => ({
    name: configuredName,
    server: config,
    owner: "global",
  }));
  await prisma.personal_mcp_grants.deleteMany({
    where: { workspace_id: workspace.id },
  });
  for (const user of [a, b]) {
    const grant = await Grant.begin(workspace.id, user.id, "medusa", config);
    await Grant.save(workspace.id, user.id, "medusa", grant.version, config, {
      access_token: `private-${user.id}`,
      refresh_token: "private-refresh",
      expires_at: new Date(Date.now() + 3600000),
    });
  }
});
afterEach(async () => {
  expect(JSON.stringify(logs.mock.calls)).not.toMatch(/private-/);
  if (layer.personalRuntime) await layer.personalRuntime.stopAll();
  jest.restoreAllMocks();
});
afterAll(async () => {
  await prisma.workspaces.delete({ where: { id: workspace.id } });
  for (const user of [a, b])
    await prisma.users.delete({ where: { id: user.id } });
  await prisma.$disconnect();
});
describe("personal runtime boundary", () => {
  it("global deletion preserves same-name workspace-owned grants and clients", async () => {
    const shadow = await prisma.workspaces.create({
      data: { name: "Shadow", slug: crypto.randomUUID() },
    });
    try {
      await prisma.workspace_users.create({
        data: { workspace_id: shadow.id, user_id: a.id },
      });
      await WorkspaceMcpServer.create(shadow.id, "medusa", config);
      const shadowCaller = await caller.fromOAuthState(a.id, shadow);
      const grant = await Grant.begin(shadow.id, a.id, "medusa", config);
      await Grant.save(shadow.id, a.id, "medusa", grant.version, config, {
        access_token: "private-shadow",
      });
      const client = await layer.bootPersonalServer(
        shadow,
        "medusa",
        shadowCaller
      );
      const invalidate = await layer.invalidateGlobalPersonalServer("medusa");
      expect(invalidate).toBeUndefined();
      expect(
        (await Grant.find(shadow.id, a.id, "medusa", config)).enabled
      ).toBe(true);
      expect(client.close).not.toHaveBeenCalled();
      expect(
        (await Grant.find(workspace.id, a.id, "medusa", config)).enabled
      ).toBe(false);
    } finally {
      await layer.personalRuntime.stop(shadow.id, "medusa");
      await prisma.workspaces.delete({ where: { id: shadow.id } });
    }
  });
  it("never boots personal servers globally or for anonymous jobs", async () => {
    await layer.bootMCPServers();
    expect(Client).not.toHaveBeenCalled();
    expect(await layer.activeMCPServers(workspace)).toEqual([]);
    await expect(
      layer.callServerTool(workspace, "medusa", { name: "read" })
    ).rejects.toThrow("personal_auth_required");
  });
  it("isolates A/B boot locks, bearer headers, clients and discovery", async () => {
    expect(await layer.activeMCPServers(workspace, ca)).toEqual([
      "@@mcp_medusa",
    ]);
    expect(await layer.activeMCPServers(workspace, cb)).toEqual([
      "@@mcp_medusa",
    ]);
    const first = await layer.bootPersonalServer(workspace, "medusa", ca);
    const second = await layer.bootPersonalServer(workspace, "medusa", cb);
    expect(first).not.toBe(second);
    expect(
      Transport.mock.calls.map(
        (call) => call[1].requestInit.headers.authorization
      )
    ).toEqual([`Bearer private-${a.id}`, `Bearer private-${b.id}`]);
    expect(await layer.personalRuntime.tools(workspace, "medusa", ca)).toEqual([
      { name: "read", inputSchema: {} },
    ]);
  });
  it("does not replay mutations after a tool 401 and clears only caller grant", async () => {
    const client = await layer.bootPersonalServer(workspace, "medusa", ca);
    client.callTool.mockRejectedValueOnce({ status: 401 });
    const refresh = jest.spyOn(oauth, "refreshTokens");
    await expect(
      layer.callServerTool(
        workspace,
        "medusa",
        { name: "read", arguments: {} },
        ca
      )
    ).rejects.toThrow("MCP authentication required");
    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(
      (await Grant.find(workspace.id, a.id, "medusa", config)).enabled
    ).toBe(false);
    expect(
      (await Grant.find(workspace.id, b.id, "medusa", config)).enabled
    ).toBe(true);
  });
  it("deduplicates refresh and rejects a refresh racing disconnect/reconnect", async () => {
    const old = await Grant.find(workspace.id, a.id, "medusa", config);
    await Grant.save(workspace.id, a.id, "medusa", old.version, config, {
      access_token: "private-old",
      refresh_token: "private-refresh",
      expires_at: new Date(0),
    });
    const refresh = jest
      .spyOn(oauth, "refreshTokens")
      .mockImplementation(async () => {
        await Grant.clear(workspace.id, a.id, "medusa");
        const newer = await Grant.begin(workspace.id, a.id, "medusa", config);
        await Grant.save(workspace.id, a.id, "medusa", newer.version, config, {
          access_token: "private-reconnected",
          refresh_token: "private-fresh",
        });
        return {
          access_token: "private-stale",
          refresh_token: "private-stale",
        };
      });
    const result = await Promise.allSettled([
      layer.bootPersonalServer(workspace, "medusa", ca),
      layer.bootPersonalServer(workspace, "medusa", ca),
    ]);
    expect(result.every((item) => item.status === "rejected")).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(Client).not.toHaveBeenCalled();
    expect(
      (await Grant.find(workspace.id, a.id, "medusa", config)).access_token
    ).toBe("private-reconnected");
  });
  it("rechecks config and grant after an in-flight connect before publishing", async () => {
    Client.mockImplementationOnce(() => ({
      close: jest.fn().mockResolvedValue(),
      connect: jest.fn(async () => {
        await Grant.clear(workspace.id, a.id, "medusa");
      }),
    }));
    await expect(
      layer.bootPersonalServer(workspace, "medusa", ca)
    ).rejects.toThrow();
    expect(layer.personalRuntime.clients.size).toBe(0);
  });
  it("does not log private plugin args/results and marks chat history private", async () => {
    await layer.activeMCPServers(workspace, ca);
    const aibitat = {
      handlerProps: {
        invocation: { workspace, mcpCaller: ca },
        log: jest.fn(),
      },
      function: jest.fn(),
      introspect: jest.fn(),
    };
    const plugins = await layer.convertServerToolsToPlugins("medusa", aibitat);
    expect(plugins).toHaveLength(1);
    plugins[0].plugin().setup(aibitat);
    const result = await aibitat.function.mock.calls[0][0].handler({
      secret: "private-args",
    });
    expect(result).toContain("private-result");
    expect(aibitat.personalMcpUsed).toBe(true);
    expect(aibitat.function.mock.calls[0][0].privateMcp).toBe(true);
    expect(aibitat.handlerProps.invocation.personalMcpUsed).toBe(true);
    expect(
      JSON.stringify([
        aibitat.handlerProps.log.mock.calls,
        aibitat.introspect.mock.calls,
      ])
    ).not.toMatch(/private-args|private-result/);
  });
  it("rejects unadvertised and suppressed tools before remote call", async () => {
    const client = await layer.bootPersonalServer(workspace, "medusa", ca);
    await expect(
      layer.callServerTool(
        workspace,
        "medusa",
        { name: "write", arguments: {} },
        ca
      )
    ).rejects.toThrow("personal_tool_not_allowed");
    await expect(
      layer.callServerTool(
        workspace,
        "medusa",
        { name: "unknown", arguments: {} },
        ca
      )
    ).rejects.toThrow("personal_tool_not_allowed");
    expect(client.callTool).not.toHaveBeenCalled();
  });
  it('authenticated category plugins register private closures and disconnect stops loaded execution', async () => {
    configuredName = 'redball-store';
    config = { ...config, anythingllm: { perUserAuth: true, categoryLoading: true } };
    const grant = await Grant.begin(workspace.id, a.id, configuredName, config);
    await Grant.save(workspace.id, a.id, configuredName, grant.version, config, { access_token: 'private-category' });
    const definition = { name: 'medusa_catalog_products', description: 'Products', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['get'] } }, required: ['action'] } };
    const envelope = { kind: 'medusa_category_load', catalog_revision: `sha256:${'a'.repeat(64)}`, grant_id: 'grant_a', resource: config.url, categories: ['catalog'], tools: [definition] };
    const client = { connect: jest.fn().mockResolvedValue(), close: jest.fn().mockResolvedValue(),
      listTools: jest.fn().mockResolvedValue({ tools: [{ name: 'load_tool_categories', description: 'Load', inputSchema: { type: 'object', properties: {}, required: [] } }] }),
      callTool: jest.fn().mockImplementation(async request => request.name === 'load_tool_categories'
        ? { content: [{ type: 'text', text: JSON.stringify(envelope) }] }
        : { content: [{ type: 'text', text: 'private-category-result' }] }) };
    Client.mockImplementationOnce(() => client);
    const functions = new Map();
    const agent = { functions, function: jest.fn(fn => functions.set(fn.name, fn)), introspect: jest.fn(), handlerProps: { invocation: { workspace, mcpCaller: ca }, log: jest.fn() } };
    const plugins = await layer.convertServerToolsToPlugins(configuredName, agent);
    expect(plugins).toHaveLength(1); plugins[0].plugin().setup(agent);
    await functions.get('redball-store-load_tool_categories').handler({ categories: ['catalog'] });
    const loaded = functions.get('redball-store-medusa_catalog_products');
    expect(loaded.privateMcp).toBe(true);
    expect(await loaded.handler({ action: 'get' })).toContain('private-category-result');
    expect(client.callTool.mock.calls.at(-1)[0]._meta).toEqual({ 'medusa/catalog_revision': envelope.catalog_revision });
    expect(JSON.stringify([agent.handlerProps.log.mock.calls, agent.introspect.mock.calls])).not.toContain('private-category');
    const count = client.callTool.mock.calls.length;
    const current = await Grant.find(workspace.id, a.id, configuredName, config);
    await Grant.clear(workspace.id, a.id, configuredName, current.version);
    expect(await loaded.handler({ action: 'get' })).toMatch(/unavailable/);
    expect(client.callTool).toHaveBeenCalledTimes(count);
  });
  it("global reload invalidates grants when a personal definition is swapped or deleted", async () => {
    await layer.bootMCPServers();
    config = { ...config, url: "https://replacement.example/mcp" };
    await layer.reloadMCPServers();
    config = { ...config, url: "https://medusa.example/mcp" };
    expect(
      (await Grant.find(workspace.id, a.id, "medusa", config)).enabled
    ).toBe(false);
  });
});

describe("personal API key runtime", () => {
  beforeEach(async () => {
    config = { ...config, anythingllm: {
      perUserAuth: true, suppressedTools: ["write"],
      personalAuth: { type: "apiKey", header: "X-API-Key" },
    } };
    for (const user of [a, b]) {
      const snapshot = await Grant.snapshot(workspace.id, user.id, "medusa", config);
      expect(await Grant.saveApiKey(workspace.id, user.id, "medusa", snapshot, config, `private-key-${user.id}`)).toBe(true);
    }
  });
  it("sends distinct caller keys with X-API-Key and no bearer header or refresh", async () => {
    const refresh = jest.spyOn(oauth, "refreshTokens");
    const first = await layer.bootPersonalServer(workspace, "medusa", ca);
    const second = await layer.bootPersonalServer(workspace, "medusa", cb);
    expect(first).not.toBe(second);
    expect(Transport.mock.calls.map((call) => call[1].requestInit.headers)).toEqual([
      { "x-api-key": `private-key-${a.id}` },
      { "x-api-key": `private-key-${b.id}` },
    ]);
    expect(await layer.personalRuntime.tools(workspace, "medusa", ca)).toEqual([{ name: "read", inputSchema: {} }]);
    expect(refresh).not.toHaveBeenCalled();
  });
  it("clears only the captured version when connection fails with 401", async () => {
    Client.mockImplementationOnce(() => ({
      close: jest.fn().mockResolvedValue(),
      connect: jest.fn().mockRejectedValue({ status: 401 }),
    }));
    await expect(layer.bootPersonalServer(workspace, "medusa", ca)).rejects.toThrow("MCP authentication required");
    expect((await Grant.find(workspace.id, a.id, "medusa", config)).enabled).toBe(false);
    expect((await Grant.find(workspace.id, b.id, "medusa", config)).enabled).toBe(true);
  });
  it("a failed older connect cannot clear a concurrently replaced key", async () => {
    Client.mockImplementationOnce(() => ({
      close: jest.fn().mockResolvedValue(),
      connect: jest.fn(async () => {
        const snapshot = await Grant.snapshot(workspace.id, a.id, "medusa", config);
        await Grant.saveApiKey(workspace.id, a.id, "medusa", snapshot, config, "private-newer");
        throw { status: 401 };
      }),
    }));
    await expect(layer.bootPersonalServer(workspace, "medusa", ca)).rejects.toThrow("MCP authentication required");
    const current = await Grant.find(workspace.id, a.id, "medusa", config);
    expect(current.enabled).toBe(true);
    expect(current.access_token).toBe("private-newer");
  });
  it("tool discovery 401 preserves a newer saved key", async () => {
    const client = await layer.bootPersonalServer(workspace, "medusa", ca);
    client.listTools.mockImplementationOnce(async () => {
      const snapshot = await Grant.snapshot(workspace.id, a.id, "medusa", config);
      await Grant.saveApiKey(workspace.id, a.id, "medusa", snapshot, config, "private-newer");
      throw { status: 401 };
    });
    await expect(layer.personalRuntime.tools(workspace, "medusa", ca)).rejects.toThrow("MCP authentication required");
    const current = await Grant.find(workspace.id, a.id, "medusa", config);
    expect(current.enabled).toBe(true);
    expect(current.access_token).toBe("private-newer");
  });
});
