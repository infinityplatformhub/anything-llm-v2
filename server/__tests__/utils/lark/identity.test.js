require("./_polyfill");

jest.mock("../../../models/larkIdentity", () => ({
  LarkIdentity: {
    get: jest.fn(),
    createForUser: jest.fn(),
    provisionUserWithIdentity: jest.fn(),
    updateTokens: jest.fn(),
    upsertForUser: jest.fn(),
  },
}));

jest.mock("../../../models/user", () => ({
  User: {
    usernameRegex: /^[a-z][a-z0-9._@-]*$/,
    get: jest.fn(),
    create: jest.fn(),
  },
}));

const { LarkIdentity } = require("../../../models/larkIdentity");
const { User } = require("../../../models/user");
const {
  connectIdentity,
  deriveUsername,
  resolveLoginUser,
} = require("../../../utils/lark/identity");

const config = { tenantKey: "tenant-1" };
const userInfo = {
  open_id: "ou_1234567890abcdef",
  union_id: "on_123",
  tenant_key: "tenant-1",
  email: "Alice@example.com",
  name: "Alice Example",
  avatar_url: "https://example.com/alice.png",
};
const tokens = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  accessExpiresAt: new Date("2026-09-05T13:00:00.000Z"),
  refreshExpiresAt: new Date("2026-10-05T12:00:00.000Z"),
  scopes: "offline_access im:message",
};
const encryption = { encrypt: jest.fn((value) => `encrypted:${value}`) };

function savedIdentity(userId, overrides = {}) {
  return {
    id: 11,
    user_id: userId,
    open_id: userInfo.open_id,
    ...overrides,
  };
}

beforeEach(() => {
  LarkIdentity.get.mockReset();
  LarkIdentity.createForUser.mockReset();
  LarkIdentity.provisionUserWithIdentity.mockReset();
  LarkIdentity.updateTokens.mockReset();
  LarkIdentity.upsertForUser.mockReset();
  User.get.mockReset();
  User.create.mockReset();
  encryption.encrypt.mockClear();
});

test("resolves an existing identity before email linking", async () => {
  const identity = savedIdentity(7);
  const user = { id: 7, username: "different", suspended: 0 };
  LarkIdentity.get.mockResolvedValueOnce(identity);
  User.get.mockResolvedValueOnce(user);
  LarkIdentity.updateTokens.mockResolvedValue({ identity, error: null });

  await expect(
    resolveLoginUser({ userInfo, tokens, config, encryption })
  ).resolves.toEqual({ user, identity, created: false, error: null });
  expect(User.get).toHaveBeenCalledTimes(1);
  expect(User.get).toHaveBeenCalledWith({ id: 7 });
  expect(User.create).not.toHaveBeenCalled();
  expect(LarkIdentity.updateTokens).toHaveBeenCalledWith(
    identity.id,
    expect.objectContaining({
      access_token: "encrypted:access-token",
      refresh_token: "encrypted:refresh-token",
    })
  );
  expect(LarkIdentity.createForUser).not.toHaveBeenCalled();
});

test("auto-links exact valid email local-part inside configured tenant", async () => {
  const user = { id: 8, username: "alice", suspended: 0 };
  const identity = savedIdentity(8);
  LarkIdentity.get.mockResolvedValueOnce(null);
  User.get.mockResolvedValueOnce(user);
  LarkIdentity.createForUser.mockResolvedValue({ identity, error: null });

  await expect(
    resolveLoginUser({ userInfo, tokens, config, encryption })
  ).resolves.toEqual({ user, identity, created: false, error: null });
  expect(User.get).toHaveBeenCalledWith({ username: "alice" });
  expect(User.create).not.toHaveBeenCalled();
});

