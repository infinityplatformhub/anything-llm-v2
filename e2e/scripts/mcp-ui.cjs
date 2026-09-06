const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const ROOT = path.resolve(__dirname, "../..");
const { createTempEnvironment, SERVER_DIR, PRELOAD } = require(path.join(ROOT, "server/__tests__/e2e/lark/helpers/env.js"));
const { TestServer } = require(path.join(ROOT, "server/__tests__/e2e/lark/helpers/server.js"));
const { Server } = require(path.join(SERVER_DIR, "node_modules/@modelcontextprotocol/sdk/dist/cjs/server/index.js"));
const { StreamableHTTPServerTransport } = require(path.join(SERVER_DIR, "node_modules/@modelcontextprotocol/sdk/dist/cjs/server/streamableHttp.js"));
const { ListToolsRequestSchema, CallToolRequestSchema } = require(path.join(SERVER_DIR, "node_modules/@modelcontextprotocol/sdk/dist/cjs/types.js"));
const LOGS = path.join(ROOT, "e2e/logs/mcp-ui");
const children = [];
let environment, fake, gateway, stopping = false;
const sessions = new Set();
const adminCredentials = { username: "mcp-admin", password: crypto.randomBytes(18).toString("base64url") };

async function free(port) {
  const probe = net.createServer();
  probe.listen(port);
  await once(probe, "listening");
  await new Promise((resolve) => probe.close(resolve));
}
function launch(args, cwd, env, log) {
  const fd = fs.openSync(path.join(LOGS, log), "a");
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  children.push(child);
  child.on("error", (error) => console.error(error.message));
  return child;
}
async function ready(url, child, check = () => true) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) throw new Error(`Child exited before ${url}; inspect ${LOGS}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok && await check(response)) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`Readiness timeout: ${url}; inspect ${LOGS}`);
}
async function cleanup() {
  if (stopping) return;
  stopping = true;
  await Promise.all(children.map(async (child) => {
    if (!child.pid || child.exitCode !== null || child.signalCode) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  }));
  await Promise.all([...sessions].map((server) => server.close()));
  for (const listener of [fake, gateway]) {
    if (!listener) continue;
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
  }
  environment?.cleanup();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => cleanup().then(() => process.exit(signal === "SIGINT" ? 130 : 143)));

async function fakeProvider() {
  const clients = new Map(), grants = new Map(), tokens = new Map(), refresh = new Map();
  const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const escape = (value) => String(value).replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
  let origin;
  fake = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (url.pathname === "/.well-known/oauth-protected-resource") return json(res, 200, { resource: origin, authorization_servers: [origin] });
      if (url.pathname === "/.well-known/oauth-authorization-server") return json(res, 200, {
        issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["openid", "profile", "flowaccount-api", "offline_access"],
      });
      let body = "";
      for await (const chunk of req) { body += chunk; if (body.length > 65536) throw new Error("Request too large"); }
      if (url.pathname === "/oauth/register" && req.method === "POST") {
        const data = JSON.parse(body);
        if (!Array.isArray(data.redirect_uris) || data.redirect_uris.length !== 1 || data.redirect_uris[0] !== "http://localhost:3021/api/mcp/oauth/callback") return json(res, 400, { error: "invalid_redirect_uri" });
        const client_id = crypto.randomUUID();
        clients.set(client_id, data.redirect_uris[0]);
        return json(res, 201, { client_id, ...data });
      }
      if (url.pathname === "/oauth/authorize" && req.method === "GET") {
        const p = url.searchParams;
        if (clients.get(p.get("client_id")) !== p.get("redirect_uri") || p.get("code_challenge_method") !== "S256" || !p.get("code_challenge") || !p.get("state")) return json(res, 400, { error: "invalid_request" });
        if (p.get("allow") === "1") {
          if (!["Alpha Company", "Beta Company"].includes(p.get("company"))) return json(res, 400, { error: "invalid_request" });
          const code = crypto.randomUUID();
          grants.set(code, Object.fromEntries(p));
          const redirect = new URL(p.get("redirect_uri"));
          redirect.search = new URLSearchParams({ code, state: p.get("state") }).toString();
          res.writeHead(302, { Location: redirect.href }); return res.end();
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Fake FlowAccount Consent</title><body style="font:20px system-ui;background:#f1f5f9;color:#14213d;padding:70px"><main style="max-width:600px;margin:auto;background:white;padding:40px;border-radius:18px"><p>LOCAL TEST PROVIDER · NOT FLOWACCOUNT</p><h1>Connect company</h1><p>Grant this workspace access to one fake company.</p><form method="get" action="/oauth/authorize">${[...p].map(([key, value]) => `<input type="hidden" name="${escape(key)}" value="${escape(value)}">`).join("")}<label for="company">Company</label> <select id="company" name="company"><option>Alpha Company</option><option>Beta Company</option></select><p><button name="allow" value="1" style="padding:16px;font:inherit">FlowAccount (fake) — Allow</button></p></form></main></body></html>`);
      }
      if (url.pathname === "/oauth/token" && req.method === "POST") {
        const p = new URLSearchParams(body);
        let company;
        if (p.get("grant_type") === "authorization_code") {
          const grant = grants.get(p.get("code"));
          const challenge = crypto.createHash("sha256").update(p.get("code_verifier") || "").digest("base64url");
          if (!grant || grant.code_challenge !== challenge || grant.client_id !== p.get("client_id") || grant.redirect_uri !== p.get("redirect_uri")) return json(res, 400, { error: "invalid_grant" });
          grants.delete(p.get("code")); company = grant.company;
        } else if (p.get("grant_type") === "refresh_token") {
          const grant = refresh.get(p.get("refresh_token"));
          if (!grant || grant.client_id !== p.get("client_id")) return json(res, 400, { error: "invalid_grant" });
          company = grant.company;
        } else return json(res, 400, { error: "unsupported_grant_type" });
        const access_token = crypto.randomUUID(), refresh_token = crypto.randomUUID();
        tokens.set(access_token, company); refresh.set(refresh_token, { company, client_id: p.get("client_id") });
        return json(res, 200, { access_token, refresh_token, token_type: "Bearer", expires_in: 3600, company_label: company });
      }
      if (url.pathname === "/mcp") {
        const company = tokens.get((req.headers.authorization || "").replace(/^Bearer /, ""));
        if (!company) { res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`); return json(res, 401, { error: "unauthorized" }); }
        if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
        const server = new Server({ name: "fake-flowaccount", version: "1.0.0" }, { capabilities: { tools: {} } });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "get_company", description: "Return the selected fake company", inputSchema: { type: "object", properties: {} } }] }));
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          if (request.params.name !== "get_company") throw new Error("Unknown tool");
          return { content: [{ type: "text", text: company }] };
        });
        sessions.add(server);
        res.on("close", () => { sessions.delete(server); void server.close(); });
        await server.connect(transport);
        return await transport.handleRequest(req, res, JSON.parse(body));
      }
      json(res, 404, { error: "not_found" });
    } catch (error) {
      console.error(`Fake provider: ${error.message}`);
      if (!res.headersSent) json(res, 500, { error: "fake_provider_error" }); else res.end();
    }
  });
  fake.listen(0, "127.0.0.1"); await once(fake, "listening");
  origin = `http://127.0.0.1:${fake.address().port}`;
  return origin;
}

async function selfTest() {
  const assert = require("node:assert/strict");
  const origin = await fakeProvider();
  const redirect_uri = "http://localhost:3021/api/mcp/oauth/callback";
  const registration = await fetch(`${origin}/oauth/register`, { method: "POST", body: JSON.stringify({ redirect_uris: [redirect_uri] }) });
  assert.equal(registration.status, 201);
  const { client_id } = await registration.json();
  const verifier = crypto.randomBytes(32).toString("base64url");
  const params = new URLSearchParams({ client_id, redirect_uri, code_challenge_method: "S256", code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), state: "self-test", company: "Alpha Company", allow: "1" });
  const consent = await fetch(`${origin}/oauth/authorize?${params}`, { redirect: "manual" });
  assert.equal(consent.status, 302);
  const code = new URL(consent.headers.get("location")).searchParams.get("code");
  const exchange = (code_verifier) => fetch(`${origin}/oauth/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id, redirect_uri, code, code_verifier }) });
  assert.equal((await exchange("wrong-verifier")).status, 400);
  const issued = await exchange(verifier);
  assert.equal(issued.status, 200);
  const { access_token, company_label } = await issued.json();
  assert.equal(company_label, "Alpha Company");
  assert.equal((await exchange(verifier)).status, 400);
  const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  const call = (token) => fetch(`${origin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(rpc) });
  assert.equal((await call("wrong-token")).status, 401);
  const tools = await call(access_token);
  assert.equal(tools.status, 200);
  assert.equal((await tools.json()).result.tools[0].name, "get_company");
  console.log("Fake provider self-test passed: valid PKCE, invalid PKCE rejection, one-use codes, bearer rejection, authenticated MCP tools/list.");
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  await free(3020); await free(3021); await free(3022);
  fs.mkdirSync(LOGS, { recursive: true });
  const { chromium } = require(path.join(ROOT, "node_modules/@playwright/test"));
  if (!fs.existsSync(chromium.executablePath())) {
    const install = spawn(process.execPath, [path.join(ROOT, "node_modules/playwright/cli.js"), "install", "chromium"], { stdio: "inherit" });
    children.push(install);
    const [code] = await once(install, "exit"); if (code !== 0) throw new Error("Chromium install failed");
  }
  environment = createTempEnvironment();
  const origin = await fakeProvider();
  // Development permits localhost OAuth but hardcodes storage relative to source.
  // Copy unchanged source, not node_modules or developer storage/config/secrets.
  const source = path.join(environment.root, "server");
  fs.cpSync(SERVER_DIR, source, { recursive: true, filter: (entry) => {
    const relative = path.relative(SERVER_DIR, entry);
    const first = relative.split(path.sep)[0];
    return !relative || (!first.startsWith(".env") && !["node_modules", "storage", "public", "__tests__"].includes(first));
  } });
  fs.symlinkSync(path.join(SERVER_DIR, "node_modules"), path.join(source, "node_modules"), "dir");
  fs.symlinkSync(environment.storageDir, path.join(source, "storage"), "dir");
  fs.mkdirSync(path.join(environment.storageDir, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(environment.storageDir, "plugins/anythingllm_mcp_servers.json"), JSON.stringify({ mcpServers: { flowaccount: { type: "streamable", url: `${origin}/mcp`, anythingllm: { perWorkspaceAuth: true } } } }, null, 2));
  const env = { PATH: process.env.PATH, HOME: environment.root, TMPDIR: process.env.TMPDIR, ...environment.env, NODE_ENV: "development", SERVER_PORT: "3022", SERVER_URL: "http://localhost:3021" };
  const serverChild = launch(["--require", PRELOAD, path.join(source, "index.js")], source, env, "server.log");
  await ready("http://localhost:3022/api/ping", serverChild, async (res) => (await res.json()).online === true);
  // Split-origin development uses relative callbacks, as does Lark login.
  // Test-only gateway forwards the real API and redirects workspace pages to Vite.
  gateway = http.createServer((req, res) => {
    if (req.url.startsWith("/workspace/")) {
      res.writeHead(302, { Location: `http://localhost:3020${req.url}` });
      return res.end();
    }
    const upstream = http.request({ hostname: "localhost", port: 3022, method: req.method, path: req.url, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("Harness API upstream unavailable"); });
    req.pipe(upstream);
  });
  gateway.listen(3021);
  await once(gateway, "listening");
  const server = new TestServer({ child: serverChild, port: 3021, logs: [] });
  const admin = await server.enableMultiUser(adminCredentials);
  const api = async (route, body) => {
    const result = await server.api(route, { method: "POST", token: admin.token, body });
    if (result.status !== 200 || result.json?.success === false || result.json?.error) throw new Error(`Seed ${route}: ${result.status} ${result.text}`);
    return result.json;
  };
  await api("/api/onboarding", {});
  const alpha = await api("/api/workspace/new", { name: "ws-alpha" });
  await api("/api/workspace/new", { name: "ws-beta" });
  const viewerCredentials = { username: "mcp-viewer", password: crypto.randomBytes(18).toString("base64url") };
  const viewerUser = await server.createUser({ token: admin.token, ...viewerCredentials, role: "manager" });
  await api(`/api/admin/workspaces/${alpha.workspace.id}/update-users`, { userIds: [viewerUser.id] });
  const viewer = await server.login(viewerCredentials);
  const authFile = path.join(environment.root, "browser-auth.json");
  fs.writeFileSync(authFile, JSON.stringify({ admin, viewer }), { mode: 0o600 });
  const vite = launch([path.join(ROOT, "frontend/node_modules/vite/bin/vite.js"), "--host", "localhost", "--port", "3020", "--strictPort"], path.join(ROOT, "frontend"), { ...process.env, VITE_API_BASE: "http://localhost:3021/api" }, "vite.log");
  await ready("http://localhost:3020", vite);
  console.log(`MCP UI ready: http://localhost:3020/workspace/ws-alpha/settings/agent-config\nAdmin login: ${adminCredentials.username} / ${adminCredentials.password}\nEvidence: ${LOGS}`);
  const playwright = spawn(process.execPath, [path.join(ROOT, "node_modules/@playwright/test/cli.js"), "test", "-c", path.join(ROOT, "e2e/mcp-ui.playwright.config.ts"), "--headed", ...process.argv.slice(2)], { cwd: ROOT, env: { ...process.env, MCP_UI_AUTH_FILE: authFile }, stdio: "inherit" });
  children.push(playwright);
  const [code] = await once(playwright, "exit");
  process.exitCode = code ?? 1;
  if (process.env.MCP_UI_KEEP_UP === "1") {
    console.log(`MCP_UI_KEEP_UP=1: services remain running. Open http://localhost:3020 and log in as ${adminCredentials.username} / ${adminCredentials.password}. Ctrl+C stops services and removes temp data.`);
    // Keep the fake provider alive too, so manual OAuth stays functional.
    await new Promise(() => {});
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(cleanup);
