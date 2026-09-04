const { SystemSettings } = require("../../models/systemSettings");
const { EncryptionManager } = require("../EncryptionManager");
const { DEFAULT_SCOPES } = require("./constants");

const APP_ACCESS_TOKEN_URL =
  "https://open.larksuite.com/open-apis/auth/v3/app_access_token/internal";
const DEFAULT_LARK_CLI_ALLOWLIST = [
  "im",
  "docs",
  "docx",
  "wiki",
  "calendar",
  "contact",
];

async function loadLarkConfig({ encryption } = {}) {
  const labels = [
    "lark_login_enabled",
    "lark_app_id",
    "lark_app_secret",
    "lark_tenant_key",
    "lark_scopes",
    "lark_cli_allowlist",
  ];
  const values = Object.fromEntries(
    await Promise.all(
      labels.map(async (label) => [
        label,
        (await SystemSettings.get({ label }))?.value,
      ])
    )
  );
  if (!values.lark_app_id || !values.lark_app_secret || !values.lark_tenant_key)
    return null;

  const appSecret = (encryption || new EncryptionManager()).decrypt(
    values.lark_app_secret
  );
  if (!appSecret) return null;

  let allowlist = DEFAULT_LARK_CLI_ALLOWLIST;
  try {
    const parsed = JSON.parse(values.lark_cli_allowlist);
    if (Array.isArray(parsed)) allowlist = parsed;
  } catch {}

  const config = {
    enabled: values.lark_login_enabled === "true",
    appId: values.lark_app_id,
    appSecret,
    tenantKey: values.lark_tenant_key,
    scopes: values.lark_scopes || DEFAULT_SCOPES,
    allowlist,
  };
  if (process.env.SERVER_URL)
    config.redirectUri = `${process.env.SERVER_URL.replace(/\/$/, "")}/api/lark/callback`;
  return config;
}

async function isLarkLoginEnabled({ encryption } = {}) {
  const config = await loadLarkConfig({ encryption });
  return Boolean(
    config?.enabled &&
      config.appId &&
      config.appSecret &&
      config.tenantKey &&
      (await SystemSettings.isMultiUserMode())
  );
}

async function fetchAppAccessToken({ appId, appSecret }) {
  try {
    const response = await fetch(APP_ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const payload = await response.json();
    if (!response.ok || Number(payload?.code) !== 0)
      throw new Error("request rejected");
    return {
      ...(payload.tenant_key && { tenantKey: payload.tenant_key }),
      expire: payload.expire,
    };
  } catch {
    throw new Error("Lark connection failed");
  }
}

module.exports = {
  APP_ACCESS_TOKEN_URL,
  DEFAULT_LARK_CLI_ALLOWLIST,
  fetchAppAccessToken,
  isLarkLoginEnabled,
  loadLarkConfig,
};