test("does not auto-link a sanitized but non-exact username", async () => {
  const info = { ...userInfo, email: "Mary.Jane+tag@example.com" };
  const createdUser = { id: 9, username: "mary.janetag", suspended: 0 };
  const identity = savedIdentity(9);
  LarkIdentity.get.mockResolvedValueOnce(null);
  User.get.mockImplementation(async ({ username }) =>
    username === "mary.jane" ? { id: 99, username, suspended: 0 } : null
  );
  LarkIdentity.provisionUserWithIdentity.mockResolvedValue({
    user: createdUser,
    identity,
    error: null,
  });

  await expect(
    resolveLoginUser({ userInfo: info, tokens, config, encryption })
  ).resolves.toEqual({
    user: createdUser,
    identity,
    created: true,
    error: null,
  });
  expect(LarkIdentity.provisionUserWithIdentity).toHaveBeenCalledWith({
    user: expect.objectContaining({
      username: "mary.janetag",
      role: "default",
    }),
    identity: expect.objectContaining({ open_id: info.open_id }),
  });
  expect(User.create).not.toHaveBeenCalled();
});

test("derives valid lowercase username and appends collision suffix", async () => {
  const exists = jest.fn(async (username) =>
    ["alice.smith", "alice.smith2"].includes(username)
  );

  await expect(
    deriveUsername({ email: "Alice.Smith@example.com", openId: "ou_x", exists })
  ).resolves.toBe("alice.smith3");

  const base = `a${"b".repeat(63)}`;
  await expect(
    deriveUsername({
      email: `${base}@example.com`,
      openId: "ou_x",
      exists: async (name) => name === base,
    })
  ).resolves.toBe(`${base.slice(0, 63)}2`);
});

test("falls back when local-part starts with non-letter or is too short", async () => {
  await expect(
    deriveUsername({
      email: "1alice@example.com",
      openId: "ou_1234567890abcdef",
      exists: async () => false,
    })
  ).resolves.toBe("lark_ou_123456789");
  await expect(
    deriveUsername({
      email: "a@example.com",
      openId: "ou_abcdef",
      exists: async () => false,
    })
  ).resolves.toBe("lark_ou_abcdef");
});

test("provisions default user with unseen random compliant password", async () => {
  const user = { id: 10, username: "newuser", suspended: 0 };
  const identity = savedIdentity(10);
  LarkIdentity.get.mockResolvedValueOnce(null);
  User.get.mockResolvedValue(null);
  LarkIdentity.provisionUserWithIdentity.mockResolvedValue({
    user,
    identity,
    error: null,
  });

  const result = await resolveLoginUser({
    userInfo: { ...userInfo, email: "newuser@example.com" },
    tokens,
    config,
    encryption,
  });

  expect(result).toEqual({ user, identity, created: true, error: null });
  const request = LarkIdentity.provisionUserWithIdentity.mock.calls[0][0].user;
  expect(request).toEqual({
    username: "newuser",
    password: expect.stringMatching(/^[a-f0-9]{64}$/),
    role: "default",
  });
  expect(JSON.stringify(result)).not.toContain(request.password);
});

test("rejects suspended linked and auto-linked users", async () => {
  LarkIdentity.get.mockResolvedValueOnce(savedIdentity(20));
  User.get.mockResolvedValueOnce({ id: 20, username: "linked", suspended: 1 });

  await expect(
    resolveLoginUser({ userInfo, tokens, config, encryption })
  ).resolves.toEqual({ user: null, identity: null, error: "suspended" });

  LarkIdentity.get.mockResolvedValueOnce(null);
  User.get.mockResolvedValueOnce({ id: 21, username: "alice", suspended: 1 });
  await expect(
    resolveLoginUser({ userInfo, tokens, config, encryption })
  ).resolves.toEqual({ user: null, identity: null, error: "suspended" });
  expect(LarkIdentity.createForUser).not.toHaveBeenCalled();
  expect(LarkIdentity.provisionUserWithIdentity).not.toHaveBeenCalled();
  expect(encryption.encrypt).not.toHaveBeenCalled();
});

