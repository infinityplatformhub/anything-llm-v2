require("./_polyfill");

jest.mock("../../../utils/lark/oauth", () => ({
  generateState: jest.fn(),
  generatePkce: jest.fn(),
  buildAuthorizeUrl: jest.fn(),
  exchangeCode: jest.fn(),
  fetchUserInfo: jest.fn(),
  assertTenant: jest.fn(),
}));
jest.mock("../../../utils/lark/identity", () => ({
  resolveLoginUser: jest.fn(),
}));
jest.mock("../../../utils/lark/settings", () => ({
  loadLarkConfig: jest.fn(),
  isLarkLoginEnabled: jest.fn(),
}));
jest.mock("../../../models/larkOauthState", () => ({
  LarkOauthState: { create: jest.fn(), consume: jest.fn() },
}));
jest.mock("../../../models/temporaryAuthToken", () => ({
  TemporaryAuthToken: { issue: jest.fn(), validate: jest.fn() },
}));
jest.mock("../../../models/systemSettings", () => ({
  SystemSettings: { isMultiUserMode: jest.fn() },
}));
jest.mock("../../../utils/EncryptionManager", () => ({
  EncryptionManager: jest.fn(() => ({
    encrypt: jest.fn((value) => `encrypted:${value}`),
    decrypt: jest.fn((value) => value.replace("encrypted:", "")),
  })),
}));
jest.mock("../../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
jest.mock("../../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn() },
}));

const oauth = require("../../../utils/lark/oauth");
const { resolveLoginUser } = require("../../../utils/lark/identity");
const settings = require("../../../utils/lark/settings");
const { LarkOauthState } = require("../../../models/larkOauthState");
const { TemporaryAuthToken } = require("../../../models/temporaryAuthToken");
const { SystemSettings } = require("../../../models/systemSettings");
const { EncryptionManager } = require("../../../utils/EncryptionManager");

const originalServerUrl = process.env.SERVER_URL;

function fakeApp() {
  const routes = {};
  const register =
    (method) =>
    (path, ...handlers) => {
      routes[`${method} ${path}`] = handlers.flat();
    };
  return {
    routes,
    get: register("GET"),
    post: register("POST"),
    put: register("PUT"),
    delete: register("DELETE"),
  };
}

function response() {
  return {
    locals: {},
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    sendStatus: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis(),
    redirect: jest.fn().mockReturnThis(),
  };
}

async function invoke(handlers, request, res = response()) {
  let index = 0;
  const next = async () => {
    const handler = handlers[index++];
    if (handler) await handler(request, res, next);
  };
  await next();
  return res;
}

function baseConfig(overrides = {}) {
  return {
    enabled: true,
    appId: "cli_a",
    appSecret: "secret",
    tenantKey: "tenant_a",
    scopes: "contact:user.base:readonly",
    allowlist: [],
    ...overrides,
  };
}

beforeEach(() => {
  delete process.env.SERVER_URL;
  jest.clearAllMocks();
  oauth.assertTenant.mockReset();
  SystemSettings.isMultiUserMode.mockResolvedValue(true);
  settings.isLarkLoginEnabled.mockResolvedValue(true);
  settings.loadLarkConfig.mockResolvedValue(
    baseConfig({ redirectUri: "https://stale.test/api/lark/callback" })
  );
  oauth.generateState.mockReturnValue("state-value");
  oauth.generatePkce.mockReturnValue({
    verifier: "verifier",
    challenge: "challenge",
  });
  oauth.buildAuthorizeUrl.mockReturnValue(
    "https://open.larksuite.com/authorize"
  );
  LarkOauthState.create.mockResolvedValue({
    oauthState: { id: 1 },
    error: null,
  });
});

afterAll(() => {
  if (originalServerUrl === undefined) delete process.env.SERVER_URL;
  else process.env.SERVER_URL = originalServerUrl;
});

test("derives one fixed callback URI from server URL or request origin", () => {
  const { larkRedirectUri } = require("../../../endpoints/lark");
  const request = {
    protocol: "http",
    get: jest.fn((name) =>
      name === "host"
        ? "anything.test"
        : name === "x-forwarded-proto"
          ? "https"
          : undefined
    ),
  };

  expect(larkRedirectUri(request)).toBe(
    "https://anything.test/api/lark/auth/callback"
  );

  process.env.SERVER_URL = "https://configured.test/";
  expect(larkRedirectUri(request)).toBe(
    "https://configured.test/api/lark/auth/callback"
  );
});

