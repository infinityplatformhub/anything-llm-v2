const prisma = require("../utils/prisma");
const { EncryptionManager } = require("../utils/EncryptionManager");
const {
  validateWorkspaceServerName,
  validateWorkspaceServerConfig,
} = require("../utils/MCP/serverConfig");

function encryptionManager() {
  const manager = new EncryptionManager();
  // EncryptionManager logs raw crypto errors; callers below emit only safe codes/names.
  manager.log = () => {};
  return manager;
}

function encryptConfig(name, config) {
  validateWorkspaceServerName(name);
  validateWorkspaceServerConfig(config);
  const encrypted = encryptionManager().encrypt(JSON.stringify(config));
  if (!encrypted) throw new Error("config_encrypt_failed");
  return encrypted;
}

function decryptRow(row, manager) {
  if (!row) return null;
  try {
    const plaintext = manager.decrypt(row.config);
    if (!plaintext) throw new Error("config_decrypt_failed");
    const config = JSON.parse(plaintext);
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new Error("config_decrypt_failed");
    return { ...row, config };
  } catch {
    console.warn("[WorkspaceMcpServer] Config decrypt failed:", row.name);
    return null;
  }
}

const WorkspaceMcpServer = {
  create: async function (workspaceId, name, config) {
    return prisma.workspace_mcp_servers.create({
      data: {
        workspace_id: workspaceId,
        name,
        config: encryptConfig(name, config),
      },
    });
  },

  find: async function (workspaceId, name) {
    const row = await prisma.workspace_mcp_servers.findUnique({
      where: { workspace_id_name: { workspace_id: workspaceId, name } },
    });
    return row ? decryptRow(row, encryptionManager()) : null;
  },

  // Classification-only read: an existing but unreadable shadow must never
  // become absence. Use the original persistent signature, without key creation.
  findStrict: async function (workspaceId, name) {
    try {
      const row = await prisma.workspace_mcp_servers.findUnique({
        where: { workspace_id_name: { workspace_id: workspaceId, name } },
      });
      if (!row) return null;
      const key = process.env.SIG_KEY,
        salt = process.env.SIG_SALT;
      if (!key || !salt) throw new Error();
      const manager = new EncryptionManager({ key, salt });
      manager.log = () => {};
      const config = JSON.parse(manager.decrypt(row.config));
      validateWorkspaceServerConfig(config);
      return { ...row, config };
    } catch {
      throw new Error("personal_config_unavailable");
    }
  },

  listDecrypted: async function (workspaceId) {
    const rows = await prisma.workspace_mcp_servers.findMany({
      where: { workspace_id: workspaceId },
    });
    if (!rows.length) return [];
    const manager = encryptionManager();
    return rows.map((row) => decryptRow(row, manager)).filter(Boolean);
  },

  update: async function (workspaceId, name, config) {
    return prisma.workspace_mcp_servers.update({
      where: { workspace_id_name: { workspace_id: workspaceId, name } },
      data: { config: encryptConfig(name, config) },
    });
  },

  delete: async function (workspaceId, name) {
    return prisma.$transaction(async (tx) => {
      await tx.workspace_mcp_connections.deleteMany({
        where: { workspace_id: workspaceId, server_name: name },
      });
      return tx.workspace_mcp_servers.delete({
        where: { workspace_id_name: { workspace_id: workspaceId, name } },
      });
    });
  },
};

module.exports = { WorkspaceMcpServer };
