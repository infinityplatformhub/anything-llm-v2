const { SystemSettings } = require("../../models/systemSettings");
const { EncryptionManager } = require("../EncryptionManager");
const {
  APP_ACCESS_TOKEN_URL,
  DEFAULT_SCOPES,
  TENANT_ACCESS_TOKEN_URL,
  TENANT_QUERY_URL,
} = require("./constants");

const LARK_AUTH_CALLBACK_PATH = "/api/lark/auth/callback";

function serverOrigin() {
  const origin = process.env.SERVER_URL;
  return typeof origin === "string" && origin.trim()
    ? origin.trim().replace(/\/$/, "")
    : null;
}
const DEFAULT_LARK_CLI_ALLOWLIST = [
  "im",
  "docs",
  "docx",
  "wiki",
  "calendar",
  "contact",
  "drive",
  "base",
];

function validateLarkSettings(payload = {}, { existing = {} } = {}) {
  const values = {};
  const errors = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(payload, key);

  if (has("lark_login_enabled")) {
    const enabled = payload.lark_login_enabled;
    if (enabled === true || enabled === "true")
      values.lark_login_enabled = true;
    else if (enabled === false || enabled === "false")
      values.lark_login_enabled = false;
    else errors.lark_login_enabled = "Must be true or false.";
  }

  for (const field of ["lark_app_id", "lark_tenant_key"]) {
    if (!has(field)) continue;
    const value = payload[field];
    if (typeof value !== "string" || !value.trim())
      errors[field] = "Must be a non-empty identifier.";
    else values[field] = value.trim();
  }

  if (has("lark_app_secret")) {
    const secret = payload.lark_app_secret;
    if (typeof secret !== "string" || !secret.trim())
      errors.lark_app_secret = "Must be a non-empty secret.";
    else if (!/^\*+$/.test(secret.trim()))
      values.lark_app_secret = secret.trim();
  }

  if (has("lark_scopes")) {
    const scopes =
      typeof payload.lark_scopes === "string"
        ? payload.lark_scopes.trim().split(/\s+/).filter(Boolean)
        : [];
    if (
      !scopes.length ||
      scopes.some((scope) => !/^[a-z0-9_.:-]+$/.test(scope))
    )
      errors.lark_scopes = "Contains an invalid scope.";
    else values.lark_scopes = scopes.join(" ");
  }

  if (has("lark_cli_allowlist")) {
    let entries = payload.lark_cli_allowlist;
    try {
      if (typeof entries === "string") entries = JSON.parse(entries);
    } catch {
      entries = null;
    }
    const denied = new Set(["auth", "config", "profile", "logout", "api"]);
    const normalized = Array.isArray(entries)
      ? entries.map((entry) =>
          typeof entry === "string" ? entry.trim().toLowerCase() : ""
        )
      : [];
    if (
      !Array.isArray(entries) ||
      !normalized.length ||
      normalized.some(
        (entry) => !entry || !/^[a-z0-9-]+$/.test(entry) || denied.has(entry)
      )
    )
      errors.lark_cli_allowlist = "Contains an invalid or forbidden command.";
    else values.lark_cli_allowlist = [...new Set(normalized)];
  }

  const enabled = has("lark_login_enabled")
    ? values.lark_login_enabled
    : existing.lark_login_enabled === true ||
      existing.lark_login_enabled === "true";
  if (enabled && !errors.lark_login_enabled) {
    const appId = has("lark_app_id")
      ? values.lark_app_id
      : existing.lark_app_id;
    const tenantKey = has("lark_tenant_key")
      ? values.lark_tenant_key
      : existing.lark_tenant_key;
    const hasAppId = typeof appId === "string" && Boolean(appId.trim());
    const hasTenantKey =
      typeof tenantKey === "string" && Boolean(tenantKey.trim());
    const hasNewSecret = Boolean(values.lark_app_secret);
    const hasExistingSecret =
      typeof existing.lark_app_secret === "string" &&
      Boolean(existing.lark_app_secret.trim());
    if (!hasAppId || !hasTenantKey || (!hasNewSecret && !hasExistingSecret))
      errors.lark_login_enabled =
        "App ID, app secret, and tenant key are required when enabled.";
    // The OAuth redirect URI is derived from SERVER_URL alone. Without it
    // there is no correct value to register with Lark, so enabling is refused.
    else if (!serverOrigin())
      errors.lark_login_enabled =
        "SERVER_URL must be set to the public server origin when enabled.";
  }

  return Object.keys(errors).length
    ? { ok: false, errors }
    : { ok: true, values };
}

