/** Real HTTP server, throwaway SQLite, real MCP SDK, fake provider only. */
require("../lark/helpers/preload");
const { createTempEnvironment } = require("../lark/helpers/env");
const path = require("path");
const { startMcpServer, startRuntime } = require("./helpers/server");
const { MockMcp } = require("./helpers/mockMcp");

jest.setTimeout(120000);
let environment,
  provider,
  server,
  runtime,
  adminToken,
  managerToken,
  defaultToken;
let workspaceA, workspaceB, prisma;
const runtimeLogs = [];
const password = "Passw0rd!2345";
const db = (callback) => callback(prisma);

async function createWorkspace(name) {
  const response = await server.api("/api/workspace/new", {
    method: "POST",
    token: adminToken,
    body: { name },
  });
  expect(response.status).toBe(200);
  expect(response.json.workspace).toBeTruthy();
  return response.json.workspace;
}

beforeAll(async () => {
  environment = createTempEnvironment();
  provider = await new MockMcp().start();
  const started = await startMcpServer(environment, {
    mcpServers: {
      flowaccount: {
        type: "streamable",
        url: `${provider.origin}/mcp`,
        anythingllm: { perWorkspaceAuth: true },
      },
      plain: { type: "streamable", url: `${provider.origin}/plain` },
    },
  });
  server = started.server;
  const { PrismaClient } = require(
    path.join(started.source, "node_modules/.prisma/client")
  );
  prisma = new PrismaClient({
    datasources: { db: { url: environment.env.E2E_DATABASE_URL } },
  });
  runtime = startRuntime(started.env, runtimeLogs);
  adminToken = (
    await server.enableMultiUser({ username: "mcpadmin", password })
  ).token;
  for (const [username, role] of [
    ["mcpmanager", "manager"],
    ["mcpdefault", "default"],
  ]) {
    await server.createUser({ token: adminToken, username, password, role });
    const session = await server.login({ username, password });
    if (role === "manager") managerToken = session.token;
    else defaultToken = session.token;
  }
  workspaceA = await createWorkspace("MCP company A");
  workspaceB = await createWorkspace("MCP company B");
  await db(async (prisma) => {
    for (const username of ["mcpmanager", "mcpdefault"]) {
      const user = await prisma.users.findUnique({ where: { username } });
      await prisma.workspace_users.create({
        data: { workspace_id: workspaceA.id, user_id: user.id },
      });
    }
  });
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (runtime) await runtime.stop();
  if (server) await server.stop();
  if (provider) await provider.stop();
  if (environment) environment.cleanup();
});

async function status(workspace) {
  const response = await server.api(`/api/workspace/${workspace.slug}/mcp`, {
    token: adminToken,
  });
  expect({ status: response.status, body: response.json }).toMatchObject({
    status: 200,
  });
  return response.json.connections.find(
    (row) => row.serverName === "flowaccount"
  );
}

function toggle(
  workspace,
  enabled,
  token = adminToken,
  serverName = "flowaccount"
) {
  return server.api(`/api/workspace/${workspace.slug}/mcp/toggle`, {
    method: "POST",
    token,
    body: { serverName, enabled },
  });
}

async function startOAuth(workspace, token = adminToken) {
  return server.api(`/api/mcp/oauth/start/${workspace.slug}/flowaccount`, {
    token,
  });
}

async function authorize(workspace, { deny = false } = {}) {
  const start = await startOAuth(workspace);
  expect(start.status).toBe(200);
  const url = new URL(start.json.url);
  expect(url.origin).toBe(provider.origin);
  expect(url.searchParams.get("redirect_uri")).toBe(
    `${server.origin}/api/mcp/oauth/callback`
  );
  expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("state")).toBeTruthy();
  expect(url.searchParams.get("scope").split(" ")).toEqual([
    "openid",
    "profile",
    "flowaccount-api",
    "offline_access",
  ]);
  if (deny) url.searchParams.set("deny", "1");
  const response = await fetch(url, { redirect: "manual" });
  expect(response.status).toBe(302);
  const callback = new URL(response.headers.get("location"));
  return { url, callback, route: `${callback.pathname}${callback.search}` };
}

