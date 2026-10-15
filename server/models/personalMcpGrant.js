const prisma = require("../utils/prisma");
const crypto = require("crypto");

function fingerprint(config) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(config))
    .digest("hex");
}

// Authenticated encryption with binding to owner + definition. Fail closed without
// persistent keys; unlike legacy EncryptionManager this never writes environment files.
function key() {
  if (!process.env.SIG_KEY || !process.env.SIG_SALT)
    throw new Error("personal_encryption_unconfigured");
  return crypto.scryptSync(process.env.SIG_KEY, process.env.SIG_SALT, 32);
}
function aad(row) {
  return Buffer.from(
    JSON.stringify([
      row.workspace_id,
      row.user_id,
      row.server_name,
      row.fingerprint,
    ])
  );
}
function encrypt(tokens, row) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(aad(row));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(tokens)),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((part) => part.toString("base64url"))
    .join(".");
}
function decrypt(row) {
  try {
    const [iv, tag, value] = row.tokens
      .split(".")
      .map((part) => Buffer.from(part, "base64url"));
    const cipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
    cipher.setAAD(aad(row));
    cipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([cipher.update(value), cipher.final()]).toString()
    );
  } catch {
    throw new Error("personal_grant_unavailable");
  }
}
function scope(workspaceId, userId, serverName) {
  if (
    !Number.isInteger(workspaceId) ||
    workspaceId <= 0 ||
    !Number.isInteger(userId) ||
    userId <= 0 ||
    typeof serverName !== "string" ||
    !serverName
  )
    throw new Error("invalid_personal_scope");
  return {
    workspace_id: workspaceId,
    user_id: userId,
    server_name: serverName,
  };
}
const PersonalMcpGrant = {
  fingerprint,
  async snapshot(workspaceId, userId, serverName, config) {
    const owner = scope(workspaceId, userId, serverName);
    return prisma.personal_mcp_grants.upsert({
      where: {
        workspace_id_user_id_server_name: owner,
      },
      create: { ...owner, fingerprint: fingerprint(config) },
      update: {},
      select: { version: true, fingerprint: true },
    });
  },
  async saveApiKey(workspaceId, userId, serverName, snapshot, config, apiKey) {
    const owner = {
      ...scope(workspaceId, userId, serverName),
      fingerprint: fingerprint(config),
    };
    const data = {
      fingerprint: owner.fingerprint,
      tokens: encrypt({ access_token: apiKey }, owner),
      enabled: true,
      refresh_until: null,
      expires_at: null,
      lastUpdatedAt: new Date(),
    };
    const saved = await prisma.personal_mcp_grants.updateMany({
      where: {
        ...scope(workspaceId, userId, serverName),
        version: snapshot.version,
        fingerprint: snapshot.fingerprint,
      },
      data: {
        ...data,
        version: { increment: 1 },
        generation: { increment: 1 },
      },
    });
    return saved.count === 1;
  },
  publicLabel(value) {
    if (typeof value !== "string") return null;
    // Public labels must not carry controls into logs/UI.
    return (
      value
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f<>]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120) || null
    );
  },
  async begin(workspaceId, userId, serverName, config) {
    const owner = scope(workspaceId, userId, serverName);
    return prisma.personal_mcp_grants.upsert({
      where: { workspace_id_user_id_server_name: owner },
      create: { ...owner, fingerprint: fingerprint(config) },
      update: {
        fingerprint: fingerprint(config),
        version: { increment: 1 },
        generation: { increment: 1 },
        refresh_until: null,
        enabled: false,
        tokens: null,
        expires_at: null,
        lastUpdatedAt: new Date(),
      },
    });
  },
  async find(workspaceId, userId, serverName, config) {
    const owner = scope(workspaceId, userId, serverName);
    const row = await prisma.personal_mcp_grants.findUnique({
      where: { workspace_id_user_id_server_name: owner },
    });
    if (!row || row.fingerprint !== fingerprint(config)) return null;
    return { ...row, ...(row.tokens ? decrypt(row) : {}) };
  },
  async save(workspaceId, userId, serverName, version, config, tokens) {
    if (typeof tokens.access_token !== "string" || !tokens.access_token)
      throw new Error("invalid_personal_tokens");
    tokens = {
      access_token: tokens.access_token,
      refresh_token:
        typeof tokens.refresh_token === "string" ? tokens.refresh_token : null,
      expires_at: tokens.expires_at ?? null,
      account_label: this.publicLabel(tokens.account_label),
    };
    const owner = {
      ...scope(workspaceId, userId, serverName),
      fingerprint: fingerprint(config),
    };
    const result = await prisma.personal_mcp_grants.updateMany({
      where: { ...owner, version },
      data: {
        tokens: encrypt(tokens, owner),
        enabled: true,
        refresh_until: null,
        version: { increment: 1 },
        expires_at: tokens.expires_at ?? null,
        lastUpdatedAt: new Date(),
      },
    });
    return result.count === 1;
  },
  async clear(workspaceId, userId, serverName, version) {
    return prisma.personal_mcp_grants.updateMany({
      where: {
        ...scope(workspaceId, userId, serverName),
        ...(version === undefined ? {} : { version }),
      },
      data: {
        tokens: null,
        enabled: false,
        expires_at: null,
        refresh_until: null,
        version: { increment: 1 },
        generation: { increment: 1 },
        lastUpdatedAt: new Date(),
      },
    });
  },
  async clearGeneration(workspaceId, userId, serverName, generation) {
    return prisma.personal_mcp_grants.updateMany({
      where: { ...scope(workspaceId, userId, serverName), generation },
      data: {
        tokens: null,
        enabled: false,
        expires_at: null,
        refresh_until: null,
        version: { increment: 1 },
        generation: { increment: 1 },
        lastUpdatedAt: new Date(),
      },
    });
  },
  async acquireRefresh(workspaceId, userId, serverName, version, config) {
    const result = await prisma.personal_mcp_grants.updateMany({
      where: {
        ...scope(workspaceId, userId, serverName),
        version,
        fingerprint: fingerprint(config),
        enabled: true,
        OR: [{ refresh_until: null }, { refresh_until: { lt: new Date() } }],
      },
      data: {
        version: { increment: 1 },
        refresh_until: new Date(Date.now() + 30000),
        lastUpdatedAt: new Date(),
      },
    });
    return result.count === 1 ? version + 1 : null;
  },
  async releaseRefresh(workspaceId, userId, serverName, version) {
    await prisma.personal_mcp_grants.updateMany({
      where: { ...scope(workspaceId, userId, serverName), version },
      data: { refresh_until: null },
    });
  },
  async invalidate(workspaceId, serverName) {
    return prisma.personal_mcp_grants.updateMany({
      where: {
        ...(workspaceId == null ? {} : { workspace_id: workspaceId }),
        server_name: serverName,
      },
      data: {
        tokens: null,
        enabled: false,
        expires_at: null,
        refresh_until: null,
        version: { increment: 1 },
        generation: { increment: 1 },
        lastUpdatedAt: new Date(),
      },
    });
  },
};
module.exports = { PersonalMcpGrant };
