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
require("../utils/lark/_polyfill");
jest.mock("../../utils/MCP", () => jest.fn());
const crypto = require("crypto");
const prisma = require("../../utils/prisma");
const Layer = require("../../utils/MCP");
const oauth = require("../../utils/MCP/oauth");
const { PersonalMcpGrant: Grant } = require("../../models/personalMcpGrant");
const { mcpOAuthEndpoints } = require("../../endpoints/mcpOAuth");
let workspace, a, b, routes, config, stop;
beforeAll(async () => {
  process.env.JWT_SECRET = "personal-state-test";
  process.env.SERVER_URL = "https://workspace.example";
  process.env.SIG_KEY ||= "test-key";
  process.env.SIG_SALT ||= "test-salt";
  workspace = await prisma.workspaces.create({
    data: { name: "Personal endpoints", slug: crypto.randomUUID() },
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
beforeEach(async () => {
  Layer.returnMCPResult = (value) => JSON.stringify(value);
  config = {
    url: "https://configurable.example/mcp",
    type: "http",
    anythingllm: { perUserAuth: true },
  };
  stop = jest.fn().mockResolvedValue();
  Layer.mockImplementation(() => ({
    findServerConfig: async () => ({ server: config }),
    probeServerConfig: jest.fn().mockResolvedValue({ tools: [{ name: "read" }] }),
    mcpServerConfigs: [{ name: "medusa", server: config }],
    workspaceServerConfigs: async () => [],
    personalRuntime: {
      stop,
      tools: async () => [{ name: "read" }],
      call: async () => ({ content: [{ text: "private-call" }] }),
    },
  }));
  jest.spyOn(oauth, "authorizeUrl").mockImplementation(async (args) => {
    const payload = {
      wsSlug: args.wsSlug,
      serverName: args.serverName,
      userId: args.userId,
      nonce: crypto.randomUUID(),
      exp: Date.now() + 600000,
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const state =
      encoded +
      "." +
      crypto
        .createHmac("sha256", process.env.JWT_SECRET)
        .update(encoded)
        .digest("base64url");
    return {
      ...payload,
      state,
      codeVerifier: "verifier",
      url: `https://store.teamredball.com/mcp-auth/authorize?state=${state}`,
    };
  });
  jest.spyOn(oauth, "exchangeCode").mockResolvedValue({
    access_token: "private-access",
    refresh_token: "private-refresh",
  });
  jest.spyOn(oauth, "revokeTokens").mockResolvedValue(true);
  routes = {};
  const register = (path, middleware, handler) =>
    (routes[path] =
      typeof middleware === "function"
        ? { middleware: [], handler: middleware }
        : { middleware, handler });
  mcpOAuthEndpoints({ get: register, post: register });
  await prisma.personal_mcp_grants.deleteMany({
    where: { workspace_id: workspace.id },
  });
});
afterEach(async () => {
  await prisma.lark_oauth_states.deleteMany({
    where: { user_id: { in: [a.id, b.id] }, mode: "mcp" },
  });
  jest.restoreAllMocks();
});
afterAll(async () => {
  await prisma.workspaces.delete({ where: { id: workspace.id } });
  for (const user of [a, b])
    await prisma.users.delete({ where: { id: user.id } });
  await prisma.$disconnect();
});
async function invoke(path, user = a, values = {}, verified = true) {
  const route = routes[path];
  expect(route).toBeDefined();
  const req = {
    params: {
      workspaceSlug: workspace.slug,
      serverName: "medusa",
      slug: workspace.slug,
      name: "medusa",
    },
    query: {},
    body: {},
    ...values,
  };
  const res = {
    locals: {
      user,
      multiUserMode: true,
      ...(verified && user ? { browserSessionUserId: user.id } : {}),
    },
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    sendStatus(code) {
      this.statusCode = code;
      return this;
    },
    end() {
      return this;
    },
    redirect(value) {
      this.location = value;
      this.statusCode = 302;
      return this;
    },
  };
  let allowed = true;
  // The browser validator is tested independently; execute real authorization guard.
  for (const middleware of route.middleware.slice(1)) {
    allowed = false;
    await middleware(req, res, () => (allowed = true));
    if (!allowed) break;
  }
  if (allowed) await route.handler(req, res);
  return res;
}
async function start(user = a) {
  const res = await invoke(
    "/mcp/oauth/start/:workspaceSlug/:serverName",
    user,
    { body: { userId: b.id } }
  );
  expect(res.statusCode).toBe(200);
  return new URL(res.body.url).searchParams.get("state");
}
async function callback(state) {
  return invoke("/mcp/oauth/callback", null, {
    query: { state, code: "valid" },
  });
}
describe("personal OAuth and member surface", () => {
  it("member direct call accepts only own advertised tools with bounded output and no management access", async () => {
    const response = await invoke(
      "/workspace/:slug/mcp-personal/:name/call",
      a,
      { body: { toolName: "read", arguments: {}, userId: b.id } }
    );
    expect(response.statusCode).toBe(200);
    expect(response.body.result).toContain("private-call");
    expect(response.body.truncated).toBe(false);
  });
  it("ordinary members connect only own grant and callback returns to member chat", async () => {
    const res = await callback(await start());
    expect(res.location).toContain(`/workspace/${workspace.slug}?`);
    expect(res.location).toContain("connected=1");
    expect(await Grant.find(workspace.id, b.id, "medusa", config)).toBeNull();
    expect(
      (await Grant.find(workspace.id, a.id, "medusa", config)).access_token
    ).toBe("private-access");
    const status = await invoke("/workspace/:slug/mcp-personal", b);
    expect(status.body.servers[0].connected).toBe(false);
    expect(JSON.stringify(status.body)).not.toContain("private-access");
  });
  it("API-key/anonymous/unverified identities fail closed", async () => {
    expect(
      (
        await invoke(
          "/mcp/oauth/start/:workspaceSlug/:serverName",
          a,
          {},
          false
        )
      ).statusCode
    ).toBe(401);
    expect(
      (await invoke("/workspace/:slug/mcp-personal", null)).statusCode
    ).toBe(401);
  });
  it.each(["membership", "suspended", "destination"])(
    "callback rechecks %s before exchange",
    async (mode) => {
      const state = await start();
      if (mode === "membership")
        await prisma.workspace_users.deleteMany({
          where: { workspace_id: workspace.id, user_id: a.id },
        });
      if (mode === "suspended")
        await prisma.users.update({
          where: { id: a.id },
          data: { suspended: 1 },
        });
      if (mode === "destination")
        config = { ...config, url: "https://changed.example/mcp" };
      const res = await callback(state);
      expect(res.location).toContain("error=oauth_callback_failed");
      expect(oauth.exchangeCode).not.toHaveBeenCalled();
      if (mode === "membership")
        await prisma.workspace_users.create({
          data: { workspace_id: workspace.id, user_id: a.id },
        });
      if (mode === "suspended")
        await prisma.users.update({
          where: { id: a.id },
          data: { suspended: 0 },
        });
    }
  );
  it("single-use callback cannot overwrite disconnect or newer reconnect", async () => {
    const state = await start();
    await invoke("/mcp/oauth/disconnect", a, {
      body: {
        workspaceSlug: workspace.slug,
        serverName: "medusa",
        userId: b.id,
      },
    });
    expect((await callback(state)).statusCode).toBe(400);
    const newer = await start();
    expect((await callback(newer)).location).toContain("connected=1");
    expect((await callback(newer)).statusCode).toBe(400);
  });
  it("revokes remotely before local clear; remote failure still clears only A", async () => {
    await callback(await start(a));
    await callback(await start(b));
    let observed;
    oauth.revokeTokens.mockImplementationOnce(async () => {
      observed = (await Grant.find(workspace.id, a.id, "medusa", config))
        .enabled;
      throw new Error("private-provider-body");
    });
    const res = await invoke("/mcp/oauth/disconnect", a, {
      body: { workspaceSlug: workspace.slug, serverName: "medusa" },
    });
    expect(observed).toBe(true);
    expect(res.body).toEqual({ success: true, remoteRevoked: false });
    expect(
      (await Grant.find(workspace.id, a.id, "medusa", config)).enabled
    ).toBe(false);
    expect(
      (await Grant.find(workspace.id, b.id, "medusa", config)).enabled
    ).toBe(true);
  });
  it("disconnect cannot clear a grant reconnected during remote revocation", async () => {
    await callback(await start());
    oauth.revokeTokens.mockImplementationOnce(async () => {
      await callback(await start());
      return true;
    });
    await invoke("/mcp/oauth/disconnect", a, {
      body: { workspaceSlug: workspace.slug, serverName: "medusa" },
    });
    expect(
      (await Grant.find(workspace.id, a.id, "medusa", config)).enabled
    ).toBe(true);
  });
  it("ordinary members cannot use the legacy workspace grant flow", async () => {
    config.anythingllm = { perWorkspaceAuth: true };
    expect(
      (await invoke("/mcp/oauth/start/:workspaceSlug/:serverName")).statusCode
    ).toBe(401);
  });
});

describe("personal API keys", () => {
  beforeEach(() => {
    config.anythingllm.personalAuth = { type: "apiKey", header: "X-API-Key" };
  });
  const keyPath = "/workspace/:slug/mcp-personal/:name/api-key";
  async function saveKey(key, user = a) {
    return invoke(keyPath, user, { body: { apiKey: key } });
  }
  it.each(["admin", "manager"])(
    "%s without explicit membership saves and disconnects only its own key",
    async (role) => {
      const user = await prisma.users.create({
        data: { username: role + crypto.randomUUID(), password: "unused", role },
      });
      try {
        expect((await saveKey("private-member-key", a)).statusCode).toBe(200);
        expect((await saveKey("private-privileged-key", user)).statusCode).toBe(
          200
        );
        expect(
          (await Grant.find(workspace.id, user.id, "medusa", config)).access_token
        ).toBe("private-privileged-key");
        expect(
          (await Grant.find(workspace.id, a.id, "medusa", config)).access_token
        ).toBe("private-member-key");
        expect(
          (await invoke("/workspace/:slug/mcp-personal", user)).body.servers[0]
            .connected
        ).toBe(true);
        const spoofed = await invoke(keyPath, user, {
          body: { apiKey: "private-spoofed-key", userId: a.id },
        });
        expect(spoofed.statusCode).toBe(400);
        expect(spoofed.body).toEqual({ error: "invalid_api_key" });
        const disconnected = await invoke("/mcp/oauth/disconnect", user, {
          body: {
            workspaceSlug: workspace.slug,
            serverName: "medusa",
            userId: a.id,
          },
        });
        expect(disconnected.body).toEqual({ success: true, remoteRevoked: false });
        expect(
          (await Grant.find(workspace.id, user.id, "medusa", config)).enabled
        ).toBe(false);
        expect(
          (await Grant.find(workspace.id, a.id, "medusa", config)).access_token
        ).toBe("private-member-key");
        expect(
          (await Grant.find(workspace.id, a.id, "medusa", config)).enabled
        ).toBe(true);
      } finally {
        await prisma.users.delete({ where: { id: user.id } });
      }
    }
  );
  it("encrypts the caller key and exposes only auth type/status", async () => {
    expect((await saveKey("private-api-key-a")).statusCode).toBe(200);
    const stored = await prisma.personal_mcp_grants.findFirst({
      where: { workspace_id: workspace.id, user_id: a.id },
    });
    expect(stored.tokens).not.toContain("private-api-key-a");
    expect(stored.tokens.split(".")).toHaveLength(3);
    expect((await Grant.find(workspace.id, a.id, "medusa", config)).access_token).toBe("private-api-key-a");
    expect(await Grant.find(workspace.id, b.id, "medusa", config)).toBeNull();
    const status = await invoke("/workspace/:slug/mcp-personal");
    expect(status.body.servers[0]).toEqual({
      name: "medusa", authType: "apiKey", accountLabel: null,
      connected: true, needsReauth: false, expiresAt: null,
    });
    expect(JSON.stringify(status.body)).not.toContain("private-api-key-a");
    expect(stop).toHaveBeenCalledWith(workspace.id, "medusa", a.id);
  });
  it("requires browser caller and rejects spoofed owner/header/url", async () => {
    expect((await invoke(keyPath, a, { body: { apiKey: "private-a" } }, false)).statusCode).toBe(401);
    for (const extra of [{ userId: b.id }, { header: "Authorization" }, { url: "https://attacker.example" }]) {
      const result = await invoke(keyPath, a, { body: { apiKey: "private-a", ...extra } });
      expect(result.statusCode).toBe(400);
      expect(result.body).toEqual({ error: "invalid_api_key" });
    }
    expect(await Grant.find(workspace.id, a.id, "medusa", config)).toBeNull();
  });
  it.each([null, "", " ", "key\r\nX-Other: value", "key\tvalue", "a".repeat(4097), "คีย์"])(
    "rejects invalid API key syntax", async (apiKey) => {
      expect((await saveKey(apiKey)).body).toEqual({ error: "invalid_api_key" });
      expect(await Grant.find(workspace.id, a.id, "medusa", config)).toBeNull();
    }
  );
  it("probes before replacement and preserves the old valid key on failure", async () => {
    await saveKey("private-valid");
    const previous = await Grant.find(workspace.id, a.id, "medusa", config);
    const probe = jest.fn().mockRejectedValue(new Error("private-bad-key"));
    Layer.mockImplementationOnce(() => ({
      findServerConfig: async () => ({ server: config }),
      probeServerConfig: probe,
      personalRuntime: { stop },
    }));
    const failed = await saveKey("private-bad-key");
    expect(failed.statusCode).toBe(400);
    expect(JSON.stringify(failed.body)).not.toContain("private-bad-key");
    const current = await Grant.find(workspace.id, a.id, "medusa", config);
    expect(current.access_token).toBe("private-valid");
    expect(current.version).toBe(previous.version);
    expect(current.enabled).toBe(true);
    expect(probe).toHaveBeenCalledWith(config, { accessToken: "private-bad-key" });
  });
  it("rejects OAuth targets and never starts OAuth or revokes an API key", async () => {
    config.anythingllm.personalAuth = { type: "oauth" };
    expect((await saveKey("private-key")).body).toEqual({ error: "invalid_target" });
    config.anythingllm.personalAuth = { type: "apiKey", header: "X-API-Key" };
    expect((await invoke("/mcp/oauth/start/:workspaceSlug/:serverName")).statusCode).toBe(400);
    expect(oauth.authorizeUrl).not.toHaveBeenCalled();
    await saveKey("private-key");
    const disconnected = await invoke("/mcp/oauth/disconnect", a, {
      body: { workspaceSlug: workspace.slug, serverName: "medusa" },
    });
    expect(disconnected.body).toEqual({ success: true, remoteRevoked: false });
    expect(oauth.revokeTokens).not.toHaveBeenCalled();
    expect((await Grant.find(workspace.id, a.id, "medusa", config)).enabled).toBe(false);
  });
  it("rejects a pending first connection after caller disconnects", async () => {
    Layer.mockImplementationOnce(() => ({
      findServerConfig: async () => ({ server: config }),
      probeServerConfig: async () => {
        await invoke("/mcp/oauth/disconnect", a, {
          body: { workspaceSlug: workspace.slug, serverName: "medusa" },
        });
      },
      personalRuntime: { stop },
    }));
    expect((await saveKey("private-pending")).statusCode).toBe(409);
    expect((await Grant.find(workspace.id, a.id, "medusa", config)).enabled).toBe(false);
  });
  it("a slow replacement cannot overwrite a newer key", async () => {
    await saveKey("private-old");
    Layer.mockImplementationOnce(() => ({
      findServerConfig: async () => ({ server: config }),
      probeServerConfig: async () => {
        expect((await saveKey("private-newer")).statusCode).toBe(200);
      },
      personalRuntime: { stop },
    }));
    expect((await saveKey("private-slow")).statusCode).toBe(409);
    expect((await Grant.find(workspace.id, a.id, "medusa", config)).access_token).toBe("private-newer");
  });
  it("rechecks membership after a successful probe", async () => {
    Layer.mockImplementationOnce(() => ({
      findServerConfig: async () => ({ server: config }),
      probeServerConfig: async () => {
        await prisma.workspace_users.deleteMany({ where: { workspace_id: workspace.id, user_id: a.id } });
      },
      personalRuntime: { stop },
    }));
    try {
      expect((await saveKey("private-no-member")).statusCode).toBe(401);
      expect((await Grant.find(workspace.id, a.id, "medusa", config)).enabled).toBe(false);
    } finally {
      await prisma.workspace_users.create({ data: { workspace_id: workspace.id, user_id: a.id } });
    }
  });
  it("rechecks definition fingerprint after a successful probe", async () => {
    Layer.mockImplementationOnce(() => ({
      findServerConfig: async () => ({ server: config }),
      probeServerConfig: async () => {
        config = { ...config, url: "https://replacement.example/mcp" };
      },
      personalRuntime: { stop },
    }));
    expect((await saveKey("private-stale-config")).statusCode).toBe(409);
    const stored = await prisma.personal_mcp_grants.findFirst({ where: { workspace_id: workspace.id, user_id: a.id } });
    expect(stored.tokens).toBeNull();
  });
});
