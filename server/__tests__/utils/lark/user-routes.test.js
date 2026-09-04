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
  connectIdentity: jest.fn(),
  resolveLoginUser: jest.fn(),
}));
jest.mock("../../../utils/lark/settings", () => ({
  loadLarkConfig: jest.fn(),
  isLarkLoginEnabled: jest.fn(),
}));
jest.mock("../../../models/larkOauthState", () => ({
  LarkOauthState: { create: jest.fn(), consume: jest.fn() },
}));
jest.mock("../../../models/larkIdentity", () => ({
  LarkIdentity: { get: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../../models/temporaryAuthToken", () => ({
  TemporaryAuthToken: { issue: jest.fn() },
}));
jest.mock("../../../utils/middleware/larkLoginEnabled", () => ({
  larkLoginEnabled: jest.fn((_request, _response, next) => next()),
}));
jest.mock("../../../utils/middleware/validatedRequest", () => ({
  validatedRequest: jest.fn((request, response, next) => {
    if (!request.authUser)
      return response.status(401).json({ error: "No auth token found." });
    response.locals.user = request.authUser;
    response.locals.multiUserMode = true;
    return next();
  }),
}));
jest.mock("../../../utils/EncryptionManager", () => ({
  EncryptionManager: jest.fn(() => ({
    encrypt: jest.fn((value) => `encrypted:${value}`),
    decrypt: jest.fn((value) => value.replace("encrypted:", "")),
  })),
}));

const oauth = require("../../../utils/lark/oauth");
const { connectIdentity } = require("../../../utils/lark/identity");
const settings = require("../../../utils/lark/settings");
const { LarkOauthState } = require("../../../models/larkOauthState");
const { LarkIdentity } = require("../../../models/larkIdentity");
const {
  validatedRequest,
} = require("../../../utils/middleware/validatedRequest");

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

function request(overrides = {}) {
  return {
    authUser: { id: 7 },
    query: {},
    protocol: "https",
    get: (name) => (name === "host" ? "anything.test" : undefined),
    ...overrides,
  };
}

function config() {
  return {
    enabled: true,
    appId: "cli_a",
    appSecret: "secret",
    tenantKey: "tenant_a",
    scopes: "contact:user.base:readonly",
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  settings.isLarkLoginEnabled.mockResolvedValue(true);
  settings.loadLarkConfig.mockResolvedValue(config());
  oauth.generateState.mockReturnValue("state-value");
  oauth.generatePkce.mockReturnValue({
    verifier: "verifier",
    challenge: "challenge",
  });
  oauth.buildAuthorizeUrl.mockReturnValue(
    "https://open.larksuite.com/authorize"
  );
  LarkOauthState.create.mockResolvedValue({ error: null });
});

test("returns safe disconnected and connected status shapes", async () => {
  const { larkEndpoints } = require("../../../endpoints/lark");
  const app = fakeApp();
  larkEndpoints(app);
  const handlers = app.routes["GET /lark/status"];

  LarkIdentity.get.mockResolvedValueOnce(null);
  let res = await invoke(handlers, request());
  expect(res.json).toHaveBeenCalledWith({
    connected: false,
    needsReauth: false,
    profile: null,
    enabled: true,
  });

  LarkIdentity.get.mockResolvedValueOnce({
    id: 91,
    user_id: 7,
    open_id: "ou_private",
    access_token: "must-not-leak",
    refresh_token: "must-not-leak",
    display_name: "Alice",
    avatar_url: "https://avatar.test/alice",
    email: "alice@example.test",
    tenant_key: "tenant_a",
    scopes: "contact:user.base:readonly drive:drive:readonly",
    needs_reauth: true,
    createdAt: new Date("2026-09-05T01:02:03.000Z"),
  });
  res = await invoke(handlers, request());
  expect(LarkIdentity.get).toHaveBeenLastCalledWith({ user_id: 7 });
  expect(res.json).toHaveBeenCalledWith({
    connected: true,
    needsReauth: true,
    profile: {
      displayName: "Alice",
      avatarUrl: "https://avatar.test/alice",
      email: "alice@example.test",
      tenantKey: "tenant_a",
      scopes: ["contact:user.base:readonly", "drive:drive:readonly"],
      connectedAt: new Date("2026-09-05T01:02:03.000Z"),
    },
    enabled: true,
  });
  expect(JSON.stringify(res.json.mock.calls.at(-1)[0])).not.toMatch(
    /access_token|refresh_token|open_id|user_id|must-not-leak/
  );
});

test("requires authentication for connect status and disconnect", async () => {
  const { larkEndpoints } = require("../../../endpoints/lark");
  const app = fakeApp();
  larkEndpoints(app);

  for (const route of [
    "GET /lark/status",
    "GET /lark/auth/start",
    "DELETE /lark/identity",
  ]) {
    const req = request({ authUser: null });
    if (route === "GET /lark/auth/start") req.query = { mode: "connect" };
    const res = await invoke(app.routes[route], req);
    expect(res.status).toHaveBeenCalledWith(401);
  }
  expect(validatedRequest).toHaveBeenCalledTimes(3);
});

test("connect start stores user ownership and returns authorize URL", async () => {
  const { larkEndpoints } = require("../../../endpoints/lark");
  const app = fakeApp();
  larkEndpoints(app);

  const res = await invoke(
    app.routes["GET /lark/auth/start"],
    request({ query: { mode: "connect" } })
  );

  expect(LarkOauthState.create).toHaveBeenCalledWith({
    state: "state-value",
    code_verifier: "encrypted:verifier",
    mode: "connect",
    user_id: 7,
    expiresAt: expect.any(Date),
  });
  expect(res.json).toHaveBeenCalledWith({
    url: "https://open.larksuite.com/authorize",
  });
});

test("rejects unsupported start mode", async () => {
  const { larkEndpoints } = require("../../../endpoints/lark");
  const app = fakeApp();
  larkEndpoints(app);

  const res = await invoke(
    app.routes["GET /lark/auth/start"],
    request({ query: { mode: "other" } })
  );

  expect(res.status).toHaveBeenCalledWith(400);
  expect(LarkOauthState.create).not.toHaveBeenCalled();
});

test("binds connect callback to user ID stored in state", async () => {
  LarkOauthState.consume.mockResolvedValue({
    mode: "connect",
    user_id: 7,
    code_verifier: "encrypted:verifier",
  });
  oauth.exchangeCode.mockResolvedValue({
    accessToken: "access",
    refreshToken: "refresh",
  });
  oauth.fetchUserInfo.mockResolvedValue({
    open_id: "ou_1",
    tenant_key: "tenant_a",
  });
  connectIdentity.mockResolvedValue({ identity: { id: 9 }, error: null });
  const { larkEndpoints } = require("../../../endpoints/lark");
  const app = fakeApp();
  larkEndpoints(app);

  const res = await invoke(
    app.routes["GET /lark/auth/callback"],
    request({
      authUser: { id: 999 },
      query: { state: "state-value", code: "code", user_id: "999" },
    })
  );

  expect(connectIdentity).toHaveBeenCalledWith(
    expect.objectContaining({ userId: 7 })
  );
  expect(res.redirect).toHaveBeenCalledWith("/settings/lark?lark=connected");
});

test("rejects open_id already owned by another user", async () => {
  LarkOauthState.consume.mockResolvedValue({
    mode: "connect",
    user_id: 7,
    code_verifier: "encrypted:verifier",
  });
  oauth.exchangeCode.mockResolvedValue({ accessToken: "access" });
  oauth.fetchUserInfo.mockResolvedValue({
    open_id: "ou_owned",
    tenant_key: "tenant_a",
  });
  connectIdentity.mockResolvedValue({
    identity: null,
    error: "link_conflict",
  });
  const { larkEndpoints } = require("../../../endpoints/lark");
  const app = fakeApp();
  larkEndpoints(app);

  const res = await invoke(
    app.routes["GET /lark/auth/callback"],
    request({ query: { state: "state-value", code: "code" } })
  );

  expect(res.redirect).toHaveBeenCalledWith(
    "/settings/lark?lark_error=link_conflict"
  );
});

test("reconnects owned identity and clears needs_reauth", async () => {
  LarkOauthState.consume.mockResolvedValue({
    mode: "connect",
    user_id: 7,
    code_verifier: "encrypted:verifier",
  });
  const tokens = {
    accessToken: "new-access",
    refreshToken: "new-refresh",
    scopes: "contact:user.base:readonly",
  };
  oauth.exchangeCode.mockResolvedValue(tokens);
  const userInfo = { open_id: "ou_owned", tenant_key: "tenant_a" };
  oauth.fetchUserInfo.mockResolvedValue(userInfo);
  connectIdentity.mockResolvedValue({
    identity: { id: 9, needs_reauth: false },
    error: null,
  });
  const { larkEndpoints } = require("../../../endpoints/lark");
  const app = fakeApp();
  larkEndpoints(app);

  const res = await invoke(
    app.routes["GET /lark/auth/callback"],
    request({ query: { state: "state-value", code: "code" } })
  );

  expect(connectIdentity).toHaveBeenCalledWith(
    expect.objectContaining({ userId: 7, userInfo, tokens })
  );
  expect(res.redirect).toHaveBeenCalledWith("/settings/lark?lark=connected");
});

test("connect callback validates tenant before linking", async () => {
  LarkOauthState.consume.mockResolvedValue({
    mode: "connect",
    user_id: 7,
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

  const res = await invoke(
    app.routes["GET /lark/auth/callback"],
    request({ query: { state: "state-value", code: "code" } })
  );

  expect(connectIdentity).not.toHaveBeenCalled();
  expect(res.redirect).toHaveBeenCalledWith("/settings/lark?lark_error=tenant");
});

test("disconnects only requesting user's identity", async () => {
  LarkIdentity.delete.mockResolvedValue(true);
  const { larkEndpoints } = require("../../../endpoints/lark");
  const app = fakeApp();
  larkEndpoints(app);

  const res = await invoke(
    app.routes["DELETE /lark/identity"],
    request({ authUser: { id: 7 }, query: { user_id: "999" } })
  );

  expect(LarkIdentity.delete).toHaveBeenCalledWith({ user_id: 7 });
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({ success: true })
  );
});

test("does not claim remote token revocation", async () => {
  LarkIdentity.delete.mockResolvedValue(true);
  const { larkEndpoints } = require("../../../endpoints/lark");
  const app = fakeApp();
  larkEndpoints(app);

  const res = await invoke(app.routes["DELETE /lark/identity"], request());

  expect(res.json).toHaveBeenCalledWith({
    success: true,
    remoteRevoked: false,
    message:
      "Disconnected locally. This does not revoke the grant inside Lark.",
  });
});
