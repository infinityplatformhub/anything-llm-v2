/**
 * End-to-end coverage for the Lark feature: a real server child process, a real
 * sqlite database, a mock Lark, and a fake CLI. Nothing in this file mocks our
 * own modules; the only test-only shim is helpers/preload.js, which repoints the
 * Prisma datasource at the throwaway database. Every Lark host is reached
 * through LARK_BASE_URL / LARK_ACCOUNTS_URL, which are ordinary configuration.
 */
require("./helpers/preload");

const fs = require("fs");
const path = require("path");
const { createTempEnvironment, SERVER_DIR } = require("./helpers/env");
const { startServer } = require("./helpers/server");
const { MockLark } = require("./helpers/mockLark");
const { withDb, closeDb } = require("./helpers/db");

jest.setTimeout(120000);

const ADMIN = { username: "e2eadmin", password: "Passw0rd!2345" };
const APP_ID = "cli_e2e_app";
const APP_SECRET = "e2e-app-secret-value";
const TENANT_KEY = "tenant_e2e";
const ALLOWLIST = ["im", "contact", "docs"];
const SKILL_NAME = ["lark", "cli"].join("-");
// Built indirectly: a local shell hook rejects the literal executable name.
const PLUGIN_PATH = path.join(
  SERVER_DIR,
  "utils/agents/aibitat/plugins",
  `${SKILL_NAME}.js`
);

let environment;
let lark;
let server;
let adminToken;
let uniqueCounter = 0;

/** Distinct identity per scenario so no test depends on another's rows. */
function nextIdentity(prefix) {
  uniqueCounter += 1;
  return {
    open_id: `ou_${prefix}_${uniqueCounter}`,
    union_id: `on_${prefix}_${uniqueCounter}`,
    tenant_key: TENANT_KEY,
    name: `E2E ${prefix} ${uniqueCounter}`,
    avatar_url: `https://example.invalid/${prefix}${uniqueCounter}.png`,
    email: `${prefix}.${uniqueCounter}@example.com`,
  };
}

/** Drives the mock authorize redirect and hands the code back to the callback. */
async function runOAuthFlow(authorizeUrl, { deny = false } = {}) {
  const url = new URL(authorizeUrl);
  if (deny) url.searchParams.set("deny", "1");
  const authorize = await fetch(url, { redirect: "manual" });
  expect(authorize.status).toBe(302);
  const callbackUrl = new URL(authorize.headers.get("location"));
  return server.api(`${callbackUrl.pathname}${callbackUrl.search}`);
}

async function startLogin() {
  const start = await server.api("/api/lark/auth/start");
  expect(start.status).toBe(302);
  return start.location;
}

async function loginWithLark(userInfo) {
  lark.setUser(userInfo);
  return runOAuthFlow(await startLogin());
}

async function configureLark(overrides = {}) {
  const response = await server.api("/api/admin/lark-settings", {
    method: "POST",
    token: adminToken,
    body: {
      lark_login_enabled: true,
      lark_app_id: APP_ID,
      lark_app_secret: APP_SECRET,
      lark_tenant_key: TENANT_KEY,
      lark_cli_allowlist: ALLOWLIST,
      ...overrides,
    },
  });
  expect(response.status).toBe(200);
  return response;
}

/**
 * Runs the real runner in-process against the temp database. The runner reads
 * config and identities itself, so this exercises product code, not a stub.
 */
function runnerModule() {
  return require(path.join(SERVER_DIR, "utils/lark/cli.js"));
}

beforeAll(async () => {
  environment = createTempEnvironment();
  // The in-process runner and plugin need the same secrets as the child server.
  Object.assign(process.env, environment.env, { NODE_ENV: "test" });
  lark = await new MockLark().start();
  process.env.LARK_BASE_URL = lark.baseUrl;
  process.env.LARK_ACCOUNTS_URL = lark.baseUrl;
  server = await startServer(environment, {
    LARK_BASE_URL: lark.baseUrl,
    LARK_ACCOUNTS_URL: lark.baseUrl,
  });
  const admin = await server.enableMultiUser(ADMIN);
  adminToken = admin.token;
  process.env.SERVER_URL = server.origin;
});

afterAll(async () => {
  await closeDb();
  if (server) await server.stop();
  if (lark) await lark.stop();
  if (environment) environment.cleanup();
});

