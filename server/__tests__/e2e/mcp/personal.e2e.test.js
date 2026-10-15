/** Real OAuth HTTP + Prisma + MCP SDK; no production or provider credentials. */
require("../lark/helpers/preload");
const { MockMcp } = require("./helpers/mockMcp");
const crypto = require("crypto");
const prisma = require("../../../utils/prisma");
const Layer = require("../../../utils/MCP");
const { PersonalMcpGrant: Grant } = require("../../../models/personalMcpGrant");
const caller = require("../../../utils/MCP/personalCaller");
const oauth = require("../../../utils/MCP/oauth");
const { mcpOAuthEndpoints } = require("../../../endpoints/mcpOAuth");
const { SystemSettings } = require("../../../models/systemSettings");
const http = require("http");
jest.setTimeout(60000);
let provider, workspace, a, b, layer, routes, original, logs;
beforeAll(async () => {
  original = {
    NODE_ENV: process.env.NODE_ENV,
    SERVER_URL: process.env.SERVER_URL,
    JWT_SECRET: process.env.JWT_SECRET,
  };
  process.env.NODE_ENV = "development";
  process.env.JWT_SECRET = "personal-e2e";
  process.env.SERVER_URL = "http://localhost:3001";
  process.env.SIG_KEY ||= "e2e-key";
  process.env.SIG_SALT ||= "e2e-salt";
  logs = ["log", "error", "warn"].map((name) =>
    jest.spyOn(console, name).mockImplementation(() => {})
  );
  provider = await new MockMcp().start();
  workspace = await prisma.workspaces.create({
    data: { name: "Personal SDK E2E", slug: crypto.randomUUID() },
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
  layer = new Layer();
  const config = {
    type: "streamable",
    url: `${provider.origin}/mcp`,
    anythingllm: { perUserAuth: true },
  };
  jest
    .spyOn(layer, "mcpServerConfigs", "get")
    .mockReturnValue([{ name: "personal-medusa", server: config }]);
  let registry = "{}";
  jest
    .spyOn(SystemSettings, "get")
    .mockImplementation(async ({ label }) =>
      label === "mcp_oauth_clients" ? { value: registry } : null
    );
  jest
    .spyOn(SystemSettings, "_updateSettings")
    .mockImplementation(async (values) => {
      registry = values.mcp_oauth_clients;
      return { success: true };
    });
  routes = {};
  const register = (path, middleware, handler) =>
    (routes[path] = handler || middleware);
  mcpOAuthEndpoints({ get: register, post: register });
});
afterAll(async () => {
  if (layer) await layer.personalRuntime.stopAll();
  if (provider) await provider.stop();
  if (workspace)
    await prisma.workspaces.delete({ where: { id: workspace.id } });
  for (const user of [a, b])
    if (user) await prisma.users.delete({ where: { id: user.id } });
  await prisma.$disconnect();
  jest.restoreAllMocks();
  for (const [key, value] of Object.entries(original))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});
async function invoke(path, user, values = {}) {
  const response = {
    locals: { user, browserSessionUserId: user?.id, multiUserMode: true },
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    redirect(url) {
      this.location = url;
      this.statusCode = 302;
      return this;
    },
  };
  await routes[path](
    {
      params: { workspaceSlug: workspace.slug, serverName: "personal-medusa" },
      query: {},
      body: {},
      ...values,
    },
    response
  );
  return response;
}
async function connect(user, label) {
  provider.label = label;
  const start = await invoke(
    "/mcp/oauth/start/:workspaceSlug/:serverName",
    user
  );
  expect(start.statusCode).toBe(200);
  const authorization = await fetch(start.body.url, { redirect: "manual" });
  const callback = new URL(authorization.headers.get("location"));
  const response = await invoke("/mcp/oauth/callback", null, {
    query: Object.fromEntries(callback.searchParams),
  });
  expect(response.location).toContain("connected=1");
}
it("A/B share workspace but actual SDK calls use only their personal account, refresh and disconnect stay isolated", async () => {
  await connect(a, "A private company");
  await connect(b, "B private company");
  const ca = await caller.fromResponse(
    { locals: { user: a, browserSessionUserId: a.id } },
    workspace
  );
  const cb = await caller.fromResponse(
    { locals: { user: b, browserSessionUserId: b.id } },
    workspace
  );
  const request = { name: "get_company_info", arguments: {} };
  expect(
    JSON.stringify(
      await layer.callServerTool(workspace, "personal-medusa", request, ca)
    )
  ).toContain("A private company");
  expect(
    JSON.stringify(
      await layer.callServerTool(workspace, "personal-medusa", request, cb)
    )
  ).toContain("B private company");
  const statusRoute = "/workspace/:slug/mcp-personal";
  const status = await invoke(statusRoute, a, {
    params: { slug: workspace.slug },
  });
  expect(status.body.servers[0].accountLabel).toBe("A private company");
  const config = layer.mcpServerConfigs[0].server;
  const grant = await Grant.find(workspace.id, a.id, "personal-medusa", config);
  await Grant.save(
    workspace.id,
    a.id,
    "personal-medusa",
    grant.version,
    config,
    {
      access_token: grant.access_token,
      refresh_token: grant.refresh_token,
      expires_at: new Date(0),
    }
  );
  expect(
    JSON.stringify(
      await layer.callServerTool(workspace, "personal-medusa", request, ca)
    )
  ).toContain("A private company");
  expect(
    (await invoke(statusRoute, a, { params: { slug: workspace.slug } })).body
      .servers[0].accountLabel
  ).toBe("A private company");
  expect(
    provider
      .requestsFor("/oauth/token")
      .filter((req) => req.body.grant_type === "refresh_token")
  ).toHaveLength(1);
  const disconnected = await invoke("/mcp/oauth/disconnect", a, {
    body: {
      workspaceSlug: workspace.slug,
      serverName: "personal-medusa",
      userId: b.id,
    },
  });
  expect(disconnected.body.success).toBe(true);
  await expect(
    layer.callServerTool(workspace, "personal-medusa", request, ca)
  ).rejects.toThrow("MCP authentication required");
  expect(
    JSON.stringify(
      await layer.callServerTool(workspace, "personal-medusa", request, cb)
    )
  ).toContain("B private company");
  expect(JSON.stringify(logs.flatMap((spy) => spy.mock.calls))).not.toMatch(
    /mcp-access-|mcp-refresh-|A private company|B private company/
  );
});

it.each([401, 503])(
  "real SDK never replays a tool mutation when HTTP response is %s",
  async (status) => {
    let mutations = 0,
      calls = 0;
    const mock = http.createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      res.setHeader("Content-Type", "application/json");
      if (body.method === "initialize")
        return res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "mutation-fixture", version: "1" },
            },
          })
        );
      if (body.method === "notifications/initialized") {
        res.statusCode = 202;
        return res.end();
      }
      if (body.method === "tools/list")
        return res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [{ name: "mutate", inputSchema: { type: "object" } }],
            },
          })
        );
      if (body.method === "tools/call") {
        calls++;
        mutations++;
        res.statusCode = status;
        return res.end(JSON.stringify({ error: "failure-after-mutation" }));
      }
      res.statusCode = 405;
      res.end();
    });
    await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
    const name = `mutation-${status}`;
    const config = {
      type: "streamable",
      url: `http://127.0.0.1:${mock.address().port}/mcp`,
      anythingllm: { perUserAuth: true },
    };
    const originalConfigs = layer.mcpServerConfigs;
    const getter = jest
      .spyOn(layer, "mcpServerConfigs", "get")
      .mockReturnValue([...originalConfigs, { name, server: config }]);
    try {
      const grant = await Grant.begin(workspace.id, a.id, name, config);
      await Grant.save(workspace.id, a.id, name, grant.version, config, {
        access_token: "fixture-public-mcp-token",
        refresh_token: "fixture-refresh",
      });
      const identity = await caller.fromResponse(
        { locals: { user: a, browserSessionUserId: a.id } },
        workspace
      );
      await expect(
        layer.callServerTool(
          workspace,
          name,
          { name: "mutate", arguments: {} },
          identity
        )
      ).rejects.toThrow();
      expect(calls).toBe(1);
      expect(mutations).toBe(1);
    } finally {
      await layer.personalRuntime.stop(workspace.id, name);
      getter.mockReturnValue(originalConfigs);
      mock.closeAllConnections();
      await new Promise((resolve) => mock.close(resolve));
    }
  }
);