test("rejects connect conflict without changing either user", async () => {
  LarkIdentity.get.mockResolvedValueOnce(savedIdentity(30));
  await expect(
    connectIdentity({ userId: 31, userInfo, tokens, config, encryption })
  ).resolves.toEqual({ identity: null, error: "link_conflict" });

  LarkIdentity.get
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(savedIdentity(31, { open_id: "ou_other" }));
  await expect(
    connectIdentity({ userId: 31, userInfo, tokens, config, encryption })
  ).resolves.toEqual({ identity: null, error: "link_conflict" });
  expect(LarkIdentity.createForUser).not.toHaveBeenCalled();
  expect(LarkIdentity.updateTokens).not.toHaveBeenCalled();
  expect(encryption.encrypt).not.toHaveBeenCalled();
});

test("handles concurrent unique conflict without account takeover", async () => {
  LarkIdentity.get
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(savedIdentity(41));
  LarkIdentity.createForUser.mockResolvedValue({
    identity: null,
    error: "P2002 Unique constraint failed on open_id",
  });

  await expect(
    connectIdentity({ userId: 40, userInfo, tokens, config, encryption })
  ).resolves.toEqual({ identity: null, error: "link_conflict" });
  expect(LarkIdentity.createForUser).toHaveBeenCalledTimes(1);
  expect(LarkIdentity.upsertForUser).not.toHaveBeenCalled();
  expect(LarkIdentity.updateTokens).not.toHaveBeenCalled();
});

test("recovers concurrent unique conflict owned by same user", async () => {
  const identity = savedIdentity(40);
  LarkIdentity.get
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(identity);
  LarkIdentity.createForUser.mockResolvedValue({
    identity: null,
    error: "Unique constraint failed on open_id",
  });
  LarkIdentity.updateTokens.mockResolvedValue({ identity, error: null });

  await expect(
    connectIdentity({ userId: 40, userInfo, tokens, config, encryption })
  ).resolves.toEqual({ identity, error: null });
  expect(LarkIdentity.createForUser).toHaveBeenCalledTimes(1);
  expect(LarkIdentity.upsertForUser).not.toHaveBeenCalled();
  expect(LarkIdentity.updateTokens).toHaveBeenCalledWith(
    identity.id,
    expect.objectContaining({ access_token: "encrypted:access-token" })
  );
});

test("auto-link user with existing different identity returns conflict", async () => {
  const user = { id: 50, username: "alice", suspended: 0 };
  LarkIdentity.get.mockResolvedValueOnce(null);
  User.get.mockResolvedValueOnce(user);
  LarkIdentity.createForUser.mockResolvedValue({
    identity: null,
    error: "P2002 Unique constraint failed on user_id",
  });
  LarkIdentity.get.mockResolvedValueOnce(null);

  await expect(
    resolveLoginUser({ userInfo, tokens, config, encryption })
  ).resolves.toEqual({ user: null, identity: null, error: "link_conflict" });
  expect(LarkIdentity.createForUser).toHaveBeenCalledTimes(1);
  expect(LarkIdentity.updateTokens).not.toHaveBeenCalled();
  expect(LarkIdentity.provisionUserWithIdentity).not.toHaveBeenCalled();
});

test("deriveUsername uses bounded fallback after exhaustion", async () => {
  const exists = jest.fn().mockResolvedValue(true);
  const username = await deriveUsername({
    email: "alice@example.com",
    openId: "ou_1234567890abcdef",
    exists,
  });

  expect(exists).toHaveBeenCalledTimes(1001);
  expect(username).toMatch(/^lark_ou_123456789[a-f0-9]{6}$/);
});

test("rejects unvalidated tenant before reading or writing identity", async () => {
  await expect(
    resolveLoginUser({
      userInfo: { ...userInfo, tenant_key: "tenant-2" },
      tokens,
      config,
      encryption,
    })
  ).resolves.toEqual({ user: null, identity: null, error: "unknown" });
  expect(LarkIdentity.get).not.toHaveBeenCalled();
  expect(LarkIdentity.createForUser).not.toHaveBeenCalled();
  expect(LarkIdentity.provisionUserWithIdentity).not.toHaveBeenCalled();
});
