require("./_polyfill");

jest.mock("../../../models/larkIdentity", () => ({
  LarkIdentity: {
    get: jest.fn(),
    updateTokens: jest.fn(),
  },
}));

const crypto = require("crypto");
const { EncryptionManager } = require("../../../utils/EncryptionManager");
const { LarkIdentity } = require("../../../models/larkIdentity");
const {
  DEFAULT_SCOPES,
  LARK_AUTHORIZE_URL,
  LARK_TOKEN_URL,
  LARK_USER_INFO_URL,
} = require("../../../utils/lark/constants");
const {
  assertTenant,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserInfo,
  generatePkce,
  generateState,
  getFreshAccessToken,
} = require("../../../utils/lark/oauth");

const config = {
  appId: "cli_test_app",
  appSecret: "app-secret",
  tenantKey: "tenant-1",
  scopes: DEFAULT_SCOPES,
  redirectUri: "https://example.com/api/lark/callback",
};
const originalFetch = global.fetch;
let encryption;

function response(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
  };
}

function storedIdentity(overrides = {}) {
  return {
    id: 7,
    access_token: encryption.encrypt("old-access-token"),
    refresh_token: encryption.encrypt("old-refresh-token"),
    access_expires_at: new Date(Date.now() + 10 * 60 * 1000),
    refresh_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    scopes: DEFAULT_SCOPES,
    needs_reauth: false,
    ...overrides,
  };
}

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  encryption = new EncryptionManager({ key: "test-key", salt: "test-salt" });
  global.fetch = jest.fn();
  LarkIdentity.get.mockReset();
  LarkIdentity.updateTokens.mockReset();
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test("builds international authorize URL with S256 PKCE and exact scopes", () => {
  const state = generateState();
  const { verifier, challenge } = generatePkce();
  const expectedChallenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");

  expect(state).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  expect(challenge).toBe(expectedChallenge);

  const url = new URL(buildAuthorizeUrl({ config, state, challenge }));
  expect(`${url.origin}${url.pathname}`).toBe(LARK_AUTHORIZE_URL);
  expect(Object.fromEntries(url.searchParams)).toEqual({
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    scope: DEFAULT_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    response_type: "code",
  });
});

test("exchanges code with fixed redirect URI and verifier", async () => {
  jest.useFakeTimers().setSystemTime(new Date("2026-09-05T12:00:00.000Z"));
  global.fetch.mockResolvedValue(
    response({
      code: 0,
      access_token: "new-access-token",
      expires_in: 3600,
      refresh_token: "new-refresh-token",
      refresh_token_expires_in: 2592000,
      scope: "offline_access im:message",
    })
  );

  await expect(
    exchangeCode({ config, code: "auth-code", verifier: "pkce-verifier" })
  ).resolves.toEqual({
    accessToken: "new-access-token",
    refreshToken: "new-refresh-token",
    accessExpiresAt: new Date("2026-09-05T13:00:00.000Z"),
    refreshExpiresAt: new Date("2026-10-05T12:00:00.000Z"),
    scopes: "offline_access im:message",
  });
  expect(global.fetch).toHaveBeenCalledWith(LARK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: config.appId,
      client_secret: config.appSecret,
      code: "auth-code",
      redirect_uri: config.redirectUri,
      code_verifier: "pkce-verifier",
    }),
  });
});

test("fetches user info with Bearer user access token", async () => {
  const userInfo = {
    open_id: "ou_123",
    union_id: "on_123",
    tenant_key: "tenant-1",
    name: "Test User",
    avatar_url: "https://example.com/avatar.png",
    email: "user@example.com",
  };
  global.fetch.mockResolvedValue(response({ code: 0, data: userInfo }));

  await expect(fetchUserInfo({ accessToken: "user-token" })).resolves.toEqual(
    userInfo
  );
  expect(global.fetch).toHaveBeenCalledWith(LARK_USER_INFO_URL, {
    method: "GET",
    headers: { Authorization: "Bearer user-token" },
  });
});

test("rejects a mismatched or missing tenant key", () => {
  expect(() =>
    assertTenant({ config, userInfo: { tenant_key: "tenant-2" } })
  ).toThrow("Lark tenant mismatch");
  expect(() => assertTenant({ config, userInfo: {} })).toThrow(
    "Lark tenant mismatch"
  );
});

