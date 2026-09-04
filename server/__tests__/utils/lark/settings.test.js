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

const fs = require("fs");
const path = require("path");
const prisma = require("../../../utils/prisma");
const { EncryptionManager } = require("../../../utils/EncryptionManager");
const { DEFAULT_SCOPES } = require("../../../utils/lark/constants");
const { SystemSettings } = require("../../../models/systemSettings");
const {
  DEFAULT_LARK_CLI_ALLOWLIST,
  fetchAppAccessToken,
  isLarkLoginEnabled,
  loadLarkConfig,
} = require("../../../utils/lark/settings");

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

  const adminSource = fs.readFileSync(
    path.resolve(__dirname, "../../../endpoints/admin.js"),
    "utf8"
  );
  expect(adminSource).toContain('lark_app_secret: values.lark_app_secret ? "********" : ""');
  expect(adminSource).not.toContain("lark_app_secret: ciphertext");
  expect(ciphertext).not.toBe(config.appSecret);
});

test("rejects malformed scopes and forbidden allowlist entries", async () => {
  await SystemSettings.updateSettings({
    lark_scopes: "offline_access BAD/SCOPE",
    lark_cli_allowlist: ["docs", "AuTh"],
  });
  expect(mockRecords.has("lark_scopes")).toBe(false);
  expect(mockRecords.has("lark_cli_allowlist")).toBe(false);

  await SystemSettings.updateSettings({
    lark_cli_allowlist: '["docs","bad token"]',
  });
  expect(mockRecords.has("lark_cli_allowlist")).toBe(false);
});

test("keeps Lark settings inaccessible to manager role", () => {
  const adminSource = fs.readFileSync(
    path.resolve(__dirname, "../../../endpoints/admin.js"),
    "utf8"
  );
  const managerAllowlistMatches = adminSource.match(
    /const managerAllowedFields = \[[\s\S]*?\];/g
  );
  expect(managerAllowlistMatches).toHaveLength(2);
  for (const managerAllowlist of managerAllowlistMatches)
    expect(managerAllowlist).not.toMatch(/lark_/);
  expect(adminSource).toMatch(
    /"\/admin\/lark-settings"[\s\S]*?strictMultiUserRoleValid\(\[ROLES\.admin\]\)/
  );
  expect(adminSource).toMatch(
    /"\/admin\/lark-settings\/test"[\s\S]*?strictMultiUserRoleValid\(\[ROLES\.admin\]\)/
  );
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
    redirectUri: "https://anything.example/api/lark/callback",
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
