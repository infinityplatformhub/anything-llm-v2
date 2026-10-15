require("../lark/helpers/preload");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const prisma = require("../../../utils/prisma");
const Layer = require("../../../utils/MCP");
const { SystemSettings } = require("../../../models/systemSettings");
const { mcpOAuthEndpoints } = require("../../../endpoints/mcpOAuth");

let provider, api, origin, workspace, users = [], layer, requests = [];
let originalNodeEnv;
const credentials = new Map([["fixture-person-a", "A novels"], ["fixture-person-b", "B novels"]]);
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

beforeAll(async () => {
  originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  process.env.JWT_SECRET = "personal-api-key-http-fixture";
  process.env.SIG_KEY ||= "personal-api-key-encryption-fixture";
  process.env.SIG_SALT ||= "personal-api-key-salt-fixture";
  provider = http.createServer(async (request, response) => {
    requests.push({ key: request.headers["x-api-key"], authorization: request.headers.authorization });
    const owner = credentials.get(request.headers["x-api-key"]);
    if (!owner) {
      response.writeHead(401, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ error: "invalid_key" }));
    }
    if (request.method !== "POST") {
      response.writeHead(405);
      return response.end();
    }
    const mcp = new McpServer({ name: "personal-novels-fixture", version: "1.0" });
    mcp.registerTool("my_novels", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: owner }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on("close", () => { void transport.close(); void mcp.close(); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await listen(provider);
  workspace = await prisma.workspaces.create({ data: { name: "API key HTTP fixture", slug: crypto.randomUUID() } });
  for (let index = 0; index < 2; index++) {
    const user = await prisma.users.create({ data: { username: crypto.randomUUID(), password: "unused", role: "default" } });
    users.push(user);
    await prisma.workspace_users.create({ data: { workspace_id: workspace.id, user_id: user.id } });
  }
  layer = new Layer();
  const config = { type: "streamable", url: `http://127.0.0.1:${provider.address().port}/mcp`, anythingllm: { perUserAuth: true, personalAuth: { type: "apiKey", header: "X-API-Key" } } };
  jest.spyOn(layer, "mcpServerConfigs", "get").mockReturnValue([{ name: "tnv-fixture", server: config }]);
  jest.spyOn(SystemSettings, "isMultiUserMode").mockResolvedValue(true);
  const app = express();
  app.use(express.json());
  mcpOAuthEndpoints(app);
  api = http.createServer(app);
  await listen(api);
  origin = `http://127.0.0.1:${api.address().port}`;
}, 30000);

test("room access without an assignment row permits only the caller's personal key", async () => {
  const base = `/workspace/${workspace.slug}/mcp-personal`;
  const connect = `${base}/tnv-fixture/api-key`;
  const outsider = await prisma.users.create({ data: { username: crypto.randomUUID(), password: "unused", role: "default" } });
  users.push(outsider);
  expect((await request(outsider, base)).status).toBe(401);
  expect((await request(outsider, connect, { apiKey: "fixture-person-a" })).status).toBe(401);
  for (const role of ["admin", "manager"]) {
    const user = await prisma.users.create({ data: { username: crypto.randomUUID(), password: "unused", role } });
    users.push(user);
    const key = `fixture-person-${role}`;
    const resultText = `${role} own novels`;
    credentials.set(key, resultText);
    expect((await request(user, base)).body.servers[0].connected).toBe(false);
    expect((await request(user, connect, { apiKey: key })).body.success).toBe(true);
    expect(await prisma.workspace_users.findFirst({ where: { user_id: user.id, workspace_id: workspace.id } })).toBeNull();
    const result = await request(user, `${base}/tnv-fixture/call`, { toolName: "my_novels", arguments: {} });
    expect(result.status).toBe(200);
    expect(result.body.result).toContain(resultText);
    expect(result.body.result).not.toContain("B novels");
    expect((await request(user, connect, { apiKey: "fixture-person-a", userId: users[0].id })).status).toBe(400);
  }
}, 30000);

afterAll(async () => {
  await layer?.personalRuntime.stopAll();
  if (api) await close(api);
  if (provider) await close(provider);
  if (workspace) await prisma.workspaces.delete({ where: { id: workspace.id } });
  for (const user of users) await prisma.users.delete({ where: { id: user.id } });
  await prisma.$disconnect();
  jest.restoreAllMocks();
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

async function request(user, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...(user && { Authorization: `Bearer ${jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: "1h" })}` }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => ({ error: "non_json_response" })) };
}

test("browser sessions save encrypted keys and real MCP calls stay scoped to each owner", async () => {
  const base = `/workspace/${workspace.slug}/mcp-personal`;
  const connect = `${base}/tnv-fixture/api-key`;
  expect((await request(null, connect, { apiKey: "fixture-person-a" })).status).toBe(401);
  expect((await request(users[0], connect, { apiKey: "fixture-person-a", userId: users[1].id })).status).toBe(400);
  for (const [index, apiKey] of ["fixture-person-a", "fixture-person-b"].entries()) {
    const saved = await request(users[index], connect, { apiKey });
    expect(saved).toEqual({ status: 200, body: { success: true } });
    expect(saved.body.success).toBe(true);
    expect(JSON.stringify(saved.body)).not.toContain(apiKey);
  }
  const raw = await prisma.personal_mcp_grants.findMany({ where: { workspace_id: workspace.id, user_id: { in: [users[0].id, users[1].id] } } });
  expect(raw).toHaveLength(2);
  expect(JSON.stringify(raw)).not.toMatch(/fixture-person-[ab]/);
  for (const [index, owner] of ["A novels", "B novels"].entries()) {
    const status = await request(users[index], base);
    expect(status.body.servers).toEqual([expect.objectContaining({ name: "tnv-fixture", authType: "apiKey", connected: true })]);
    expect(JSON.stringify(status.body)).not.toMatch(/fixture-person-[ab]/);
    const result = await request(users[index], `${base}/tnv-fixture/call`, { toolName: "my_novels", arguments: {} });
    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    expect(result.body.result).toContain(owner);
    expect(result.body.result).not.toContain(index === 0 ? "B novels" : "A novels");
  }
  const failed = await request(users[0], connect, { apiKey: "invalid-fixture" });
  expect(failed.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(failed.body)).not.toContain("invalid-fixture");
  const stillConnected = await request(users[0], `${base}/tnv-fixture/call`, { toolName: "my_novels", arguments: {} });
  expect(stillConnected.body.result).toContain("A novels");
  expect(requests.some((r) => r.key === "fixture-person-a")).toBe(true);
  expect(requests.some((r) => r.key === "fixture-person-b")).toBe(true);
  expect(requests.every((r) => r.authorization === undefined)).toBe(true);
  expect((await request(users[0], "/mcp/oauth/disconnect", { workspaceSlug: workspace.slug, serverName: "tnv-fixture" })).body.success).toBe(true);
  const disconnected = await request(users[0], base);
  expect(disconnected.body.servers[0].connected).toBe(false);
  expect((await request(users[1], `${base}/tnv-fixture/call`, { toolName: "my_novels", arguments: {} })).body.result).toContain("B novels");
}, 30000);
