require("./_polyfill");

const mockRecords = new Map();
jest.mock("../../../utils/prisma", () => ({
  system_settings: {
    findFirst: jest.fn(({ where: { label } }) => {
      const value = mockRecords.get(label);
      return Promise.resolve(value === undefined ? null : { label, value });
    }),
    upsert: jest.fn(({ where, update }) => {
      mockRecords.set(where.label, update.value);
      return Promise.resolve({ label: where.label, value: update.value });
    }),
  },
}));

const prisma = require("../../../utils/prisma");
const { EncryptionManager } = require("../../../utils/EncryptionManager");
const { DEFAULT_SCOPES } = require("../../../utils/lark/constants");
const { SystemSettings } = require("../../../models/systemSettings");
const {
  DEFAULT_LARK_CLI_ALLOWLIST,
  fetchAppAccessToken,
  isLarkLoginEnabled,
  LARK_AUTH_CALLBACK_PATH,
  loadLarkConfig,
  validateLarkSettings,
} = require("../../../utils/lark/settings");
const { adminEndpoints } = require("../../../endpoints/admin");

const originalFetch = global.fetch;
const originalServerUrl = process.env.SERVER_URL;
let encryption;

beforeEach(() => {
  mockRecords.clear();
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  process.env.SIG_KEY = "test-key";
  process.env.SIG_SALT = "test-salt";
  delete process.env.SERVER_URL;
  encryption = new EncryptionManager({ key: "test-key", salt: "test-salt" });
  global.fetch = jest.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalServerUrl === undefined) delete process.env.SERVER_URL;
  else process.env.SERVER_URL = originalServerUrl;
  jest.restoreAllMocks();
});

async function saveValidSettings(secret = "super-secret") {
  return SystemSettings.updateSettings({
    lark_login_enabled: true,
    lark_app_id: "  cli_app-id  ",
    lark_app_secret: secret,
    lark_tenant_key: " tenant_key-1 ",
    lark_scopes: " offline_access   im:message ",
    lark_cli_allowlist: ["im", "docs", "calendar"],
    ignored_lark_setting: "not-stored",
  });
}

test("accepts and normalizes exact Lark settings keys", async () => {
  await saveValidSettings();

  expect([...mockRecords.keys()].sort()).toEqual(
    [
      "lark_app_id",
      "lark_app_secret",
      "lark_cli_allowlist",
      "lark_login_enabled",
      "lark_scopes",
      "lark_tenant_key",
    ].sort()
  );
  expect(mockRecords.get("lark_login_enabled")).toBe("true");
  expect(mockRecords.get("lark_app_id")).toBe("cli_app-id");
  expect(mockRecords.get("lark_tenant_key")).toBe("tenant_key-1");
  expect(mockRecords.get("lark_scopes")).toBe("offline_access im:message");
  expect(mockRecords.get("lark_cli_allowlist")).toBe(
    JSON.stringify(["im", "docs", "calendar"])
  );
});

test("encrypts app secret and preserves it on masked update", async () => {
  await saveValidSettings("super-secret");
  const ciphertext = mockRecords.get("lark_app_secret");

  expect(ciphertext).not.toBe("super-secret");
  expect(encryption.decrypt(ciphertext)).toBe("super-secret");

  await SystemSettings.updateSettings({ lark_app_secret: "********" });
  expect(mockRecords.get("lark_app_secret")).toBe(ciphertext);
});

test("never returns plaintext or ciphertext app secret", async () => {
  await saveValidSettings("super-secret");
  const ciphertext = mockRecords.get("lark_app_secret");
  const config = await loadLarkConfig({ encryption });

  expect(config.appSecret).toBe("super-secret");
  expect(SystemSettings.publicFields).not.toContain("lark_app_secret");
  expect(ciphertext).not.toBe(config.appSecret);
});

function registeredRoutes() {
  const routes = [];
  const register = (method) => (path, middlewares, handler) =>
    routes.push({ method, path, middlewares, handler });
  adminEndpoints({
    get: register("GET"),
    post: register("POST"),
    delete: register("DELETE"),
  });
  return routes;
}

function mockResponse({ role = "admin" } = {}) {
  return {
    locals: { multiUserMode: true, user: { role } },
    statusCode: null,
    body: null,
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
  };
}

async function invokeLarkUpdate(body) {
  const route = registeredRoutes().find(
    ({ method, path }) => method === "POST" && path === "/admin/lark-settings"
  );
  const response = mockResponse();
  await route.handler({ body }, response);
  return response;
}