test("rejects start outside multi-user mode or when disabled", async () => {
  const { larkEndpoints } = require("../../../endpoints/lark");
  const app = fakeApp();
  larkEndpoints(app);
  const handlers = app.routes["GET /lark/auth/start"];

  SystemSettings.isMultiUserMode.mockResolvedValue(false);
  let res = await invoke(handlers, {
    query: {},
    protocol: "https",
    get: () => "app.test",
  });
  expect(res.status).toHaveBeenCalledWith(403);
  expect(settings.loadLarkConfig).not.toHaveBeenCalled();

  SystemSettings.isMultiUserMode.mockResolvedValue(true);
  settings.isLarkLoginEnabled.mockResolvedValue(false);
  res = await invoke(handlers, {
    query: {},
    protocol: "https",
    get: () => "app.test",
  });
  expect(res.status).toHaveBeenCalledWith(403);
  expect(settings.loadLarkConfig).not.toHaveBeenCalled();
});

test("stores encrypted verifier and redirects with fixed callback URI", async () => {
  const { larkEndpoints } = require("../../../endpoints/lark");
  const app = fakeApp();
  larkEndpoints(app);
  const req = {
    query: { redirectUri: "https://evil.test/callback" },
    protocol: "http",
    get: jest.fn((name) =>
      name === "host"
        ? "anything.test"
        : name === "x-forwarded-proto"
          ? "https"
          : undefined
    ),
  };

  const res = await invoke(app.routes["GET /lark/auth/start"], req);

  expect(LarkOauthState.create).toHaveBeenCalledWith({
    state: "state-value",
    code_verifier: "encrypted:verifier",
    mode: "login",
    user_id: null,
    expiresAt: expect.any(Date),
  });
  const expiresAt = LarkOauthState.create.mock.calls[0][0].expiresAt.getTime();
  expect(expiresAt).toBeGreaterThan(Date.now() + 9 * 60 * 1000);
  expect(expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);
  expect(oauth.buildAuthorizeUrl).toHaveBeenCalledWith({
    config: expect.objectContaining({
      redirectUri: "https://anything.test/api/lark/auth/callback",
    }),
    state: "state-value",
    challenge: "challenge",
  });
  expect(res.redirect).toHaveBeenCalledWith(
    "https://open.larksuite.com/authorize"
  );
});

test("consumes state before exchanging callback code", async () => {
  const order = [];
  LarkOauthState.consume.mockImplementation(async () => {
    order.push("consume");
    return { mode: "login", code_verifier: "encrypted:verifier" };
  });
  oauth.exchangeCode.mockImplementation(async () => {
    order.push("exchange");
    return { accessToken: "access" };
  });
  oauth.fetchUserInfo.mockImplementation(async () => {
    order.push("fetchUserInfo");
    throw new Error("provider detail");
  });
  jest.spyOn(console, "error").mockImplementation(() => {});
  const { larkEndpoints } = require("../../../endpoints/lark");
  const app = fakeApp();
  larkEndpoints(app);

  await invoke(app.routes["GET /lark/auth/callback"], {
    query: { state: "state-value", code: "code" },
    protocol: "https",
    get: (name) => (name === "host" ? "anything.test" : undefined),
  });

  expect(order).toEqual(["consume", "exchange", "fetchUserInfo"]);
  expect(LarkOauthState.consume).toHaveBeenCalledWith("state-value", {
    withSecrets: true,
  });
  expect(oauth.exchangeCode).toHaveBeenCalledWith({
    config: expect.objectContaining({
      redirectUri: "https://anything.test/api/lark/auth/callback",
    }),
    code: "code",
    verifier: "verifier",
  });
});

test("rejects tenant before identity persistence or temporary token issue", async () => {
  LarkOauthState.consume.mockResolvedValue({
    mode: "login",
    code_verifier: "encrypted:verifier",
  });
  oauth.exchangeCode.mockResolvedValue({ accessToken: "access" });
  oauth.fetchUserInfo.mockResolvedValue({
    open_id: "ou_1",
    tenant_key: "other",
  });
  oauth.assertTenant.mockImplementation(() => {
    throw new Error("tenant mismatch");
  });
  const { larkEndpoints } = require("../../../endpoints/lark");
  const app = fakeApp();
  larkEndpoints(app);

  const res = await invoke(app.routes["GET /lark/auth/callback"], {
    query: { state: "state-value", code: "code" },
    protocol: "https",
    get: (name) => (name === "host" ? "anything.test" : undefined),
  });

  expect(res.redirect).toHaveBeenCalledWith("/login?lark_error=tenant");
  expect(resolveLoginUser).not.toHaveBeenCalled();
  expect(TemporaryAuthToken.issue).not.toHaveBeenCalled();
});

test("issues temporary token and redirects to dedicated landing", async () => {
  LarkOauthState.consume.mockResolvedValue({
    mode: "login",
    code_verifier: "encrypted:verifier",
  });
  oauth.exchangeCode.mockResolvedValue({ accessToken: "access" });
  oauth.fetchUserInfo.mockResolvedValue({
    open_id: "ou_1",
    tenant_key: "tenant_a",
  });
  resolveLoginUser.mockResolvedValue({
    user: { id: 7 },
    identity: { id: 8 },
    created: false,
    error: null,
  });
  TemporaryAuthToken.issue.mockResolvedValue({
    token: "temporary-token",
    error: null,
  });
  const { larkEndpoints } = require("../../../endpoints/lark");
  const app = fakeApp();
  larkEndpoints(app);

  const res = await invoke(app.routes["GET /lark/auth/callback"], {
    query: { state: "state-value", code: "code" },
    protocol: "https",
    get: (name) => (name === "host" ? "anything.test" : undefined),
  });

  expect(TemporaryAuthToken.issue).toHaveBeenCalledWith(7);
  expect(res.redirect).toHaveBeenCalledWith("/sso/lark?token=temporary-token");
});

