require("./_polyfill");

jest.mock("../../../utils/prisma", () => ({
  lark_oauth_states: {
    create: jest.fn(),
  },
  lark_identities: {
    findFirst: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
    deleteMany: jest.fn(),
  },
  $transaction: jest.fn(),
}));

const prisma = require("../../../utils/prisma");
const { LarkIdentity } = require("../../../models/larkIdentity");
const { LarkOauthState } = require("../../../models/larkOauthState");

beforeEach(() => {
  jest.clearAllMocks();
});

describe("LarkOauthState", () => {
  it("consumes an unexpired OAuth state exactly once", async () => {
    const oauthState = {
      state: "state-1",
      code_verifier: "encrypted-verifier",
      mode: "login",
      expiresAt: new Date(Date.now() + 60_000),
    };
    const tx = {
      lark_oauth_states: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(oauthState)
          .mockResolvedValueOnce(null),
        delete: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));

    await expect(
      LarkOauthState.consume("state-1", { withSecrets: true })
    ).resolves.toEqual(oauthState);
    await expect(LarkOauthState.consume("state-1")).resolves.toBeNull();
    expect(tx.lark_oauth_states.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.lark_oauth_states.deleteMany).toHaveBeenCalledWith({
      where: { state: "state-1", expiresAt: { gt: expect.any(Date) } },
    });
  });

  it("hides verifier unless secrets are explicitly requested", async () => {
    const tx = {
      lark_oauth_states: {
        findUnique: jest.fn().mockResolvedValue({
          state: "state-safe",
          code_verifier: "encrypted-verifier",
          expiresAt: new Date(Date.now() + 60_000),
        }),
        delete: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));

    const result = await LarkOauthState.consume("state-safe");

    expect(result).not.toHaveProperty("code_verifier");
  });

  it("returns null when another consumer wins the delete race", async () => {
    const tx = {
      lark_oauth_states: {
        findUnique: jest.fn().mockResolvedValue({
          state: "raced",
          code_verifier: "encrypted-verifier",
          expiresAt: new Date(Date.now() + 60_000),
        }),
        delete: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));

    await expect(
      LarkOauthState.consume("raced", { withSecrets: true })
    ).resolves.toBeNull();
  });

  it("rejects expired OAuth state and deletes it", async () => {
    const tx = {
      lark_oauth_states: {
        findUnique: jest.fn().mockResolvedValue({
          state: "expired",
          code_verifier: "encrypted-verifier",
          expiresAt: new Date(Date.now() - 60_000),
        }),
        delete: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn(),
      },
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));

    await expect(LarkOauthState.consume("expired")).resolves.toBeNull();
    expect(tx.lark_oauth_states.delete).toHaveBeenCalledWith({
      where: { state: "expired" },
    });
    expect(tx.lark_oauth_states.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects unsupported OAuth state mode", async () => {
    const result = await LarkOauthState.create({
      state: "state-1",
      code_verifier: "encrypted-verifier",
      mode: "invalid",
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(result).toEqual({
      oauthState: null,
      error: "Unsupported Lark OAuth mode: invalid",
    });
    expect(prisma.lark_oauth_states.create).not.toHaveBeenCalled();
  });
});

describe("LarkIdentity", () => {
  const identityData = {
    user_id: "7",
    open_id: "ou_123",
    union_id: "on_123",
    tenant_key: "tenant-1",
    email: "user@example.com",
    display_name: "Test User",
    avatar_url: "https://example.com/avatar.png",
    access_token: "encrypted-access",
    refresh_token: "encrypted-refresh",
    access_expires_at: new Date(Date.now() + 60_000),
    refresh_expires_at: new Date(Date.now() + 120_000),
    scopes: "offline_access",
    needs_reauth: false,
  };

  it("hides tokens unless secrets are explicitly requested", async () => {
    prisma.lark_identities.findFirst.mockResolvedValue({
      id: 1,
      ...identityData,
    });

    const safeIdentity = await LarkIdentity.get({ user_id: "7" });
    const secretIdentity = await LarkIdentity.get(
      { user_id: "7" },
      { withSecrets: true }
    );

    expect(safeIdentity).not.toHaveProperty("access_token");
    expect(safeIdentity).not.toHaveProperty("refresh_token");
    expect(secretIdentity.access_token).toBe(identityData.access_token);
    expect(secretIdentity.refresh_token).toBe(identityData.refresh_token);
    expect(prisma.lark_identities.findFirst).toHaveBeenCalledWith({
      where: { user_id: 7 },
    });
  });

  it("rejects empty or undefined identity selectors", async () => {
    await expect(
      LarkIdentity.get({}, { withSecrets: true })
    ).resolves.toBeNull();
    await expect(
      LarkIdentity.get({ user_id: undefined }, { withSecrets: true })
    ).resolves.toBeNull();

    expect(prisma.lark_identities.findFirst).not.toHaveBeenCalled();
  });

  it("rejects empty deletes and accepts numeric identity selectors", async () => {
    await expect(LarkIdentity.delete()).resolves.toBe(false);
    expect(prisma.lark_identities.deleteMany).not.toHaveBeenCalled();

    prisma.lark_identities.deleteMany.mockResolvedValue({ count: 1 });
    await expect(LarkIdentity.delete({ user_id: "7" })).resolves.toBe(true);
    expect(prisma.lark_identities.deleteMany).toHaveBeenCalledWith({
      where: { user_id: 7 },
    });
  });

  it("rejects invalid token-update IDs", async () => {
    await expect(
      LarkIdentity.updateTokens(undefined, { needs_reauth: true })
    ).resolves.toEqual({ identity: null, error: "Invalid identity ID" });
    expect(prisma.lark_identities.update).not.toHaveBeenCalled();
  });

  it("upserts one identity per user and open_id", async () => {
    prisma.lark_identities.upsert.mockResolvedValue({ id: 1, ...identityData });

    const { identity, error } = await LarkIdentity.upsertForUser(identityData);

    expect(error).toBeNull();
    expect(identity).not.toHaveProperty("access_token");
    expect(identity).not.toHaveProperty("refresh_token");
    expect(prisma.lark_identities.upsert).toHaveBeenCalledWith({
      where: { user_id: 7 },
      create: { ...identityData, user_id: 7 },
      update: {
        open_id: identityData.open_id,
        union_id: identityData.union_id,
        tenant_key: identityData.tenant_key,
        email: identityData.email,
        display_name: identityData.display_name,
        avatar_url: identityData.avatar_url,
        access_token: identityData.access_token,
        refresh_token: identityData.refresh_token,
        access_expires_at: identityData.access_expires_at,
        refresh_expires_at: identityData.refresh_expires_at,
        scopes: identityData.scopes,
        needs_reauth: false,
        lastUpdatedAt: expect.any(Date),
      },
    });
  });

  it("updates rotating token pair atomically", async () => {
    const tokens = {
      access_token: "next-encrypted-access",
      refresh_token: "next-encrypted-refresh",
      access_expires_at: new Date(Date.now() + 60_000),
      refresh_expires_at: new Date(Date.now() + 120_000),
      scopes: "offline_access im:message",
      needs_reauth: false,
    };
    prisma.lark_identities.update.mockResolvedValue({ id: 4, ...tokens });

    const { identity, error } = await LarkIdentity.updateTokens("4", tokens);

    expect(error).toBeNull();
    expect(identity).not.toHaveProperty("access_token");
    expect(identity).not.toHaveProperty("refresh_token");
    expect(prisma.lark_identities.update).toHaveBeenCalledTimes(1);
    expect(prisma.lark_identities.update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: { ...tokens, lastUpdatedAt: expect.any(Date) },
    });
  });

  it("marks identity as needing reauthentication", async () => {
    prisma.lark_identities.update.mockResolvedValue({
      id: 4,
      needs_reauth: true,
    });

    const { identity, error } = await LarkIdentity.updateTokens(4, {
      needs_reauth: true,
    });

    expect(error).toBeNull();
    expect(identity.needs_reauth).toBe(true);
    expect(prisma.lark_identities.update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: { needs_reauth: true, lastUpdatedAt: expect.any(Date) },
    });
  });
});
