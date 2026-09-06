const prisma = require("../utils/prisma");

const WorkspaceMcpConnection = {
  list: async function (workspaceId) {
    return prisma.workspace_mcp_connections.findMany({
      where: { workspace_id: workspaceId },
    });
  },

  enabledNames: async function (workspaceId) {
    const connections = await this.list(workspaceId);
    return connections
      .filter((row) => row.enabled)
      .map((row) => row.server_name);
  },

  isAllowed: async function (workspaceId, serverName) {
    const connection = await this.find(workspaceId, serverName);
    return connection?.enabled === true;
  },

  find: async function (workspaceId, serverName) {
    return prisma.workspace_mcp_connections.findUnique({
      where: {
        workspace_id_server_name: {
          workspace_id: workspaceId,
          server_name: serverName,
        },
      },
    });
  },

  setEnabled: async function (workspaceId, serverName, enabled) {
    return prisma.workspace_mcp_connections.upsert({
      where: {
        workspace_id_server_name: {
          workspace_id: workspaceId,
          server_name: serverName,
        },
      },
      create: { workspace_id: workspaceId, server_name: serverName, enabled },
      update: { enabled, lastUpdatedAt: new Date() },
    });
  },

  saveTokens: async function (
    workspaceId,
    serverName,
    { access_token, refresh_token, expires_at, company_label }
  ) {
    const tokens = { access_token, refresh_token, expires_at, company_label };
    return prisma.workspace_mcp_connections.upsert({
      where: {
        workspace_id_server_name: {
          workspace_id: workspaceId,
          server_name: serverName,
        },
      },
      create: {
        workspace_id: workspaceId,
        server_name: serverName,
        ...tokens,
      },
      update: { ...tokens, lastUpdatedAt: new Date() },
    });
  },

  clearTokens: async function (workspaceId, serverName) {
    return prisma.workspace_mcp_connections.updateMany({
      where: { workspace_id: workspaceId, server_name: serverName },
      data: {
        access_token: null,
        refresh_token: null,
        expires_at: null,
        company_label: null,
        lastUpdatedAt: new Date(),
      },
    });
  },
};

module.exports = { WorkspaceMcpConnection };