test("keeps all Lark settings routes inaccessible to manager role", async () => {
  const routes = registeredRoutes().filter(({ path }) =>
    path.startsWith("/admin/lark-settings")
  );
  expect(routes.map(({ method, path }) => `${method} ${path}`).sort()).toEqual(
    [
      "GET /admin/lark-settings",
      "POST /admin/lark-settings",
      "POST /admin/lark-settings/test",
    ].sort()
  );

  for (const route of routes) {
    expect(route.middlewares).toHaveLength(2);
    const response = mockResponse({ role: "manager" });
    const next = jest.fn();
    await route.middlewares[1]({}, response, next);
    expect(response.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  }
});

test.each([
  [
    "missing required fields",
    { lark_login_enabled: true },
    "lark_login_enabled",
  ],
  [
    "denylisted allowlist entry",
    { lark_cli_allowlist: ["docs", " AuTh "] },
    "lark_cli_allowlist",
  ],
  [
    "malformed scope",
    { lark_scopes: "offline_access BAD/SCOPE" },
    "lark_scopes",
  ],
])("rejects %s atomically", async (_case, payload, errorField) => {
  const updateSpy = jest.spyOn(SystemSettings, "updateSettings");
  const response = await invokeLarkUpdate(payload);

  expect(response.statusCode).toBe(400);
  expect(response.body).toEqual({
    success: false,
    errors: expect.objectContaining({ [errorField]: expect.any(String) }),
  });
  expect(updateSpy).not.toHaveBeenCalled();
});

test("validates and normalizes a complete Lark update before writing", async () => {
  const updateSpy = jest
    .spyOn(SystemSettings, "updateSettings")
    .mockResolvedValue({ success: true, error: null });
  const response = await invokeLarkUpdate({
    lark_login_enabled: true,
    lark_app_id: " app-id ",
    lark_app_secret: " secret ",
    lark_tenant_key: " tenant-key ",
    lark_scopes: " offline_access   im:message ",
    lark_cli_allowlist: ["im", "docs"],
  });

  expect(response.statusCode).toBe(200);
  expect(updateSpy).toHaveBeenCalledWith({
    lark_login_enabled: true,
    lark_app_id: "app-id",
    lark_app_secret: "secret",
    lark_tenant_key: "tenant-key",
    lark_scopes: "offline_access im:message",
    lark_cli_allowlist: ["im", "docs"],
  });
});

test("returns only enabled boolean from public setup settings", async () => {
  await saveValidSettings();
  jest.spyOn(SystemSettings, "isMultiUserMode").mockResolvedValue(true);
  jest.spyOn(SystemSettings, "hasEmbeddings").mockResolvedValue(false);

  await expect(isLarkLoginEnabled({ encryption })).resolves.toBe(true);
  expect(SystemSettings.publicFields).not.toContain("lark_app_secret");

  const settings = await SystemSettings.currentSettings();
  expect(settings.LarkLoginEnabled).toBe(true);
  expect(settings).not.toHaveProperty("LarkAppSecret");
  expect(settings).not.toHaveProperty("lark_app_secret");
});

test("uses registered Lark auth callback path", () => {
  expect(LARK_AUTH_CALLBACK_PATH).toBe("/api/lark/auth/callback");
});

test("uses defaults and derives redirect URI while loading configuration", async () => {
  const ciphertext = encryption.encrypt("secret");
  mockRecords.set("lark_login_enabled", "true");
  mockRecords.set("lark_app_id", "app-id");
  mockRecords.set("lark_app_secret", ciphertext);
  mockRecords.set("lark_tenant_key", "tenant-key");
  process.env.SERVER_URL = "https://anything.example/";

  await expect(loadLarkConfig({ encryption })).resolves.toEqual({
    enabled: true,
    appId: "app-id",
    appSecret: "secret",
    tenantKey: "tenant-key",
    scopes: DEFAULT_SCOPES,
    allowlist: DEFAULT_LARK_CLI_ALLOWLIST,
    redirectUri: "https://anything.example/api/lark/auth/callback",
  });
});

test("tests app connection without leaking credentials", async () => {
  global.fetch.mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue({
      code: "0",
      app_access_token: "must-not-return",
      tenant_key: "tenant-key",
      expire: 7200,
    }),
  });

  await expect(
    fetchAppAccessToken({ appId: "app-id", appSecret: "super-secret" })
  ).resolves.toEqual({ tenantKey: "tenant-key", expire: 7200 });
  expect(global.fetch).toHaveBeenCalledWith(
    "https://open.larksuite.com/open-apis/auth/v3/app_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: "app-id", app_secret: "super-secret" }),
    }
  );

  global.fetch.mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue({
      code: 10003,
      msg: "bad super-secret for app-id",
    }),
  });
  await expect(
    fetchAppAccessToken({ appId: "app-id", appSecret: "super-secret" })
  ).rejects.toThrow("Lark connection failed");
});

test("validation reports errors without mutating payload", () => {
  const payload = {
    lark_login_enabled: true,
    lark_app_id: " app-id ",
    lark_scopes: "BAD/SCOPE",
  };
  const snapshot = { ...payload };
  const result = validateLarkSettings(payload, { existing: {} });

  expect(result).toEqual({
    ok: false,
    errors: expect.objectContaining({
      lark_login_enabled: expect.any(String),
      lark_scopes: expect.any(String),
    }),
  });
  expect(payload).toEqual(snapshot);
});

test("configuration loading fails closed when decryption throws", async () => {
  const ciphertext = encryption.encrypt("secret");
  mockRecords.set("lark_login_enabled", "true");
  mockRecords.set("lark_app_id", "app-id");
  mockRecords.set("lark_app_secret", ciphertext);
  mockRecords.set("lark_tenant_key", "tenant-key");
  const throwingEncryption = {
    decrypt: jest.fn(() => {
      throw new Error("decrypt failed");
    }),
  };

  await expect(
    loadLarkConfig({ encryption: throwingEncryption })
  ).resolves.toBeNull();
  await expect(
    isLarkLoginEnabled({ encryption: throwingEncryption })
  ).resolves.toBe(false);
  jest.spyOn(EncryptionManager.prototype, "decrypt").mockImplementation(() => {
    throw new Error("decrypt failed");
  });
  jest.spyOn(SystemSettings, "hasEmbeddings").mockResolvedValue(false);
  await expect(SystemSettings.currentSettings()).resolves.toEqual(
    expect.objectContaining({ LarkLoginEnabled: false })
  );
});