async function connect(workspace) {
  const flow = await authorize(workspace);
  const callback = await server.api(flow.route);
  expect(callback.status).toBe(302);
  expect(callback.location).toBe(
    `/workspace/${workspace.slug}/settings/agent-config?mcp=flowaccount&connected=1`
  );
  return flow;
}

const connection = (workspace) =>
  db((prisma) =>
    prisma.workspace_mcp_connections.findUnique({
      where: {
        workspace_id_server_name: {
          workspace_id: workspace.id,
          server_name: "flowaccount",
        },
      },
    })
  );
const expire = (workspace) =>
  db((prisma) =>
    prisma.workspace_mcp_connections.update({
      where: {
        workspace_id_server_name: {
          workspace_id: workspace.id,
          server_name: "flowaccount",
        },
      },
      data: { expires_at: new Date(0) },
    })
  );
async function list(workspace) {
  const response = await server.api(
    `/api/mcp-servers/list?workspaceSlug=${workspace.slug}`,
    { token: adminToken }
  );
  expect(response.status).toBe(200);
  expect(response.json.success).toBe(true);
  return response.json.servers;
}
const refreshRequests = () =>
  provider
    .requestsFor("/oauth/token")
    .filter((request) => request.body.grant_type === "refresh_token");

it("lists disconnected catalog and rejects enable before OAuth", async () => {
  expect(await status(workspaceA)).toMatchObject({
    enabled: false,
    connected: false,
    needsReauth: false,
  });
  const rejected = await toggle(workspaceA, true);
  expect(rejected.status).toBe(409);
  expect((await toggle(workspaceA, false)).status).toBe(200);
  expect(await status(workspaceA)).toMatchObject({
    enabled: false,
    connected: false,
  });
});

