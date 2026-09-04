const { EncryptionManager } = require("../utils/EncryptionManager");
const { LarkOauthState } = require("../models/larkOauthState");
const { TemporaryAuthToken } = require("../models/temporaryAuthToken");
const { LarkIdentity } = require("../models/larkIdentity");
const { larkLoginEnabled } = require("../utils/middleware/larkLoginEnabled");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  assertTenant,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserInfo,
  generatePkce,
  generateState,
} = require("../utils/lark/oauth");
const { connectIdentity, resolveLoginUser } = require("../utils/lark/identity");
const {
  isLarkLoginEnabled,
  loadLarkConfig,
} = require("../utils/lark/settings");

const LOGIN_STATE_TTL_MS = 10 * 60 * 1000;
const LOGIN_ERRORS = new Set([
  "denied",
  "suspended",
  "link_conflict",
  "unknown",
]);

function larkRedirectUri(request) {
  const forwarded = request.get("x-forwarded-proto");
  const protocol = forwarded?.split(",")[0].trim() || request.protocol;
  const origin =
    process.env.SERVER_URL || `${protocol}://${request.get("host")}`;
  return `${origin.replace(/\/$/, "")}/api/lark/auth/callback`;
}

function loginError(response, error = "unknown") {
  const code = LOGIN_ERRORS.has(error) ? error : "unknown";
  return response.redirect(`/login?lark_error=${code}`);
}

function connectError(response, error = "unknown") {
  const code = new Set(["denied", "link_conflict", "unknown"]).has(error)
    ? error
    : "unknown";
  return response.redirect(`/settings/lark?lark_error=${code}`);
}

function validateConnectRequest(request, response, next) {
  if ((request.query.mode || "login") !== "connect") return next();
  return validatedRequest(request, response, next);
}

function oauthError(response, mode, error = "unknown") {
  return mode === "connect"
    ? connectError(response, error)
    : loginError(response, error);
}

function larkEndpoints(app) {
  if (!app) return;

  app.get("/lark/status", [validatedRequest], async (_request, response) => {
    const identity = await LarkIdentity.get({
      user_id: response.locals.user.id,
    });
    const enabled = await isLarkLoginEnabled();
    if (!identity)
      return response.json({
        connected: false,
        needsReauth: false,
        profile: null,
        enabled,
      });

    const scopes = Array.isArray(identity.scopes)
      ? identity.scopes
      : String(identity.scopes || "")
          .split(/\s+/)
          .filter(Boolean);
    return response.json({
      connected: true,
      needsReauth: Boolean(identity.needs_reauth),
      profile: {
        displayName: identity.display_name,
        avatarUrl: identity.avatar_url,
        email: identity.email,
        tenantKey: identity.tenant_key,
        scopes,
        connectedAt: identity.createdAt,
      },
      enabled,
    });
  });

  app.get(
    "/lark/auth/start",
    [larkLoginEnabled, validateConnectRequest],
    async (request, response) => {
      try {
        const mode = request.query.mode || "login";
        if (!new Set(["login", "connect"]).has(mode))
          return response.status(400).send("Invalid Lark OAuth mode.");

        const encryption = new EncryptionManager();
        const config = await loadLarkConfig({ encryption });
        if (!config?.enabled)
          return response.status(403).send("Lark login is not enabled.");
        config.redirectUri = larkRedirectUri(request);

        const state = generateState();
        const { verifier, challenge } = generatePkce();
        const encryptedVerifier = encryption.encrypt(verifier);
        if (!encryptedVerifier)
          throw new Error("Could not protect OAuth verifier");

        const { error } = await LarkOauthState.create({
          state,
          code_verifier: encryptedVerifier,
          mode,
          user_id: mode === "connect" ? response.locals.user.id : null,
          expiresAt: new Date(Date.now() + LOGIN_STATE_TTL_MS),
        });
        if (error) throw new Error(error);

        const url = buildAuthorizeUrl({ config, state, challenge });
        return mode === "connect"
          ? response.json({ url })
          : response.redirect(url);
      } catch (error) {
        console.error("Lark login start failed", error.message);
        return response.status(500).send("Could not start Lark login.");
      }
    }
  );

  app.get("/lark/auth/callback", async (request, response) => {
    const { state, code, error } = request.query;
    let mode = "login";
    try {
      const oauthState = await LarkOauthState.consume(state, {
        withSecrets: true,
      });
      if (!oauthState || !new Set(["login", "connect"]).has(oauthState.mode))
        return loginError(response);
      mode = oauthState.mode;
      if (error)
        return oauthError(
          response,
          mode,
          error === "access_denied" ? "denied" : "unknown"
        );
      if (!code) return oauthError(response, mode);
      if (mode === "connect" && oauthState.user_id == null)
        return connectError(response);

      const encryption = new EncryptionManager();
      const verifier = encryption.decrypt(oauthState.code_verifier);
      if (!verifier) return oauthError(response, mode);

      const config = await loadLarkConfig({ encryption });
      if (!config?.enabled) return oauthError(response, mode);
      config.redirectUri = larkRedirectUri(request);

      const tokens = await exchangeCode({ config, code, verifier });
      const userInfo = await fetchUserInfo({ accessToken: tokens.accessToken });
      try {
        assertTenant({ config, userInfo });
      } catch {
        return response.redirect(
          mode === "connect"
            ? "/settings/lark?lark_error=tenant"
            : "/login?lark_error=tenant"
        );
      }

      if (mode === "connect") {
        const result = await connectIdentity({
          userId: oauthState.user_id,
          userInfo,
          tokens,
          config,
          encryption,
        });
        if (result.error || !result.identity)
          return connectError(response, result.error);
        return response.redirect("/settings/lark?lark=connected");
      }

      const result = await resolveLoginUser({
        userInfo,
        tokens,
        config,
        encryption,
      });
      if (result.error || !result.user)
        return loginError(response, result.error);

      const issued = await TemporaryAuthToken.issue(result.user.id);
      if (issued.error || !issued.token) return loginError(response);
      return response.redirect(
        `/sso/lark?token=${encodeURIComponent(issued.token)}`
      );
    } catch {
      console.error("Lark login callback failed");
      return oauthError(response, mode);
    }
  });

  app.delete(
    "/lark/identity",
    [validatedRequest],
    async (_request, response) => {
      await LarkIdentity.delete({ user_id: response.locals.user.id });
      return response.json({
        success: true,
        remoteRevoked: false,
        message:
          "Disconnected locally. This does not revoke the grant inside Lark.",
      });
    }
  );
}

module.exports = { larkEndpoints, larkRedirectUri };
