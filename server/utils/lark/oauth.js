const crypto = require("crypto");
const { LarkIdentity } = require("../../models/larkIdentity");
const {
  DEFAULT_SCOPES,
  LARK_AUTHORIZE_URL,
  LARK_TOKEN_URL,
  LARK_USER_INFO_URL,
} = require("./constants");

const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const RECONNECT_ERROR = "Reconnect Lark in Settings";
const refreshPromises = new Map();

function generateState() {
  return crypto.randomBytes(32).toString("base64url");
}

function generatePkce() {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

function buildAuthorizeUrl({ config, state, challenge }) {
  const url = new URL(LARK_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    scope: config.scopes || DEFAULT_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    response_type: "code",
  });
  return url.toString();
}

async function postToken(body) {
  let response;
  let payload;
  try {
    response = await fetch(LARK_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    payload = await response.json();
  } catch (_) {
    throw new Error("Lark OAuth request failed");
  }

  if (
    !response.ok ||
    payload?.code == null ||
    Number(payload.code) !== 0 ||
    !payload.access_token
  )
    throw new Error("Lark OAuth request failed");

  const now = Date.now();
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    accessExpiresAt: new Date(now + Number(payload.expires_in) * 1000),
    refreshExpiresAt: new Date(
      now + Number(payload.refresh_token_expires_in) * 1000
    ),
    scopes: payload.scope || "",
  };
}

function exchangeCode({ config, code, verifier }) {
  return postToken({
    grant_type: "authorization_code",
    client_id: config.appId,
    client_secret: config.appSecret,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });
}

async function fetchUserInfo({ accessToken }) {
  let response;
  let payload;
  try {
    response = await fetch(LARK_USER_INFO_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    payload = await response.json();
  } catch (_) {
    throw new Error("Lark user info request failed");
  }

  if (!response.ok || payload?.code !== 0 || !payload.data?.open_id)
    throw new Error("Lark user info request failed");
  return payload.data;
}

function assertTenant({ config, userInfo }) {
  if (!userInfo?.tenant_key || userInfo.tenant_key !== config.tenantKey)
    throw new Error("Lark tenant mismatch");
}

async function markNeedsReauth(identityId) {
  try {
    await LarkIdentity.updateTokens(identityId, { needs_reauth: true });
  } catch (_) {}
}

async function refreshIdentity({ identityId, config, encryption }) {
  try {
    const identity = await LarkIdentity.get(
      { id: identityId },
      { withSecrets: true }
    );
    if (!identity) throw new Error(RECONNECT_ERROR);

    const accessToken = encryption.decrypt(identity.access_token);
    const expiresAt = new Date(identity.access_expires_at).getTime();
    if (
      accessToken &&
      Number.isFinite(expiresAt) &&
      expiresAt - Date.now() >= REFRESH_WINDOW_MS
    )
      return accessToken;

    const refreshToken = encryption.decrypt(identity.refresh_token);
    if (!refreshToken) throw new Error(RECONNECT_ERROR);

    const tokens = await postToken({
      grant_type: "refresh_token",
      client_id: config.appId,
      client_secret: config.appSecret,
      refresh_token: refreshToken,
    });
    if (!tokens.refreshToken) throw new Error(RECONNECT_ERROR);

    const encryptedAccessToken = encryption.encrypt(tokens.accessToken);
    const encryptedRefreshToken = encryption.encrypt(tokens.refreshToken);
    if (!encryptedAccessToken || !encryptedRefreshToken)
      throw new Error(RECONNECT_ERROR);

    const { error } = await LarkIdentity.updateTokens(identityId, {
      access_token: encryptedAccessToken,
      refresh_token: encryptedRefreshToken,
      access_expires_at: tokens.accessExpiresAt,
      refresh_expires_at: tokens.refreshExpiresAt,
      scopes:
        tokens.scopes || identity.scopes || config.scopes || DEFAULT_SCOPES,
      needs_reauth: false,
    });
    if (error) throw new Error(RECONNECT_ERROR);

    return tokens.accessToken;
  } catch (_) {
    await markNeedsReauth(identityId);
    throw new Error(RECONNECT_ERROR);
  }
}

function getFreshAccessToken({ identityId, config, encryption }) {
  const key = String(identityId);
  if (refreshPromises.has(key)) return refreshPromises.get(key);

  const promise = refreshIdentity({ identityId, config, encryption }).finally(
    () => {
      if (refreshPromises.get(key) === promise) refreshPromises.delete(key);
    }
  );
  refreshPromises.set(key, promise);
  return promise;
}

module.exports = {
  assertTenant,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserInfo,
  generatePkce,
  generateState,
  getFreshAccessToken,
};