it("completes browser OAuth with real PKCE, saves tokens, and rejects replay", async () => {
  const flow = await authorize(workspaceA);
  const state = flow.url.searchParams.get("state");
  const pending = await db((prisma) =>
    prisma.lark_oauth_states.findUnique({ where: { state } })
  );
  expect(pending.mode).toBe("mcp");
  expect(pending.code_verifier).not.toContain("codeVerifier");
  const invalidVerifier = await fetch(`${provider.origin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: flow.url.searchParams.get("client_id"),
      redirect_uri: flow.url.searchParams.get("redirect_uri"),
      code: flow.callback.searchParams.get("code"),
      code_verifier: "wrong-verifier",
    }),
  });
  expect(invalidVerifier.status).toBe(400);
  expect(await invalidVerifier.json()).toEqual({ error: "invalid_grant" });
  const callback = await server.api(flow.route);
  expect(callback.status).toBe(302);
  expect(callback.location).toContain("connected=1");
  const registered = await db((prisma) =>
    prisma.system_settings.findUnique({ where: { label: "mcp_oauth_clients" } })
  );
  expect(JSON.parse(registered.value)[`${provider.origin}/mcp`]).toMatchObject({
    client_id: flow.url.searchParams.get("client_id"),
    redirect_uri: `${server.origin}/api/mcp/oauth/callback`,
  });
  const issued = provider.issued.at(-1);
  expect(await connection(workspaceA)).toMatchObject({
    access_token: issued.access_token,
    refresh_token: issued.refresh_token,
    enabled: true,
  });
  expect(
    await db((prisma) =>
      prisma.lark_oauth_states.findUnique({ where: { state } })
    )
  ).toBeNull();
  const before = provider.requestsFor("/oauth/token").length;
  const replay = await server.api(flow.route);
  expect(replay.status).toBe(400);
  expect(replay.json).toEqual({ error: "invalid_state" });
  expect(provider.requestsFor("/oauth/token")).toHaveLength(before);
});

it("isolates status and enable decisions between workspace A and B", async () => {
  await connect(workspaceA);
  expect(await status(workspaceA)).toMatchObject({
    connected: true,
    enabled: true,
  });
  expect(await status(workspaceB)).toMatchObject({
    connected: false,
    enabled: false,
  });
  expect((await toggle(workspaceA, true)).status).toBe(200);
  expect((await toggle(workspaceB, true)).status).toBe(409);
  expect(await connection(workspaceB)).toBeNull();
});

it("lists OAuth tools through real HTTP using workspace credentials", async () => {
  await connect(workspaceA);
  const row = await connection(workspaceA);
  const before = provider.requestsFor("/mcp").length;
  expect(
    (await list(workspaceA)).find((entry) => entry.name === "flowaccount")
  ).toMatchObject({
    running: true,
    tools: [expect.objectContaining({ name: "get_company_info" })],
  });
  expect(provider.requestsFor("/mcp").slice(before)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        body: expect.objectContaining({ method: "tools/list" }),
        headers: expect.objectContaining({
          authorization: `Bearer ${row.access_token}`,
        }),
      }),
    ])
  );
  expect(await list(workspaceB)).toEqual([]);
});

it("refreshes expired A credentials when HTTP tools list is requested", async () => {
  await connect(workspaceA);
  await list(workspaceA);
  const previous = await connection(workspaceA);
  await expire(workspaceA);
  const before = refreshRequests().length;
  const servers = await list(workspaceA);
  expect(refreshRequests()).toHaveLength(before + 1);
  expect(refreshRequests().at(-1).body.refresh_token).toBe(
    previous.refresh_token
  );
  const refreshed = await connection(workspaceA);
  expect(refreshed.access_token).not.toBe(previous.access_token);
  expect(refreshed.refresh_token).not.toBe(previous.refresh_token);
  expect(servers.find((entry) => entry.name === "flowaccount")).toMatchObject({
    running: true,
    tools: [expect.objectContaining({ name: "get_company_info" })],
  });
  expect(await connection(workspaceB)).toBeNull();
});

it("scoped HTTP catalog contains enabled A connector but no B connector", async () => {
  await connect(workspaceA);
  expect((await list(workspaceA)).map((entry) => entry.name)).toEqual([
    "flowaccount",
  ]);
  expect(await list(workspaceB)).toEqual([]);
});

it("gates plain MCP tools with workspace allowlist over HTTP", async () => {
  expect((await toggle(workspaceA, true, adminToken, "plain")).status).toBe(
    200
  );
  const servers = await list(workspaceA);
  expect(servers.find((item) => item.name === "plain")).toMatchObject({
    running: true,
    tools: [expect.objectContaining({ name: "get_company_info" })],
  });
  expect(await list(workspaceB)).toEqual([]);
  expect((await toggle(workspaceA, false, adminToken, "plain")).status).toBe(
    200
  );
  expect((await list(workspaceA)).some((item) => item.name === "plain")).toBe(
    false
  );
});

it("rejects missing or invalid bearer at fake provider with valid bearer control", async () => {
  await connect(workspaceA);
  for (const authorization of [undefined, "Bearer invalid"]) {
    const response = await fetch(`${provider.origin}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "probe", version: "1" },
        },
      }),
    });
    expect(response.status).toBe(401);
    await response.text();
  }
  expect(await runtime.call("active", workspaceA)).toContain(
    "@@mcp_flowaccount"
  );
  expect(await runtime.call("call", workspaceA)).toMatchObject({
    content: [{ type: "text", text: "Company A" }],
  });
  expect(await runtime.call("active", workspaceB)).toEqual([]);
  const row = await connection(workspaceA);
  const initialized = provider
    .requestsFor("/mcp")
    .filter(
      (request) =>
        request.body.method === "initialize" &&
        request.headers.authorization === `Bearer ${row.access_token}`
    );
  expect(initialized.length).toBeGreaterThan(0);
});

