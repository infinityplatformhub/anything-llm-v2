const crypto = require("crypto");
const { SystemSettings } = require("../../models/systemSettings");

const discoveryCache = new Map();
const STATE_TTL = 10 * 60 * 1000;
let registrationQueue = Promise.resolve();

function httpUrl(value) {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("invalid_oauth_url");
  return url;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(httpUrl(url), {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("oauth_request_failed");
  const data = await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("invalid_oauth_response");
  return data;
}

async function discover(serverUrl) {
  const cached = discoveryCache.get(serverUrl);
  if (cached?.exp > Date.now()) return cached.metadata;
  const resource = await fetchJson(
    new URL("/.well-known/oauth-protected-resource", httpUrl(serverUrl))
  );
  const issuer = resource.authorization_servers?.[0];
  if (typeof issuer !== "string") throw new Error("invalid_oauth_metadata");
  const issuerUrl = httpUrl(issuer);
  const metadata = await fetchJson(
    new URL(
      `/.well-known/oauth-authorization-server${issuerUrl.pathname.replace(/\/$/, "")}`,
      issuerUrl.origin
    )
  );
  if (
    metadata.issuer !== issuer ||
    !metadata.code_challenge_methods_supported?.includes("S256")
  )
    throw new Error("invalid_oauth_metadata");
  for (const key of [
    "authorization_endpoint",
    "token_endpoint",
    "registration_endpoint",
  ])
    httpUrl(metadata[key]);
  discoveryCache.set(serverUrl, { metadata, exp: Date.now() + 5 * 60 * 1000 });
  return metadata;
}

async function ensureClient(serverUrl, redirectUri) {
  httpUrl(redirectUri);
  // Serialize read/modify/write so concurrent registrations retain every client.
  const operation = registrationQueue.then(async () => {
    const setting = await SystemSettings.get({ label: "mcp_oauth_clients" });
    const clients = JSON.parse(setting?.value || "{}");
    if (!clients || typeof clients !== "object" || Array.isArray(clients))
      throw new Error("invalid_oauth_clients");
    const existing = Object.hasOwn(clients, serverUrl)
      ? clients[serverUrl]
      : null;
    if (existing?.client_id && existing.redirect_uri === redirectUri)
      return existing;
    const metadata = await discover(serverUrl);
    const registered = await fetchJson(metadata.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "AnythingLLM",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    if (typeof registered.client_id !== "string" || !registered.client_id)
      throw new Error("invalid_oauth_client");
    const client = {
      client_id: registered.client_id,
      redirect_uri: redirectUri,
    };
    clients[serverUrl] = client;
    const saved = await SystemSettings._updateSettings({
      mcp_oauth_clients: JSON.stringify(clients),
    });
    if (!saved.success) throw new Error("oauth_client_save_failed");
    return client;
  });
  registrationQueue = operation.catch(() => {});
  return operation;
}

function signature(payload) {
  if (!process.env.JWT_SECRET) throw new Error("oauth_not_configured");
  return crypto
    .createHmac("sha256", process.env.JWT_SECRET)
    .update(payload)
    .digest("base64url");
}

async function authorizeUrl({
  serverUrl,
  redirectUri,
  wsSlug,
  serverName,
  userId,
}) {
  const metadata = await discover(serverUrl);
  const client = await ensureClient(serverUrl, redirectUri);
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const payload = {
    wsSlug,
    serverName,
    userId,
    nonce: crypto.randomBytes(32).toString("base64url"),
    exp: Date.now() + STATE_TTL,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const state = `${encoded}.${signature(encoded)}`;
  const url = httpUrl(metadata.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge_method: "S256",
    code_challenge: crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url"),
    state,
    resource: serverUrl,
    scope: (metadata.scopes_supported || []).join(" "),
  }).toString();
  return { url: url.toString(), state, codeVerifier, ...payload };
}

function verifyState(state) {
  if (typeof state !== "string" || state.length > 8192)
    throw new Error("invalid_state");
  const parts = state.split(".");
  if (parts.length !== 2) throw new Error("invalid_state");
  const expected = Buffer.from(signature(parts[0]));
  const actual = Buffer.from(parts[1]);
  if (
    expected.length !== actual.length ||
    !crypto.timingSafeEqual(expected, actual)
  )
    throw new Error("invalid_state");
  const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  if (
    typeof payload.wsSlug !== "string" ||
    !payload.wsSlug ||
    typeof payload.serverName !== "string" ||
    !payload.serverName ||
    typeof payload.nonce !== "string" ||
    !payload.nonce ||
    !(payload.userId === null || Number.isInteger(payload.userId)) ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= Date.now() ||
    payload.exp > Date.now() + STATE_TTL
  )
    throw new Error("invalid_state");
  return payload;
}

async function requestTokens(serverUrl, params) {
  const metadata = await discover(serverUrl);
  const data = await fetchJson(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, resource: serverUrl }).toString(),
  });
  if (
    typeof data.access_token !== "string" ||
    !data.access_token ||
    (data.refresh_token !== undefined &&
      typeof data.refresh_token !== "string") ||
    (data.expires_in !== undefined &&
      (!Number.isFinite(Number(data.expires_in)) ||
        Number(data.expires_in) < 0))
  )
    throw new Error("invalid_token_response");
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at:
      data.expires_in === undefined
        ? null
        : new Date(Date.now() + Number(data.expires_in) * 1000),
  };
}

async function exchangeCode({ serverUrl, redirectUri, code, codeVerifier }) {
  const client = await ensureClient(serverUrl, redirectUri);
  return requestTokens(serverUrl, {
    grant_type: "authorization_code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code,
    code_verifier: codeVerifier,
  });
}

async function refreshTokens(refreshToken, serverUrl) {
  const setting = await SystemSettings.get({ label: "mcp_oauth_clients" });
  const client = JSON.parse(setting?.value || "{}")[serverUrl];
  if (!client?.client_id || typeof refreshToken !== "string" || !refreshToken)
    throw new Error("invalid_oauth_client");
  const tokens = await requestTokens(serverUrl, {
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: refreshToken,
  });
  return { ...tokens, refresh_token: tokens.refresh_token ?? refreshToken };
}

module.exports = {
  discover,
  ensureClient,
  authorizeUrl,
  verifyState,
  exchangeCode,
  refreshTokens,
};
