/* global jest */
const {
  describe,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  it,
  expect,
} = require("@jest/globals");
require("../utils/lark/_polyfill");
const http = require("http");
const crypto = require("crypto");
jest.mock("../../utils/MCP/hypervisor", () => jest.fn());
const Hypervisor = require("../../utils/MCP/hypervisor");
const prisma = require("../../utils/prisma");
const { SystemSettings } = require("../../models/systemSettings");
const {
  WorkspaceMcpConnection,
} = require("../../models/workspaceMcpConnection");
const { validatedRequest } = require("../../utils/middleware/validatedRequest");
const oauth = require("../../utils/MCP/oauth");
const { mcpOAuthEndpoints } = require("../../endpoints/mcpOAuth");

let server, origin, workspace, routes, logs, tokenRequests, registrations;
let configs, stop, resourceOverrides, metadataOverrides, tokenOverrides;
const originalNodeEnv = process.env.NODE_ENV;
const originalSecret = process.env.JWT_SECRET;
const originalServerUrl = process.env.SERVER_URL;
function sign(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${crypto.createHmac("sha256", process.env.JWT_SECRET).update(encoded).digest("base64url")}`;
}
async function invoke(path, values = {}, user = { id: 7, role: "admin" }) {
  const route = routes[path];
  const req = {
    headers: {},
    header: () => undefined,
    protocol: "http",
    get: () => "localhost:3001",
    params: {},
    query: {},
    body: {},
    ...values,
  };
  const res = {
    locals: { user, multiUserMode: true },
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    sendStatus(code) {
      this.statusCode = code;
      return this;
    },
    end() {
      return this;
    },
    redirect(url) {
      this.statusCode = 302;
      this.location = url;
      return this;
    },
  };
  // Session validator retained by identity; real role guard executes here.
  if (path === "/mcp/oauth/callback") {
    expect(route.middleware).toEqual([]);
    await route.handler(req, res);
    return res;
  }
  expect(route.middleware[0]).toBe(validatedRequest);
  let allowed = false;
  await route.middleware[1](req, res, () => {
    allowed = true;
  });
  if (allowed) await route.handler(req, res);
  return res;
}
async function start() {
  return invoke("/mcp/oauth/start/:workspaceSlug/:serverName", {
    params: { workspaceSlug: workspace.slug, serverName: "flowaccount" },
  });
}
async function callback(state, extra = {}) {
  return invoke("/mcp/oauth/callback", {
    query: { state, code: "valid-code", ...extra },
  });
}

describe("MCP OAuth", () => {
  beforeAll(async () => {
    process.env.JWT_SECRET = "mcp-test-secret";
    process.env.SERVER_URL = "http://localhost:3001";
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/.well-known/oauth-protected-resource")
        return res.end(
          JSON.stringify({
            resource: origin,
            authorization_servers: [origin],
            ...resourceOverrides,
          })
        );
      if (req.url === "/.well-known/oauth-authorization-server")
        return res.end(
          JSON.stringify({
            issuer: origin,
            authorization_endpoint: `${origin}/oauth/authorize`,
            token_endpoint: `${origin}/oauth/token`,
            registration_endpoint: `${origin}/oauth/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
            scopes_supported: [
              "openid",
              "profile",
              "flowaccount-api",
              "offline_access",
            ],
            ...metadataOverrides,
          })
        );
      if (req.url === "/oauth/register") {
        registrations.push(JSON.parse(body));
        return res.end(
          JSON.stringify({ client_id: `client-${registrations.length}` })
        );
      }
      if (req.url === "/oauth/token") {
        tokenRequests.push(new URLSearchParams(body));
        return res.end(
          JSON.stringify({
            access_token: "private-access-token",
            refresh_token: "private-refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
            ...tokenOverrides,
          })
        );
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(async () => {
    process.env.NODE_ENV = "development";
    resourceOverrides = {};
    metadataOverrides = {};
    tokenOverrides = {};
    logs = ["log", "error", "warn"].map((name) =>
      jest.spyOn(console, name).mockImplementation(() => {})
    );
    jest.spyOn(SystemSettings, "isMultiUserMode").mockResolvedValue(true);
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
    workspace = await prisma.workspaces.create({
      data: { name: "OAuth test", slug: `oauth-${crypto.randomUUID()}` },
    });
    tokenRequests = [];
    registrations = [];
    configs = [
      {
        name: "flowaccount",
        server: {
          url: `${origin}/${crypto.randomUUID()}`,
          anythingllm: { perWorkspaceAuth: true },
        },
      },
    ];
    stop = jest.fn();
    Hypervisor.mockImplementation(() => ({
      mcpServerConfigs: configs,
      stopWorkspaceServer: stop,
    }));
    routes = {};
    const register = (path, middleware, handler) => {
      routes[path] =
        typeof middleware === "function"
          ? { middleware: [], handler: middleware }
          : { middleware, handler };
    };
    mcpOAuthEndpoints({ get: register, post: register });
  });
  afterEach(async () => {
    const output = logs
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .join(" ");
    try {
      expect(output).not.toMatch(
        /access_token|private-access-token|private-refresh-token/
      );
    } finally {
      jest.restoreAllMocks();
      try {
        const states = await prisma.lark_oauth_states.findMany({
          where: { mode: "mcp" },
        });
        for (const row of states) {
          let payload;
          try {
            payload = oauth.verifyState(row.state);
          } catch {
            continue;
          }
          if (payload.wsSlug === workspace.slug)
            await prisma.lark_oauth_states.delete({
              where: { state: row.state },
            });
        }
      } finally {
        await prisma.workspaces.delete({ where: { id: workspace.id } });
      }
    }
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    if (originalServerUrl === undefined) delete process.env.SERVER_URL;
    else process.env.SERVER_URL = originalServerUrl;
  });
  it("rejects mismatched protected resource before registration", async () => {
    resourceOverrides.resource = "https://other.example/resource";
    expect((await start()).statusCode).toBe(400);
    expect(registrations).toHaveLength(0);
  });
  it.each([
    "authorization_endpoint",
    "token_endpoint",
    "registration_endpoint",
  ])("rejects cross-origin %s without contacting it", async (endpoint) => {
    const requests = [];
    const other = http.createServer((req, res) => {
      requests.push(req.method);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ client_id: "pivot-client" }));
    });
    await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
    metadataOverrides[endpoint] =
      `http://127.0.0.1:${other.address().port}/pivot`;
    try {
      expect((await start()).statusCode).toBe(400);
      expect(registrations).toHaveLength(0);
      expect(requests).toHaveLength(0);
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });
  it.each([
    "http://127.0.0.1",
    "https://127.0.0.2",
    "https://10.0.0.5",
    "https://172.16.0.1",
    "https://172.31.255.255",
    "https://192.168.1.1",
    "https://169.254.169.254",
    "https://0.0.0.0",
    "https://localhost",
    "https://[::]",
    "https://[::1]",
    "https://[fc00::1]",
    "https://[fdff::1]",
    "https://[fe80::1]",
    "https://[febf::1]",
    "https://[::ffff:127.0.0.1]",
    "https://[::ffff:10.0.0.5]",
  ])("rejects production AS %s before contacting it", async (issuer) => {
    process.env.NODE_ENV = "production";
    const serverUrl = `https://resource.example/${crypto.randomUUID()}`;
    const fetcher = jest
      .spyOn(global, "fetch")
      .mockImplementation(async () => ({
        ok: true,
        json: async () =>
          fetcher.mock.calls.length === 1
            ? { resource: serverUrl, authorization_servers: [issuer] }
            : {
                issuer,
                authorization_endpoint: `${issuer}/authorize`,
                token_endpoint: `${issuer}/token`,
                registration_endpoint: `${issuer}/register`,
                code_challenge_methods_supported: ["S256"],
              },
      }));
    await expect(oauth.discover(serverUrl)).rejects.toThrow(
      "invalid_oauth_url"
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("allows separate public resource and authorization origins", async () => {
    process.env.NODE_ENV = "production";
    const serverUrl = `https://resource.example/${crypto.randomUUID()}`;
    const issuer = "https://auth.example";
    const metadata = {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      code_challenge_methods_supported: ["S256"],
    };
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          resource: serverUrl,
          authorization_servers: [issuer],
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => metadata });
    await expect(oauth.discover(serverUrl)).resolves.toEqual(metadata);
  });
  it("preserves offline access with malformed scopes_supported", async () => {
    metadataOverrides.scopes_supported = "openid";
    const result = await start();
    expect(result.statusCode).toBe(200);
    expect(new URL(result.body.url).searchParams.get("scope")).toBe(
      "openid offline_access"
    );
  });
  it.each([1e30, 0, -1, "invalid"])(
    "ignores unusable expires_in %s",
    async (expiresIn) => {
      tokenOverrides.expires_in = expiresIn;
      const state = new URL((await start()).body.url).searchParams.get("state");
      expect((await callback(state)).location).toContain("connected=1");
      expect(
        await WorkspaceMcpConnection.find(workspace.id, "flowaccount")
      ).toMatchObject({
        access_token: "private-access-token",
        expires_at: null,
      });
    }
  );
  it("clears saved tokens if enabling connection fails", async () => {
    const state = new URL((await start()).body.url).searchParams.get("state");
    jest
      .spyOn(WorkspaceMcpConnection, "setEnabled")
      .mockRejectedValue(new Error("db failure"));
    expect((await callback(state)).location).toContain(
      "error=oauth_callback_failed"
    );
    expect(
      await WorkspaceMcpConnection.find(workspace.id, "flowaccount")
    ).toMatchObject({
      access_token: null,
      refresh_token: null,
      expires_at: null,
      enabled: false,
    });
  });
  it("guards start without login", async () => {
    expect(
      (await invoke("/mcp/oauth/start/:workspaceSlug/:serverName", {}, null))
        .statusCode
    ).toBe(401);
  });
  it("starts with registered client, PKCE S256, signed state and offline scope", async () => {
    const result = await start();
    expect(result.statusCode).toBe(200);
    const url = new URL(result.body.url);
    expect(url.searchParams.get("client_id")).toBeTruthy();
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(oauth.verifyState(url.searchParams.get("state"))).toMatchObject({
      wsSlug: workspace.slug,
      serverName: "flowaccount",
      userId: 7,
    });
  });
  it("rejects forged, expired and unknown nonce states before token exchange", async () => {
    const state = new URL((await start()).body.url).searchParams.get("state");
    const payload = oauth.verifyState(state);
    for (const invalid of [
      state + "x",
      sign({ ...payload, exp: Date.now() - 1 }),
      sign({ ...payload, nonce: "unknown" }),
    ])
      expect((await callback(invalid)).statusCode).toBe(400);
    expect(tokenRequests).toHaveLength(0);
  });
  it("saves tokens through model, enables connection and consumes state once", async () => {
    const url = new URL((await start()).body.url);
    const state = url.searchParams.get("state");
    const result = await callback(state);
    expect(result.location).toContain("connected=1");
    expect(
      await WorkspaceMcpConnection.find(workspace.id, "flowaccount")
    ).toMatchObject({
      access_token: "private-access-token",
      refresh_token: "private-refresh-token",
      enabled: true,
    });
    const verifier = tokenRequests[0].get("code_verifier");
    expect(
      crypto.createHash("sha256").update(verifier).digest("base64url")
    ).toBe(url.searchParams.get("code_challenge"));
    expect((await callback(state)).statusCode).toBe(400);
    expect(tokenRequests).toHaveLength(1);
  });
  it("returns safe provider error without tokens", async () => {
    const state = new URL((await start()).body.url).searchParams.get("state");
    const result = await callback(state, {
      error: "access_denied",
      error_description: "private-access-token",
    });
    expect(result.location).toContain("error=access_denied");
    expect(result.location).not.toContain("private-access-token");
    expect(tokenRequests).toHaveLength(0);
    expect(
      await WorkspaceMcpConnection.find(workspace.id, "flowaccount")
    ).toBeNull();
  });
  it("reuses registration, re-registers changed redirect URI and refreshes", async () => {
    const first = await oauth.ensureClient(
      origin,
      "http://localhost:3001/api/mcp/oauth/callback"
    );
    expect(await oauth.ensureClient(origin, first.redirect_uri)).toEqual(first);
    expect(registrations).toHaveLength(1);
    const changed = await oauth.ensureClient(
      origin,
      "http://localhost:3002/api/mcp/oauth/callback"
    );
    expect(changed.client_id).not.toBe(first.client_id);
    expect(registrations).toHaveLength(2);
    expect(
      await oauth.refreshTokens("private-refresh-token", origin)
    ).toMatchObject({
      access_token: "private-access-token",
      expires_at: expect.any(Date),
    });
    expect(tokenRequests[0].get("grant_type")).toBe("refresh_token");
  });
  it("accepts browser callback without session and stores encrypted pending data", async () => {
    const state = new URL((await start()).body.url).searchParams.get("state");
    const row = await prisma.lark_oauth_states.findUnique({ where: { state } });
    expect(row.mode).toBe("mcp");
    expect(row.code_verifier).not.toContain("codeVerifier");
    expect(
      (
        await invoke(
          "/mcp/oauth/callback",
          { query: { state, code: "valid-code" } },
          null
        )
      ).location
    ).toContain("connected=1");
  });
  it("requires SERVER_URL instead of trusting Host", async () => {
    delete process.env.SERVER_URL;
    try {
      expect((await start()).statusCode).toBe(500);
    } finally {
      process.env.SERVER_URL = "http://localhost:3001";
    }
  });
  it("rejects unknown or non-workspace server before registration", async () => {
    configs[0].server.anythingllm.perWorkspaceAuth = false;
    expect((await start()).statusCode).toBe(400);
    expect(registrations).toHaveLength(0);
  });
  it("rejects config URL changes during authorization", async () => {
    const state = new URL((await start()).body.url).searchParams.get("state");
    configs[0].server.url = `${origin}/different`;
    expect((await callback(state)).location).toContain(
      "error=oauth_callback_failed"
    );
    expect(tokenRequests).toHaveLength(0);
  });
  it("clears tokens and stops workspace server", async () => {
    await WorkspaceMcpConnection.saveTokens(workspace.id, "flowaccount", {
      access_token: "private-access-token",
    });
    const clear = jest.spyOn(WorkspaceMcpConnection, "clearTokens");
    const result = await invoke("/mcp/oauth/disconnect", {
      body: { workspaceSlug: workspace.slug, serverName: "flowaccount" },
    });
    expect(result.statusCode).toBe(200);
    expect(result.body.remoteRevoked).toBe(false);
    expect(clear).toHaveBeenCalledWith(workspace.id, "flowaccount");
    expect(stop).toHaveBeenCalledWith(workspace.id, "flowaccount");
    expect(
      (await WorkspaceMcpConnection.find(workspace.id, "flowaccount"))
        .access_token
    ).toBeNull();
  });
});
