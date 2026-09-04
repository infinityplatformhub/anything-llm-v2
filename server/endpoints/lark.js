const { EncryptionManager } = require("../utils/EncryptionManager");
const { LarkOauthState } = require("../models/larkOauthState");
const { TemporaryAuthToken } = require("../models/temporaryAuthToken");
const { larkLoginEnabled } = require("../utils/middleware/larkLoginEnabled");
const {
  assertTenant,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserInfo,
  generatePkce,
  generateState,
} = require("../utils/lark/oauth");
const { resolveLoginUser } = require("../utils/lark/identity");
const { loadLarkConfig } = require("../utils/lark/settings");

const LOGIN_STATE_TTL_MS = 10 * 60 * 1000;
const LOGIN_ERRORS = new Set([
  "denied",
  "suspended",
  "link_conflict",
  "unknown",
]);

function requestRedirectUri(request) {
  const forwarded = request.get("x-forwarded-proto");
  const protocol = forwarded?.split(",")[0].trim() || request.protocol;
  return `${protocol}://${request.get("host")}/api/lark/auth/callback`;
}

function loginError(response, error = "unknown") {
  const code = LOGIN_ERRORS.has(error) ? error : "unknown";
  return response.redirect(`/login?lark_error=${code}`);
}

function larkEndpoints(app) {
  if (!app) return;

  app.get("/lark/auth/start", [larkLoginEnabled], async (request, response) => {
    try {
      const encryption = new EncryptionManager();
      const config = await loadLarkConfig({ encryption });
      if (!config?.enabled)
        return response.status(403).send("Lark login is not enabled.");
      config.redirectUri ||= requestRedirectUri(request);

      // Login is the only supported mode here. Connect mode is handled separately.
      const state = generateState();
      const { verifier, challenge } = generatePkce();
      const encryptedVerifier = encryption.encrypt(verifier);
      if (!encryptedVerifier)
        throw new Error("Could not protect OAuth verifier");

      const { error } = await LarkOauthState.create({
        state,
        code_verifier: encryptedVerifier,
        mode: "login",
        user_id: null,
        expiresAt: new Date(Date.now() + LOGIN_STATE_TTL_MS),
      });
      if (error) throw new Error(error);

      return response.redirect(buildAuthorizeUrl({ config, state, challenge }));
    } catch (error) {
      console.error("Lark login start failed", error.message);
      return response.status(500).send("Could not start Lark login.");
    }
  });

  app.get("/lark/auth/callback", async (request, response) => {
    const { state, code, error } = request.query;
    try {
      const oauthState = await LarkOauthState.consume(state, {
        withSecrets: true,
      });
      if (!oauthState || oauthState.mode !== "login")
        return loginError(response);
      if (error)
        return loginError(
          response,
          error === "access_denied" ? "denied" : "unknown"
        );
      if (!code) return loginError(response);

      const encryption = new EncryptionManager();
      const verifier = encryption.decrypt(oauthState.code_verifier);
      if (!verifier) return loginError(response);

      const config = await loadLarkConfig({ encryption });
      if (!config?.enabled) return loginError(response);
      config.redirectUri ||= requestRedirectUri(request);

      const tokens = await exchangeCode({ config, code, verifier });
      const userInfo = await fetchUserInfo({ accessToken: tokens.accessToken });
      try {
        assertTenant({ config, userInfo });
      } catch {
        return response.redirect("/login?lark_error=tenant");
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
    } catch (callbackError) {
      console.error("Lark login callback failed", callbackError.message);
      return loginError(response);
    }
  });
}

module.exports = { larkEndpoints };