async function loadLarkConfig({ encryption } = {}) {
  try {
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
    if (
      !values.lark_app_id ||
      !values.lark_app_secret ||
      !values.lark_tenant_key
    )
      return null;

    const appSecret = (encryption || new EncryptionManager()).decrypt(
      values.lark_app_secret
    );
    if (!appSecret) return null;

    let allowlist = DEFAULT_LARK_CLI_ALLOWLIST;
    if (values.lark_cli_allowlist) {
      const parsed = JSON.parse(values.lark_cli_allowlist);
      if (!Array.isArray(parsed)) return null;
      allowlist = parsed;
    }

    const config = {
      enabled: values.lark_login_enabled === "true",
      appId: values.lark_app_id,
      appSecret,
      tenantKey: values.lark_tenant_key,
      scopes: values.lark_scopes || DEFAULT_SCOPES,
      allowlist,
    };
    const origin = serverOrigin();
    if (origin) config.redirectUri = `${origin}${LARK_AUTH_CALLBACK_PATH}`;
    return config;
  } catch {
    return null;
  }
}

async function isLarkLoginEnabled({ encryption } = {}) {
  try {
    const config = await loadLarkConfig({ encryption });
    return Boolean(
      config?.enabled &&
        config.appId &&
        config.appSecret &&
        config.tenantKey &&
        // No SERVER_URL means no derivable redirect URI: fail closed.
        config.redirectUri &&
        (await SystemSettings.isMultiUserMode())
    );
  } catch {
    return false;
  }
}

async function fetchAppAccessToken({ appId, appSecret }) {
  let response;
  let payload;
  try {
    response = await fetch(APP_ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    payload = await response.json();
  } catch {
    throw Object.assign(new Error("Lark connection failed"), {
      code: "unreachable",
    });
  }
  if (!response.ok || Number(payload?.code) !== 0)
    throw Object.assign(new Error("Lark connection failed"), {
      code: "rejected",
    });
  const result = { expire: payload.expire };
  try {
    const tokenResponse = await fetch(TENANT_ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const token = await tokenResponse.json();
    if (
      !tokenResponse.ok ||
      Number(token?.code) !== 0 ||
      typeof token.tenant_access_token !== "string" ||
      !token.tenant_access_token
    )
      return result;

    const tenantResponse = await fetch(TENANT_QUERY_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${token.tenant_access_token}` },
    });
    const tenantPayload = await tenantResponse.json();
    const tenant = tenantPayload?.data?.tenant;
    if (
      tenantResponse.ok &&
      Number(tenantPayload?.code) === 0 &&
      typeof tenant?.tenant_key === "string" &&
      tenant.tenant_key.trim()
    ) {
      result.tenantKey = tenant.tenant_key;
      if (typeof tenant.name === "string") result.tenantName = tenant.name;
    }
  } catch {
    // Credentials are valid even when tenant discovery is unavailable.
  }
  return result;
}

module.exports = {
  APP_ACCESS_TOKEN_URL,
  DEFAULT_LARK_CLI_ALLOWLIST,
  fetchAppAccessToken,
  isLarkLoginEnabled,
  LARK_AUTH_CALLBACK_PATH,
  loadLarkConfig,
  validateLarkSettings,
};
