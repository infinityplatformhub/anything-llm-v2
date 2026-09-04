/**
 * Mock Lark OAuth + open API server for E2E.
 * Implements only what the product calls: authorize, token (code + refresh),
 * user_info, and app_access_token. Records every request for assertions.
 */
const http = require("http");

const DEFAULT_USER = {
  open_id: "ou_default_open_id",
  union_id: "on_default_union_id",
  tenant_key: "tenant_e2e",
  name: "E2E User",
  avatar_url: "https://example.invalid/avatar.png",
  email: "e2e.user@example.com",
};

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

class MockLark {
  constructor() {
    this.requests = [];
    this.user = { ...DEFAULT_USER };
    this.tenantKey = DEFAULT_USER.tenant_key;
    this.expiresIn = 7200;
    this.refreshExpiresIn = 604800;
    this.appAccessTokenOk = true;
    /** access token -> user info snapshot */
    this.accessTokens = new Map();
    /** code -> {user, challenge} */
    this.codes = new Map();
    /** refresh token -> {user, used} */
    this.refreshTokens = new Map();
    this.counter = 0;
    this.server = null;
    this.port = null;
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  reset() {
    this.requests = [];
    this.user = { ...DEFAULT_USER };
    this.tenantKey = DEFAULT_USER.tenant_key;
    this.expiresIn = 7200;
    this.refreshExpiresIn = 604800;
    this.appAccessTokenOk = true;
    this.accessTokens.clear();
    this.codes.clear();
    this.refreshTokens.clear();
  }

  setUser(patch = {}) {
    this.user = { ...this.user, ...patch };
  }

  requestsFor(pathname) {
    return this.requests.filter((entry) => entry.pathname === pathname);
  }

  nextId(prefix) {
    this.counter += 1;
    return `${prefix}-${this.counter}-${Math.random().toString(36).slice(2, 10)}`;
  }

  issueTokens(user) {
    // Prefix mirrors Lark's real token shape so the runner's redaction regex applies.
    const accessToken = `u-${this.nextId("uat").replace(/-/g, "")}`;
    const refreshToken = `ur-${this.nextId("urt").replace(/-/g, "")}`;
    this.accessTokens.set(accessToken, { ...user });
    this.refreshTokens.set(refreshToken, { user: { ...user }, used: false });
    return { accessToken, refreshToken };
  }

  async handle(request, response) {
    const url = new URL(request.url, this.baseUrl);
    const body =
      request.method === "POST" ? await readBody(request) : undefined;
    this.requests.push({
      method: request.method,
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: request.headers,
      body,
    });

    if (url.pathname === "/open-apis/authen/v1/authorize")
      return this.authorize(url, response);
    if (url.pathname === "/open-apis/authen/v2/oauth/token")
      return this.token(body, response);
    if (url.pathname === "/open-apis/authen/v1/user_info")
      return this.userInfo(request, response);
    if (url.pathname === "/open-apis/auth/v3/app_access_token/internal")
      return this.appAccessToken(response);
    return json(response, 404, { code: 404, msg: "not found" });
  }

  authorize(url, response) {
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    if (!redirectUri)
      return json(response, 400, { code: 400, msg: "missing redirect_uri" });

    const target = new URL(redirectUri);
    if (state) target.searchParams.set("state", state);
    if (url.searchParams.get("deny") === "1") {
      target.searchParams.set("error", "access_denied");
    } else {
      const code = this.nextId("code");
      this.codes.set(code, {
        user: { ...this.user },
        challenge: url.searchParams.get("code_challenge"),
      });
      target.searchParams.set("code", code);
    }
    response.writeHead(302, { Location: target.toString() });
    response.end();
  }

  token(body = {}, response) {
    if (body.grant_type === "authorization_code") {
      const entry = this.codes.get(body.code);
      if (!entry)
        return json(response, 400, { code: 20021, msg: "invalid code" });
      this.codes.delete(body.code);
      return json(response, 200, this.tokenPayload(entry.user));
    }

    if (body.grant_type === "refresh_token") {
      const entry = this.refreshTokens.get(body.refresh_token);
      if (!entry)
        return json(response, 400, {
          code: 20024,
          msg: "refresh token invalid",
        });
      if (entry.used)
        return json(response, 400, {
          code: 20024,
          msg: "refresh token already used",
        });
      entry.used = true;
      return json(response, 200, this.tokenPayload(entry.user));
    }

    return json(response, 400, { code: 20020, msg: "unsupported grant" });
  }

  tokenPayload(user) {
    const { accessToken, refreshToken } = this.issueTokens(user);
    return {
      code: "0",
      msg: "success",
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: this.expiresIn,
      refresh_token_expires_in: this.refreshExpiresIn,
      token_type: "Bearer",
      scope: "offline_access contact:user.email:readonly im:message",
    };
  }

  userInfo(request, response) {
    const header = request.headers.authorization || "";
    const accessToken = header.replace(/^Bearer\s+/i, "");
    const user = this.accessTokens.get(accessToken);
    if (!user) return json(response, 401, { code: 99991663, msg: "bad token" });
    return json(response, 200, { code: 0, msg: "success", data: user });
  }

  appAccessToken(response) {
    if (!this.appAccessTokenOk)
      return json(response, 200, { code: 10003, msg: "app not found" });
    return json(response, 200, {
      code: 0,
      msg: "ok",
      app_access_token: this.nextId("aat"),
      tenant_key: this.tenantKey,
      expire: 7200,
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((request, response) => {
        this.handle(request, response).catch(() =>
          json(response, 500, { code: 500, msg: "mock failure" })
        );
      });
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.port = this.server.address().port;
        resolve(this);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}

module.exports = { MockLark, DEFAULT_USER };

// Jest treats every JavaScript file under __tests__ as a suite; this keeps the
// helper honest when it is collected directly.
if (typeof expect !== "undefined" && expect.getState().testPath === __filename)
  test("is a helper module, not a suite", () => {
    expect(module.exports).toBeDefined();
  });