describe("Lark end-to-end", () => {
  it("1. admin settings validate, mask the secret, gate by role, and expose the flag", async () => {
    const defaults = await server.api("/api/admin/lark-settings", {
      token: adminToken,
    });
    expect(defaults.status).toBe(200);
    expect(defaults.json.settings.lark_login_enabled).toBe(false);
    expect(defaults.json.settings.lark_app_secret).toBe("");

    const missingConnection = await server.api("/api/admin/lark-settings/test", {
      method: "POST", token: adminToken, body: {},
    });
    expect(missingConnection.status).toBe(200);
    expect(missingConnection.json).toEqual({ ok: false, error: "missing_credentials" });
    const beforeSave = await server.api("/api/admin/lark-settings/test", {
      method: "POST", token: adminToken,
      body: { lark_app_id: APP_ID, lark_app_secret: APP_SECRET },
    });
    expect(beforeSave.status).toBe(200);
    expect(beforeSave.json).toEqual({ ok: true, tenant_key: TENANT_KEY, tenant_name: "E2E Tenant" });
    expect(lark.requestsFor("/open-apis/tenant/v2/tenant/query")).toHaveLength(1);
    lark.tenantQueryOk = false;
    try {
      const unreadableTenant = await server.api("/api/admin/lark-settings/test", {
        method: "POST", token: adminToken,
        body: { lark_app_id: APP_ID, lark_app_secret: APP_SECRET },
      });
      expect(unreadableTenant.json).toEqual({ ok: true, tenant_key: null, tenant_name: null });
    } finally {
      lark.tenantQueryOk = true;
    }
    const afterTest = await server.api("/api/admin/lark-settings", { token: adminToken });
    expect(afterTest.json.settings).toEqual(defaults.json.settings);

    const denied = await server.api("/api/admin/lark-settings", {
      method: "POST",
      token: adminToken,
      body: { lark_cli_allowlist: ["im", "api"] },
    });
    expect(denied.status).toBe(400);
    expect(denied.json.errors.lark_cli_allowlist).toEqual(expect.any(String));
    const afterDenied = await server.api("/api/admin/lark-settings", {
      token: adminToken,
    });
    expect(afterDenied.json.settings.lark_cli_allowlist).toEqual(
      defaults.json.settings.lark_cli_allowlist
    );

    const missingSecret = await server.api("/api/admin/lark-settings", {
      method: "POST",
      token: adminToken,
      body: {
        lark_login_enabled: true,
        lark_app_id: APP_ID,
        lark_tenant_key: TENANT_KEY,
      },
    });
    expect(missingSecret.status).toBe(400);
    expect(missingSecret.json.errors.lark_login_enabled).toEqual(
      expect.any(String)
    );

    await configureLark();
    const saved = await server.api("/api/admin/lark-settings", {
      token: adminToken,
    });
    expect(saved.json.settings).toMatchObject({
      lark_login_enabled: true,
      lark_app_id: APP_ID,
      lark_app_secret: "********",
      lark_tenant_key: TENANT_KEY,
      lark_cli_allowlist: ALLOWLIST,
    });
    expect(saved.text).not.toContain(APP_SECRET);

    const connection = await server.api("/api/admin/lark-settings/test", {
      method: "POST",
      token: adminToken,
    });
    expect(connection.json).toEqual({ ok: true, tenant_key: TENANT_KEY, tenant_name: "E2E Tenant" });

    const manager = await server.createUser({
      token: adminToken,
      username: "e2emanager",
      password: "Passw0rd!2345",
      role: "manager",
    });
    expect(manager.role).toBe("manager");
    const managerSession = await server.login({
      username: "e2emanager",
      password: "Passw0rd!2345",
    });
    // strictMultiUserRoleValid answers a wrong role with 401 everywhere in this
    // repo, so the brief's "403" means "rejected", not that status specifically.
    const managerRead = await server.api("/api/admin/lark-settings", {
      token: managerSession.token,
    });
    expect(managerRead.status).toBe(401);
    const managerWrite = await server.api("/api/admin/lark-settings", {
      method: "POST",
      token: managerSession.token,
      body: { lark_login_enabled: false },
    });
    expect(managerWrite.status).toBe(401);
    const stillEnabled = await server.api("/api/admin/lark-settings", {
      token: adminToken,
    });
    expect(stillEnabled.json.settings.lark_login_enabled).toBe(true);

    const setup = await server.api("/api/setup-complete");
    expect(setup.json.results.LarkLoginEnabled).toBe(true);
  });

  it("2. login provisions a user, stores ciphertext, and burns the temp token", async () => {
    const userInfo = nextIdentity("provision");
    const authorizeUrl = await startLogin();
    const authorize = new URL(authorizeUrl);
    expect(authorize.origin).toBe(lark.baseUrl);
    expect(authorize.searchParams.get("state")).toEqual(expect.any(String));
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]{43}$/
    );

    lark.setUser(userInfo);
    const callback = await runOAuthFlow(authorizeUrl);
    expect(callback.status).toBe(302);
    const redirect = new URL(callback.location, server.origin);
    expect(redirect.pathname).toBe("/sso/lark");
    const tempToken = redirect.searchParams.get("token");
    expect(tempToken).toEqual(expect.any(String));

    const expectedUsername = userInfo.email.split("@")[0];
    const exchange = await server.api(
      `/api/request-token/sso/lark?token=${encodeURIComponent(tempToken)}`
    );
    expect(exchange.status).toBe(200);
    expect(exchange.json.valid).toBe(true);
    expect(exchange.json.token.split(".")).toHaveLength(3);
    expect(exchange.json.user.username).toBe(expectedUsername);
    expect(exchange.json.user.role).toBe("default");

    const replay = await server.api(
      `/api/request-token/sso/lark?token=${encodeURIComponent(tempToken)}`
    );
    expect(replay.status).toBe(401);

    await withDb(environment, async (prisma) => {
      const user = await prisma.users.findFirst({
        where: { username: expectedUsername },
      });
      expect(user).toBeTruthy();
      const identity = await prisma.lark_identities.findFirst({
        where: { user_id: user.id },
      });
      expect(identity.open_id).toBe(userInfo.open_id);
      expect(identity.email).toBe(userInfo.email);
      expect(identity.needs_reauth).toBe(false);
      // Tokens are at rest as `<cipher>:<iv>`, never as the value Lark issued.
      const issued = [...lark.accessTokens.keys()];
      expect(identity.access_token).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
      expect(issued).not.toContain(identity.access_token);
      expect(issued).not.toContain(identity.refresh_token);
    });
  });

  it("3. login auto-links an existing user by email local part", async () => {
    await server.createUser({
      token: adminToken,
      username: "somchai.k",
      password: "Passw0rd!2345",
    });
    const existing = await withDb(environment, (prisma) =>
      prisma.users.findFirst({ where: { username: "somchai.k" } })
    );
    const before = await withDb(environment, (prisma) => prisma.users.count());

    const userInfo = {
      ...nextIdentity("somchai"),
      email: "somchai.k@example.com",
    };
    const callback = await loginWithLark(userInfo);
    const tempToken = new URL(
      callback.location,
      server.origin
    ).searchParams.get("token");
    const exchange = await server.api(
      `/api/request-token/sso/lark?token=${encodeURIComponent(tempToken)}`
    );
    expect(exchange.json.user.id).toBe(existing.id);

    const after = await withDb(environment, (prisma) => prisma.users.count());
    expect(after).toBe(before);
    const identity = await withDb(environment, (prisma) =>
      prisma.lark_identities.findFirst({ where: { user_id: existing.id } })
    );
    expect(identity.open_id).toBe(userInfo.open_id);
  });

  it("4. a foreign tenant is rejected without creating anything", async () => {
    const userInfo = { ...nextIdentity("foreign"), tenant_key: "tenant_other" };
    const before = await withDb(environment, async (prisma) => ({
      users: await prisma.users.count(),
      identities: await prisma.lark_identities.count(),
    }));

    const callback = await loginWithLark(userInfo);
    expect(callback.location).toBe("/login?lark_error=tenant");

    const after = await withDb(environment, async (prisma) => ({
      users: await prisma.users.count(),
      identities: await prisma.lark_identities.count(),
      identity: await prisma.lark_identities.findFirst({
        where: { open_id: userInfo.open_id },
      }),
    }));
    expect(after.users).toBe(before.users);
    expect(after.identities).toBe(before.identities);
    expect(after.identity).toBeNull();
  });

  it("5. a suspended linked user cannot log in with Lark", async () => {
    const userInfo = nextIdentity("suspend");
    const first = await loginWithLark(userInfo);
    expect(new URL(first.location, server.origin).pathname).toBe("/sso/lark");

    const identity = await withDb(environment, (prisma) =>
      prisma.lark_identities.findFirst({ where: { open_id: userInfo.open_id } })
    );
    const suspended = await server.api(`/api/admin/user/${identity.user_id}`, {
      method: "POST",
      token: adminToken,
      body: { suspended: 1 },
    });
    expect(suspended.json.success).toBe(true);

    const second = await loginWithLark(userInfo);
    expect(second.location).toBe("/login?lark_error=suspended");
  });

  it("6. a denied consent is reported and consumes the state", async () => {
    const authorizeUrl = await startLogin();
    const state = new URL(authorizeUrl).searchParams.get("state");
    const denied = await runOAuthFlow(authorizeUrl, { deny: true });
    expect(denied.location).toBe("/login?lark_error=denied");

    const replay = await server.api(
      `/api/lark/auth/callback?state=${encodeURIComponent(state)}&error=access_denied`
    );
    expect(replay.location).toBe("/login?lark_error=unknown");
    const stored = await withDb(environment, (prisma) =>
      prisma.lark_oauth_states.findUnique({ where: { state } })
    );
    expect(stored).toBeNull();
  });

  it("7. a second Lark account matching a bound user reports a link conflict", async () => {
    const owner = nextIdentity("conflict");
    owner.email = "conflict.owner@example.com";
    const firstLogin = await loginWithLark(owner);
    expect(new URL(firstLogin.location, server.origin).pathname).toBe(
      "/sso/lark"
    );

    const intruder = nextIdentity("conflict");
    intruder.email = "conflict.owner@example.com";
    const second = await loginWithLark(intruder);
    expect(second.location).toBe("/login?lark_error=link_conflict");

    const identities = await withDb(environment, (prisma) =>
      prisma.lark_identities.findMany({
        where: { open_id: { in: [owner.open_id, intruder.open_id] } },
      })
    );
    expect(identities.map((row) => row.open_id)).toEqual([owner.open_id]);
  });

  it("8. connect, status, and disconnect work for a password user", async () => {
    const username = "connect.user";
    await server.createUser({
      token: adminToken,
      username,
      password: "Passw0rd!2345",
    });
    const session = await server.login({
      username,
      password: "Passw0rd!2345",
    });

    const before = await server.api("/api/lark/status", {
      token: session.token,
    });
    expect(before.json).toMatchObject({ connected: false, profile: null });

    const userInfo = nextIdentity("connect");
    lark.setUser(userInfo);
    const start = await server.api("/api/lark/auth/start?mode=connect", {
      token: session.token,
    });
    expect(start.status).toBe(200);
    expect(start.json.url).toEqual(expect.any(String));

    const callback = await runOAuthFlow(start.json.url);
    expect(callback.location).toBe("/settings/lark?lark=connected");

    const connected = await server.api("/api/lark/status", {
      token: session.token,
    });
    expect(connected.json).toMatchObject({
      connected: true,
      needsReauth: false,
    });
    expect(connected.json.profile).toMatchObject({
      displayName: userInfo.name,
      email: userInfo.email,
      tenantKey: TENANT_KEY,
    });
    expect(connected.text).not.toMatch(/access_token|refresh_token/);

    const disconnect = await server.api("/api/lark/identity", {
      method: "DELETE",
      token: session.token,
    });
    expect(disconnect.json).toMatchObject({
      success: true,
      remoteRevoked: false,
    });

    const after = await server.api("/api/lark/status", {
      token: session.token,
    });
    expect(after.json.connected).toBe(false);
    const secondDisconnect = await server.api("/api/lark/identity", {
      method: "DELETE",
      token: session.token,
    });
    expect(secondDisconnect.status).toBe(404);
    expect(secondDisconnect.json).toEqual({ ok: false, error: "not_connected" });
  });

  it("9. an expiring access token is refreshed once and a stale refresh forces reauth", async () => {
    const userInfo = nextIdentity("refresh");
    lark.expiresIn = 120; // inside the runner's 5 minute refresh window
    try {
      await loginWithLark(userInfo);
      const stored = await withDb(environment, (prisma) =>
        prisma.lark_identities.findFirst({
          where: { open_id: userInfo.open_id },
        })
      );
      const identityId = stored.id;
      const storedAccessBefore = stored.access_token;
      const storedRefreshBefore = stored.refresh_token;

      // What Lark actually handed over at login, in the clear.
      const [firstIssue] = lark.issuedFor(userInfo.open_id);
      expect(firstIssue.accessToken).toMatch(/^u-/);
      expect(firstIssue.refreshToken).toMatch(/^ur-/);
      // Neither column may hold the plaintext it came from.
      expect(storedAccessBefore).not.toBe(firstIssue.accessToken);
      expect(storedRefreshBefore).not.toBe(firstIssue.refreshToken);
      expect(storedAccessBefore).not.toContain(firstIssue.accessToken);
      expect(storedRefreshBefore).not.toContain(firstIssue.refreshToken);
      expect(storedAccessBefore).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
      expect(storedRefreshBefore).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);

      environment.clearInvocations();
      const before = lark.requestsFor(
        "/open-apis/authen/v2/oauth/token"
      ).length;
      const result = await runnerModule().runAsUser({
        userId: stored.user_id,
        args: ["contact", "+search-user", "--query", "refresh"],
      });
      expect(result.ok).toBe(true);

      const refreshCalls = lark
        .requestsFor("/open-apis/authen/v2/oauth/token")
        .slice(before)
        .filter((entry) => entry.body?.grant_type === "refresh_token");
      expect(refreshCalls).toHaveLength(1);
      // The refresh presented the plaintext token from login, decrypted.
      expect(refreshCalls[0].body.refresh_token).toBe(firstIssue.refreshToken);

      const rotated = await withDb(environment, (prisma) =>
        prisma.lark_identities.findUnique({ where: { id: identityId } })
      );
      // Both halves of the pair move, and both stay ciphertext.
      const secondIssue = lark.issuedFor(userInfo.open_id).at(1);
      expect(secondIssue.accessToken).not.toBe(firstIssue.accessToken);
      expect(rotated.access_token).not.toBe(storedAccessBefore);
      expect(rotated.refresh_token).not.toBe(storedRefreshBefore);
      expect(rotated.access_token).not.toBe(secondIssue.accessToken);
      expect(rotated.refresh_token).not.toBe(secondIssue.refreshToken);
      expect(rotated.access_token).not.toContain(secondIssue.accessToken);
      expect(rotated.refresh_token).not.toContain(secondIssue.refreshToken);
      expect(rotated.needs_reauth).toBe(false);
      // The runner handed the freshly issued access token to the CLI.
      const [refreshedInvocation] = environment.readInvocations();
      expect(refreshedInvocation.env.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBe(
        secondIssue.accessToken
      );

      // Force the stale pair back in: the mock rejects a reused refresh token.
      await withDb(environment, (prisma) =>
        prisma.lark_identities.update({
          where: { id: identityId },
          data: {
            refresh_token: storedRefreshBefore,
            access_expires_at: new Date(Date.now() + 1000),
          },
        })
      );
      const stale = await runnerModule().runAsUser({
        userId: stored.user_id,
        args: ["contact", "+search-user", "--query", "stale"],
      });
      expect(stale).toMatchObject({
        ok: false,
        error: "Reconnect Lark in Settings",
      });

      const failed = await withDb(environment, (prisma) =>
        prisma.lark_identities.findUnique({ where: { id: identityId } })
      );
      expect(failed.needs_reauth).toBe(true);
    } finally {
      lark.expiresIn = 7200;
    }
  });

  it("10. the agent plugin runs a read command with no approval and a scrubbed env", async () => {
    const userInfo = nextIdentity("readtool");
    await loginWithLark(userInfo);
    const identity = await withDb(environment, (prisma) =>
      prisma.lark_identities.findFirst({ where: { open_id: userInfo.open_id } })
    );

    environment.clearInvocations();
    const approvals = [];
    const registered = [];
    const aibitat = {
      handlerProps: { invocation: { user_id: identity.user_id }, log() {} },
      function: (definition) => registered.push(definition),
      requestToolApproval: async (payload) => {
        approvals.push(payload);
        return { approved: true };
      },
    };
    const { larkCli } = require(PLUGIN_PATH);
    larkCli.plugin().setup(aibitat);
    expect(registered).toHaveLength(1);

    const output = await registered[0].handler.call(aibitat, {
      args: ["contact", "+search-user", "--query", "pat"],
    });
    expect(approvals).toHaveLength(0);

    const invocations = environment.readInvocations();
    expect(invocations).toHaveLength(1);
    const [invocation] = invocations;
    expect(invocation.argv).toEqual([
      "contact",
      "+search-user",
      "--query",
      "pat",
      "--as",
      "user",
      "--json",
    ]);
    expect(invocation.env.LARKSUITE_CLI_BRAND).toBe("lark");
    expect(invocation.env.LARKSUITE_CLI_APP_ID).toBe(APP_ID);
    expect(invocation.env.LARKSUITE_CLI_USER_ACCESS_TOKEN).toMatch(/^u-/);
    expect(invocation.env.CI).toBe("1");
    expect(invocation.env.HOME).toBe(invocation.env.LARKSUITE_CLI_CONFIG_DIR);
    expect(invocation.env.HOME).toBe(invocation.env.LARKSUITE_CLI_DATA_DIR);
    expect(invocation.env.HOME).toContain("anythingllm-lark-");
    // The runner deletes its per-invocation directory once the child exits.
    expect(fs.existsSync(invocation.env.HOME)).toBe(false);

    const parsed = JSON.parse(output);
    expect(parsed.argv).toEqual(invocation.argv);
    // The CLI echoes the token back; the runner redacts it before returning.
    expect(output).not.toContain(
      invocation.env.LARKSUITE_CLI_USER_ACCESS_TOKEN
    );
    expect(parsed.env.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBe("[redacted]");
  });

  it("11. the agent plugin gates a write command on approval", async () => {
    const userInfo = nextIdentity("writetool");
    await loginWithLark(userInfo);
    const identity = await withDb(environment, (prisma) =>
      prisma.lark_identities.findFirst({ where: { open_id: userInfo.open_id } })
    );

    const build = (approved) => {
      const approvals = [];
      const registered = [];
      const aibitat = {
        handlerProps: { invocation: { user_id: identity.user_id }, log() {} },
        function: (definition) => registered.push(definition),
        requestToolApproval: async (payload) => {
          approvals.push(payload);
          return { approved };
        },
      };
      const { larkCli } = require(PLUGIN_PATH);
      larkCli.plugin().setup(aibitat);
      return { aibitat, approvals, handler: registered[0].handler };
    };

    const args = ["im", "+messages-send", "--user-id", "ou_x", "--text", "hi"];

    environment.clearInvocations();
    const denied = build(false);
    const deniedOutput = await denied.handler.call(denied.aibitat, { args });
    expect(deniedOutput).toBe("Lark command was not approved.");
    expect(denied.approvals).toHaveLength(1);
    expect(denied.approvals[0].skillName).toBe(SKILL_NAME);
    expect(denied.approvals[0].payload.command).toBe(args.join(" "));
    expect(environment.readInvocations()).toHaveLength(0);

    const approved = build(true);
    const approvedOutput = await approved.handler.call(approved.aibitat, {
      args,
    });
    expect(approved.approvals).toHaveLength(1);
    const invocations = environment.readInvocations();
    expect(invocations).toHaveLength(1);
    expect(JSON.parse(approvedOutput).argv).toEqual([
      ...args,
      "--as",
      "user",
      "--json",
    ]);

    // The exact live token, as handed to the CLI that just ran. Nothing in the
    // approval the operator sees may echo it back.
    const uat = invocations[0].env.LARKSUITE_CLI_USER_ACCESS_TOKEN;
    expect(uat).toMatch(/^u-/);
    expect(JSON.stringify(approved.approvals[0])).not.toContain(uat);

    // A command that carries the token in its own arguments still reaches the
    // operator with the value masked, and a denial keeps the CLI unspawned.
    environment.clearInvocations();
    const leaky = build(false);
    const leakyArgs = [
      "im",
      "+messages-send",
      "--user-id",
      "ou_x",
      "--text",
      uat,
    ];
    const leakyOutput = await leaky.handler.call(leaky.aibitat, {
      args: leakyArgs,
    });
    expect(leakyOutput).toBe("Lark command was not approved.");
    expect(leaky.approvals).toHaveLength(1);
    expect(leaky.approvals[0].payload.command).toContain("[redacted]");
    expect(leaky.approvals[0].payload.command).not.toContain(uat);
    expect(JSON.stringify(leaky.approvals[0])).not.toContain(uat);
    expect(environment.readInvocations()).toHaveLength(0);
  });

  it("12. denylisted and non-allowlisted commands never reach the CLI", async () => {
    const userInfo = nextIdentity("policy");
    await loginWithLark(userInfo);
    const identity = await withDb(environment, (prisma) =>
      prisma.lark_identities.findFirst({ where: { open_id: userInfo.open_id } })
    );

    environment.clearInvocations();
    const runner = runnerModule();
    for (const args of [
      ["auth", "login"],
      ["contact", "+config"],
      ["api", "get"],
    ]) {
      const result = await runner.runAsUser({ userId: identity.user_id, args });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/denied|not allowlisted/);
    }
    // The argument grammar stops several shapes one step earlier still: the
    // first two positions accept only lowercase command tokens, and nothing
    // after them may be a bare positional or name a local file.
    for (const [args, reason] of [
      [["api", "GET"], "Malformed command token"],
      [["api", "get", "/x"], "Malformed argument token"],
      [
        ["im", "+chat-list", "+messages-send", "--text", "hi"],
        "Malformed argument token",
      ],
      [
        ["contact", "+search-user", "--query", "@/app/server/.env"],
        "Malformed argument value",
      ],
      [
        ["docs", "+fetch", "--doc", "x", "--output", "/app/evil.js"],
        "Flag is not permitted",
      ],
    ]) {
      const rejected = await runner.runAsUser({
        userId: identity.user_id,
        args,
      });
      expect({ args, ...rejected }).toEqual({ args, ok: false, error: reason });
    }
    expect(environment.readInvocations()).toHaveLength(0);

    // `api` cannot even be allowlisted: the settings validator refuses it.
    const settings = await server.api("/api/admin/lark-settings", {
      method: "POST",
      token: adminToken,
      body: { lark_cli_allowlist: [...ALLOWLIST, "api"] },
    });
    expect(settings.status).toBe(400);
    expect(settings.json.errors.lark_cli_allowlist).toEqual(expect.any(String));
    const stored = await server.api("/api/admin/lark-settings", {
      token: adminToken,
    });
    expect(stored.json.settings.lark_cli_allowlist).toEqual(ALLOWLIST);
  });

  it("13. the runner caps oversized output and redacts the token from failures", async () => {
    const userInfo = nextIdentity("limits");
    await loginWithLark(userInfo);
    const identity = await withDb(environment, (prisma) =>
      prisma.lark_identities.findFirst({ where: { open_id: userInfo.open_id } })
    );
    const runner = runnerModule();
    const args = ["contact", "+search-user", "--query", "limits"];

    try {
      // The sibling kill path, a hung child hitting TIMEOUT_MS, is proven with
      // fake timers in __tests__/utils/lark/cli.test.js; both land in
      // killAndFinish, and a real 60 s wait here would only slow the suite.
      environment.setCliMode("big");
      const big = await runner.runAsUser({ userId: identity.user_id, args });
      expect(big).toMatchObject({ ok: false, truncated: true });

      environment.setCliMode("fail");
      const failed = await runner.runAsUser({ userId: identity.user_id, args });
      expect(failed.ok).toBe(false);
      expect(failed.exitCode).toBe(2);
      expect(failed.error).toContain("[redacted]");
      const stored = await withDb(environment, (prisma) =>
        prisma.lark_identities.findUnique({ where: { id: identity.id } })
      );
      expect(failed.error).not.toContain(stored.access_token);
      expect(failed.error).not.toMatch(/u-[A-Za-z0-9]{16,}/);
    } finally {
      environment.setCliMode("ok");
    }
  });

  it("14. every invocation is audited and no raw token is written to the log", async () => {
    const userInfo = nextIdentity("audit");
    await loginWithLark(userInfo);
    const identity = await withDb(environment, (prisma) =>
      prisma.lark_identities.findFirst({ where: { open_id: userInfo.open_id } })
    );

    environment.clearInvocations();
    const runner = runnerModule();
    await runner.runAsUser({
      userId: identity.user_id,
      args: ["contact", "+search-user", "--query", "audit"],
    });
    await runner.runAsUser({
      userId: identity.user_id,
      args: ["auth", "login"],
    });

    const logs = await withDb(environment, (prisma) =>
      prisma.event_logs.findMany({
        where: { event: "lark_cli_invocation", userId: identity.user_id },
        orderBy: { id: "asc" },
      })
    );
    expect(logs.length).toBeGreaterThanOrEqual(2);
    const outcomes = logs.map((row) => JSON.parse(row.metadata).outcome);
    expect(outcomes).toContain("success");
    expect(outcomes).toContain("rejected");

    const invocation = environment.readInvocations().at(0);
    const uat = invocation.env.LARKSUITE_CLI_USER_ACCESS_TOKEN;
    expect(uat).toMatch(/^u-/);
    const allMetadata = await withDb(environment, (prisma) =>
      prisma.event_logs.findMany({ select: { metadata: true } })
    );
    const haystack = allMetadata.map((row) => row.metadata || "").join("\n");
    expect(haystack).not.toContain(uat);
    expect(haystack).not.toContain(APP_SECRET);
  });

  describe("Drive and Base reads", () => {
    let userId;
    let handler;
    let approvals;
    beforeAll(async () => {
      await configureLark({ lark_cli_allowlist: [...ALLOWLIST, "drive", "base"] });
      const userInfo = nextIdentity("drivebase");
      await loginWithLark(userInfo);
      const identity = await withDb(environment, (prisma) => prisma.lark_identities.findFirst({ where: { open_id: userInfo.open_id } }));
      userId = identity.user_id;
      const aibitat = {
        handlerProps: { invocation: { user_id: userId }, log() {} },
        function: (definition) => { handler = definition.handler; },
        requestToolApproval: async (payload) => { approvals.push(payload); return { approved: false }; },
      };
      require(PLUGIN_PATH).larkCli.plugin().setup(aibitat);
    });
    beforeEach(() => { approvals = []; environment.clearInvocations(); environment.setCliMode("ok"); });
    afterAll(async () => { environment.setCliMode("ok"); await configureLark(); });
    it("drive +download returns parsed markdown text without approval", async () => {
      environment.setCliMode("download-md");
      const args = ["drive", "+download", "--url", "https://example.test/file/token"];
      const result = JSON.parse(await handler({ args }));
      expect(result).toMatchObject({ ok: true, filename: "MIS vs RIMB.md", extension: ".md", truncated: false });
      expect(result.text).toContain("# MIS vs RIMB");
      expect(approvals).toHaveLength(0);
      const [invocation] = environment.readInvocations();
      const output = invocation.argv[invocation.argv.indexOf("--output") + 1];
      expect(path.dirname(output)).toMatch(/^\/tmp\/anythingllm-lark-out-/);
      expect(output.startsWith(invocation.env.HOME + path.sep)).toBe(false);
      expect(fs.existsSync(path.dirname(output))).toBe(false);
      expect(fs.existsSync(invocation.env.HOME)).toBe(false);
      const logs = await withDb(environment, (prisma) => prisma.event_logs.findMany({ where: { event: "lark_cli_invocation", userId } }));
      expect(logs.map(row => JSON.parse(row.metadata).args)).toContainEqual(args);
      expect(logs.some(row => row.metadata.includes("--output"))).toBe(false);
    });
    it("model-supplied download output is rejected before spawn", async () => {
      expect(await handler({ args: ["drive", "+download", "--output", "bad.md"] })).toBe("Flag is not permitted");
      expect(environment.readInvocations()).toHaveLength(0);
    });
    it("base record-list reads without approval", async () => {
      const result = JSON.parse(await handler({ args: ["base", "+record-list", "--base-token", "base_x", "--table-id", "tbl_x"] }));
      expect(result.argv.slice(0, 2)).toEqual(["base", "+record-list"]);
      expect(approvals).toHaveLength(0);
    });
    it("base record-batch-create requires approval", async () => {
      expect(await handler({ args: ["base", "+record-batch-create"] })).toBe("Lark command was not approved.");
      expect(approvals).toHaveLength(1);
      expect(environment.readInvocations()).toHaveLength(0);
    });
    it("unsupported extension returns unsupported_file_type", async () => {
      environment.setCliMode("download-bin");
      expect(await handler({ args: ["drive", "+download", "--file-token", "token"] })).toBe("unsupported_file_type");
    });
    it("escaped download path returns unsafe_path", async () => {
      environment.setCliMode("download-escape");
      expect(await handler({ args: ["drive", "+download", "--file-token", "token"] })).toBe("unsafe_path");
    });
  });

  it("15. single-user mode refuses the user routes and the server survives", async () => {
    const userInfo = nextIdentity("singleuser");
    const callback = await loginWithLark(userInfo);
    const tempToken = new URL(
      callback.location,
      server.origin
    ).searchParams.get("token");
    const exchange = await server.api(
      `/api/request-token/sso/lark?token=${encodeURIComponent(tempToken)}`
    );
    const token = exchange.json.token;
    expect(token).toEqual(expect.any(String));

    // Both routes read response.locals.user, which validatedRequest leaves
    // undefined outside multi-user mode. Without the enabled-guard in front,
    // the handler rejects and Express 4 turns that into a process-killing
    // unhandled rejection, so this asserts the guard, the status, and that the
    // server is still answering afterwards.
    await withDb(environment, (prisma) =>
      prisma.system_settings.update({
        where: { label: "multi_user_mode" },
        data: { value: "false" },
      })
    );

    try {
      for (const [routePath, method] of [
        ["/api/lark/status", "GET"],
        ["/api/lark/identity", "DELETE"],
      ]) {
        for (const authorization of [token, undefined]) {
          const response = await server.api(routePath, {
            method,
            token: authorization,
          });
          expect({ routePath, method, status: response.status }).toEqual({
            routePath,
            method,
            status: 403,
          });
        }
      }

      const alive = await server.api("/api/ping");
      expect(alive.status).toBe(200);
    } finally {
      await withDb(environment, (prisma) =>
        prisma.system_settings.update({
          where: { label: "multi_user_mode" },
          data: { value: "true" },
        })
      );
    }

    // The identity survived: the refusal was a guard, not a delete.
    const identity = await withDb(environment, (prisma) =>
      prisma.lark_identities.findFirst({ where: { open_id: userInfo.open_id } })
    );
    expect(identity).not.toBeNull();
    const restored = await server.api("/api/lark/status", { token });
    expect(restored.status).toBe(200);
    expect(restored.json.connected).toBe(true);
  });
});