test("returns unexpired access token without refresh", async () => {
  LarkIdentity.get.mockResolvedValue(storedIdentity());

  await expect(
    getFreshAccessToken({ identityId: 7, config, encryption })
  ).resolves.toBe("old-access-token");
  expect(LarkIdentity.get).toHaveBeenCalledWith(
    { id: 7 },
    { withSecrets: true }
  );
  expect(global.fetch).not.toHaveBeenCalled();
  expect(LarkIdentity.updateTokens).not.toHaveBeenCalled();
});

test("refreshes with less than five minutes remaining and persists rotating pair first", async () => {
  jest.useFakeTimers().setSystemTime(new Date("2026-09-05T12:00:00.000Z"));
  LarkIdentity.get.mockResolvedValue(
    storedIdentity({
      access_expires_at: new Date("2026-09-05T12:04:59.000Z"),
    })
  );
  global.fetch.mockResolvedValue(
    response({
      code: 0,
      access_token: "rotated-access-token",
      expires_in: 3600,
      refresh_token: "rotated-refresh-token",
      refresh_token_expires_in: 2592000,
      scope: "offline_access im:message",
    })
  );
  let finishPersist;
  let markPersistStarted;
  const persistStarted = new Promise((resolve) => {
    markPersistStarted = resolve;
  });
  LarkIdentity.updateTokens.mockImplementation(() => {
    markPersistStarted();
    return new Promise((resolve) => {
      finishPersist = () => resolve({ identity: { id: 7 }, error: null });
    });
  });

  let resolved = false;
  const tokenPromise = getFreshAccessToken({
    identityId: 7,
    config,
    encryption,
  }).then((token) => {
    resolved = true;
    return token;
  });
  await persistStarted;
  expect(resolved).toBe(false);
  finishPersist();

  await expect(tokenPromise).resolves.toBe("rotated-access-token");
  expect(global.fetch).toHaveBeenCalledWith(LARK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: config.appId,
      client_secret: config.appSecret,
      refresh_token: "old-refresh-token",
    }),
  });
  const saved = LarkIdentity.updateTokens.mock.calls[0][1];
  expect(saved).toEqual({
    access_token: expect.any(String),
    refresh_token: expect.any(String),
    access_expires_at: new Date("2026-09-05T13:00:00.000Z"),
    refresh_expires_at: new Date("2026-10-05T12:00:00.000Z"),
    scopes: "offline_access im:message",
    needs_reauth: false,
  });
  expect(encryption.decrypt(saved.access_token)).toBe("rotated-access-token");
  expect(encryption.decrypt(saved.refresh_token)).toBe("rotated-refresh-token");
});

test("coalesces concurrent refreshes for one identity", async () => {
  LarkIdentity.get.mockResolvedValue(
    storedIdentity({ access_expires_at: new Date(Date.now() + 60 * 1000) })
  );
  let releaseFetch;
  global.fetch.mockReturnValue(
    new Promise((resolve) => {
      releaseFetch = () =>
        resolve(
          response({
            code: 0,
            access_token: "shared-access-token",
            expires_in: 3600,
            refresh_token: "shared-refresh-token",
            refresh_token_expires_in: 2592000,
            scope: DEFAULT_SCOPES,
          })
        );
    })
  );
  LarkIdentity.updateTokens.mockResolvedValue({
    identity: { id: 7 },
    error: null,
  });

  const first = getFreshAccessToken({ identityId: 7, config, encryption });
  const second = getFreshAccessToken({ identityId: 7, config, encryption });
  await Promise.resolve();
  releaseFetch();

  await expect(Promise.all([first, second])).resolves.toEqual([
    "shared-access-token",
    "shared-access-token",
  ]);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(LarkIdentity.updateTokens).toHaveBeenCalledTimes(1);
});

test("marks needs_reauth and redacts token response on refresh failure", async () => {
  LarkIdentity.get.mockResolvedValue(
    storedIdentity({ access_expires_at: new Date(Date.now() + 60 * 1000) })
  );
  global.fetch.mockResolvedValue(
    response({
      code: 20029,
      msg: "invalid refresh token: leaked-refresh-token",
      refresh_token: "leaked-rotated-token",
    })
  );
  LarkIdentity.updateTokens.mockResolvedValue({
    identity: { id: 7 },
    error: null,
  });

  let error;
  try {
    await getFreshAccessToken({ identityId: 7, config, encryption });
  } catch (caught) {
    error = caught;
  }

  expect(error.message).toBe("Reconnect Lark in Settings");
  expect(error.message).not.toContain("leaked");
  expect(LarkIdentity.updateTokens).toHaveBeenCalledWith(7, {
    needs_reauth: true,
  });
});