test("rejects suspended user before session creation", async () => {
  LarkOauthState.consume.mockResolvedValue({
    mode: "login",
    code_verifier: "encrypted:verifier",
  });
  oauth.exchangeCode.mockResolvedValue({ accessToken: "access" });
  oauth.fetchUserInfo.mockResolvedValue({
    open_id: "ou_1",
    tenant_key: "tenant_a",
  });
  resolveLoginUser.mockResolvedValue({
    user: null,
    identity: null,
    error: "suspended",
  });
  const { larkEndpoints } = require("../../../endpoints/lark");
  const app = fakeApp();
  larkEndpoints(app);

  const res = await invoke(app.routes["GET /lark/auth/callback"], {
    query: { state: "state-value", code: "code" },
    protocol: "https",
    get: (name) => (name === "host" ? "anything.test" : undefined),
  });

  expect(res.redirect).toHaveBeenCalledWith("/login?lark_error=suspended");
  expect(TemporaryAuthToken.issue).not.toHaveBeenCalled();
});

test("maps denied and unknown callbacks without leaking details", async () => {
  LarkOauthState.consume.mockResolvedValue({
    mode: "login",
    code_verifier: "encrypted:verifier",
  });
  const { larkEndpoints } = require("../../../endpoints/lark");
  const app = fakeApp();
  larkEndpoints(app);
  const handler = app.routes["GET /lark/auth/callback"];

  let res = await invoke(handler, {
    query: {
      state: "state-value",
      error: "access_denied",
      error_description: "private detail",
    },
    protocol: "https",
    get: (name) => (name === "host" ? "anything.test" : undefined),
  });
  expect(LarkOauthState.consume).toHaveBeenCalledWith("state-value", {
    withSecrets: true,
  });
  expect(LarkOauthState.consume.mock.invocationCallOrder[0]).toBeLessThan(
    res.redirect.mock.invocationCallOrder[0]
  );
  expect(oauth.exchangeCode).not.toHaveBeenCalled();
  expect(oauth.fetchUserInfo).not.toHaveBeenCalled();
  expect(res.redirect).toHaveBeenCalledWith("/login?lark_error=denied");
  expect(res.redirect.mock.calls[0][0]).not.toContain("private");

  LarkOauthState.consume.mockResolvedValue(null);
  res = await invoke(handler, {
    query: { state: "replayed", code: "secret-code" },
    protocol: "https",
    get: (name) => (name === "host" ? "anything.test" : undefined),
  });
  expect(res.redirect).toHaveBeenCalledWith("/login?lark_error=unknown");
  expect(res.redirect.mock.calls[0][0]).not.toContain("secret-code");
});

test("shares temporary token exchange handler across SSO providers", () => {
  const { systemEndpoints } = require("../../../endpoints/system");
  const app = fakeApp();
  systemEndpoints(app);

  const simpleHandler = app.routes["GET /request-token/sso/simple"].at(-1);
  const larkHandler = app.routes["GET /request-token/sso/lark"].at(-1);
  expect(larkHandler).toBe(simpleHandler);
});

test("exchanges temporary token without SIMPLE_SSO_ENABLED", async () => {
  delete process.env.SIMPLE_SSO_ENABLED;
  TemporaryAuthToken.validate.mockResolvedValue({
    sessionToken: "session-token",
    token: { user: { id: 7, username: "alice", password: "hidden" } },
    error: null,
  });
  const { systemEndpoints } = require("../../../endpoints/system");
  const app = fakeApp();
  systemEndpoints(app);

  const res = await invoke(app.routes["GET /request-token/sso/lark"], {
    query: { token: "temporary-token" },
    ip: "127.0.0.1",
  });

  expect(TemporaryAuthToken.validate).toHaveBeenCalledWith("temporary-token");
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({ valid: true, token: "session-token" })
  );
});

test("rejects replayed temporary token", async () => {
  TemporaryAuthToken.validate.mockResolvedValue({
    sessionToken: null,
    token: null,
    error: "Invalid token.",
  });
  const { systemEndpoints } = require("../../../endpoints/system");
  const app = fakeApp();
  systemEndpoints(app);

  const res = await invoke(app.routes["GET /request-token/sso/lark"], {
    query: { token: "used-token" },
    ip: "127.0.0.1",
  });

  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({ valid: false, token: null })
  );
});