it("real runtime keeps two connected companies on distinct bearer clients", async () => {
  await connect(workspaceA);
  const other = await createWorkspace("MCP second connected company");
  provider.label = "Company C";
  try {
    await connect(other);
  } finally {
    provider.label = "Company A";
  }
  const before = provider.requestsFor("/mcp").length;
  expect(await runtime.call("active", workspaceA)).toContain(
    "@@mcp_flowaccount"
  );
  expect(await runtime.call("active", other)).toContain("@@mcp_flowaccount");
  expect(await runtime.call("call", workspaceA)).toMatchObject({
    content: [{ type: "text", text: "Company A" }],
  });
  expect(await runtime.call("call", other)).toMatchObject({
    content: [{ type: "text", text: "Company C" }],
  });
  expect(await runtime.call("active", workspaceB)).toEqual([]);
  const tokens = [
    (await connection(workspaceA)).access_token,
    (await connection(other)).access_token,
  ];
  expect(tokens[0]).not.toBe(tokens[1]);
  const initialized = provider
    .requestsFor("/mcp")
    .slice(before)
    .filter((request) => request.body.method === "initialize");
  expect(
    new Set(initialized.map((request) => request.headers.authorization))
  ).toEqual(new Set(tokens.map((token) => `Bearer ${token}`)));
});

it("denied consent consumes state without saving tokens, then accepts consent", async () => {
  const workspace = await createWorkspace("MCP denial");
  const flow = await authorize(workspace, { deny: true });
  const before = provider.issued.length;
  const callback = await server.api(flow.route);
  expect(callback.location).toBe(
    `/workspace/${workspace.slug}/settings/agent-config?mcp=flowaccount&error=access_denied`
  );
  expect(await connection(workspace)).toBeNull();
  expect(provider.issued).toHaveLength(before);
  expect((await server.api(flow.route)).status).toBe(400);
  await connect(workspace);
  expect((await connection(workspace)).access_token).toBeTruthy();
});

it("rejects tampered state before token exchange but accepts original callback", async () => {
  const workspace = await createWorkspace("MCP state tamper");
  const flow = await authorize(workspace);
  const original = flow.callback.searchParams.get("state");
  const [payload, signature] = original.split(".");
  flow.callback.searchParams.set(
    "state",
    `${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`
  );
  const before = provider.issued.length;
  const rejected = await server.api(
    `${flow.callback.pathname}${flow.callback.search}`
  );
  expect(rejected.status).toBe(400);
  expect(rejected.json).toEqual({ error: "invalid_state" });
  expect(await connection(workspace)).toBeNull();
  expect(provider.issued).toHaveLength(before);
  expect((await server.api(flow.route)).location).toContain("connected=1");
});

it("real agent-facing runtime refreshes and uses rotated bearer without an LLM", async () => {
  await connect(workspaceA);
  const before = await expire(workspaceA);
  const count = refreshRequests().length;
  expect(await runtime.call("active", workspaceA)).toContain(
    "@@mcp_flowaccount"
  );
  expect(refreshRequests()).toHaveLength(count + 1);
  expect(refreshRequests().at(-1).body.refresh_token).toBe(
    before.refresh_token
  );
  const after = await connection(workspaceA);
  expect(after.access_token).not.toBe(before.access_token);
  expect(after.refresh_token).not.toBe(before.refresh_token);
  expect(new Date(after.expires_at).getTime()).toBeGreaterThan(Date.now());
  expect(await runtime.call("call", workspaceA)).toMatchObject({
    content: [{ type: "text", text: "Company A" }],
  });
  expect(provider.requestsFor("/mcp").at(-1).headers.authorization).toBe(
    `Bearer ${after.access_token}`
  );
});

it("invalid_grant removes refresh token and reports needsReauth", async () => {
  await connect(workspaceA);
  await expire(workspaceA);
  const count = refreshRequests().length;
  provider.refreshMode = "invalid_grant";
  try {
    expect(await runtime.call("active", workspaceA)).not.toContain(
      "@@mcp_flowaccount"
    );
    expect(refreshRequests()).toHaveLength(count + 1);
    expect((await connection(workspaceA)).refresh_token).toBeNull();
    expect(await status(workspaceA)).toMatchObject({ needsReauth: true });
  } finally {
    provider.refreshMode = "ok";
  }
  await connect(workspaceA);
  expect(await runtime.call("active", workspaceA)).toContain(
    "@@mcp_flowaccount"
  );
});

it("transient refresh 503 retains both tokens and recovers", async () => {
  await connect(workspaceA);
  const before = await expire(workspaceA);
  const count = refreshRequests().length;
  provider.refreshMode = "unavailable";
  try {
    expect(await runtime.call("active", workspaceA)).not.toContain(
      "@@mcp_flowaccount"
    );
    expect(refreshRequests()).toHaveLength(count + 1);
    expect(await connection(workspaceA)).toMatchObject({
      access_token: before.access_token,
      refresh_token: before.refresh_token,
    });
    expect(await status(workspaceA)).toMatchObject({ needsReauth: false });
  } finally {
    provider.refreshMode = "ok";
  }
  expect(await runtime.call("active", workspaceA)).toContain(
    "@@mcp_flowaccount"
  );
});

it("disconnect clears tokens, hides tools, and prevents stale runtime use", async () => {
  await connect(workspaceA);
  expect(await runtime.call("active", workspaceA)).toContain(
    "@@mcp_flowaccount"
  );
  const pending = await authorize(workspaceA);
  const response = await server.api("/api/mcp/oauth/disconnect", {
    method: "POST",
    token: adminToken,
    body: { workspaceSlug: workspaceA.slug, serverName: "flowaccount" },
  });
  expect(response.status).toBe(200);
  expect(response.json).toEqual({ success: true, remoteRevoked: false });
  expect(await connection(workspaceA)).toMatchObject({
    enabled: false,
    access_token: null,
    refresh_token: null,
    expires_at: null,
  });
  expect((await server.api(pending.route)).status).toBe(400);
  expect(await runtime.call("active", workspaceA)).not.toContain(
    "@@mcp_flowaccount"
  );
  await expect(runtime.call("call", workspaceA)).rejects.toThrow(
    "MCP authentication required"
  );
  expect(await status(workspaceA)).toMatchObject({
    enabled: false,
    connected: false,
  });
  expect(
    (await list(workspaceA))
      .filter((entry) => entry.name === "flowaccount")
      .flatMap((entry) => entry.tools)
  ).toEqual([]);
});

it("denies default user OAuth and toggle with admin positive control", async () => {
  expect((await startOAuth(workspaceA, defaultToken)).status).toBe(401);
  expect((await toggle(workspaceA, false, defaultToken)).status).toBe(401);
  expect((await startOAuth(workspaceA)).status).toBe(200);
  expect((await toggle(workspaceA, false)).status).toBe(200);
});

it("manager members can read MCP status and tools; only admins can write", async () => {
  await connect(workspaceA);
  for (const route of [
    `/api/workspace/${workspaceA.slug}/mcp`,
    `/api/mcp-servers/list?workspaceSlug=${workspaceA.slug}`,
  ]) {
    expect((await server.api(route, { token: managerToken })).status).toBe(200);
    expect((await server.api(route, { token: defaultToken })).status).toBe(401);
  }
  for (const route of [
    `/api/workspace/${workspaceB.slug}/mcp`,
    `/api/mcp-servers/list?workspaceSlug=${workspaceB.slug}`,
  ]) {
    expect((await server.api(route, { token: managerToken })).status).toBe(404);
  }
  expect(
    (await server.api("/api/mcp-servers/list", { token: managerToken })).status
  ).toBe(401);
  for (const token of [managerToken, defaultToken]) {
    for (const workspace of [workspaceA, workspaceB]) {
      expect((await startOAuth(workspace, token)).status).toBe(401);
      expect((await toggle(workspace, false, token)).status).toBe(401);
    }
  }
  expect((await startOAuth(workspaceA)).status).toBe(200);
  expect((await toggle(workspaceA, false)).status).toBe(200);
});

it("keeps all issued tokens out of HTTP child and runtime logs", async () => {
  expect(provider.issued.length).toBeGreaterThan(0);
  expect(provider.errors).toEqual([]);
  const output = [...server.logs, ...runtimeLogs].join("");
  expect(output).toContain("MCPHypervisor");
  for (const pair of provider.issued) {
    expect(output).not.toContain(pair.access_token);
    expect(output).not.toContain(pair.refresh_token);
  }
});
