const { reqBody } = require("../utils/http");
const MCPCompatibilityLayer = require("../utils/MCP");
const { Workspace } = require("../models/workspace");
const { WorkspaceMcpConnection } = require("../models/workspaceMcpConnection");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validatedRequest } = require("../utils/middleware/validatedRequest");

function connectionStatus(serverName, connection) {
  return {
    serverName,
    enabled: connection?.enabled === true,
    connected: !!connection?.access_token,
    needsReauth:
      !!connection?.access_token && connection.refresh_token === null,
    companyLabel: connection?.company_label ?? null,
    expiresAt: connection?.expires_at ?? null,
  };
}

function mcpServersEndpoints(app) {
  if (!app) return;

  app.get(
    "/workspace/:slug/mcp",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { slug } = request.params;
        if (typeof slug !== "string" || !slug.trim())
          return response
            .status(400)
            .json({ success: false, error: "Invalid workspace slug" });
        const workspace = await Workspace.get({ slug });
        if (!workspace)
          return response
            .status(404)
            .json({ success: false, error: "Workspace not found" });
        const catalog = new MCPCompatibilityLayer().mcpServerConfigs;
        const rows = await WorkspaceMcpConnection.list(workspace.id);
        const connections = new Map(rows.map((row) => [row.server_name, row]));
        return response.status(200).json({
          connections: catalog.map(({ name }) =>
            connectionStatus(name, connections.get(name))
          ),
        });
      } catch {
        return response
          .status(500)
          .json({ success: false, error: "Unable to load MCP connections" });
      }
    }
  );

  app.post(
    "/workspace/:slug/mcp/toggle",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { slug } = request.params;
        if (typeof slug !== "string" || !slug.trim())
          return response
            .status(400)
            .json({ success: false, error: "Invalid workspace slug" });
        const workspace = await Workspace.get({ slug });
        if (!workspace)
          return response
            .status(404)
            .json({ success: false, error: "Workspace not found" });
        const { serverName, enabled } = reqBody(request) ?? {};
        if (
          typeof serverName !== "string" ||
          !serverName.trim() ||
          typeof enabled !== "boolean"
        )
          return response
            .status(400)
            .json({ success: false, error: "Invalid serverName or enabled" });
        const hypervisor = new MCPCompatibilityLayer();
        const config = hypervisor.mcpServerConfigs.find(
          ({ name }) => name === serverName
        );
        if (!config)
          return response
            .status(404)
            .json({ success: false, error: "MCP server not found" });
        if (enabled && config.server?.anythingllm?.perWorkspaceAuth) {
          const connection = await WorkspaceMcpConnection.find(
            workspace.id,
            serverName
          );
          if (!connection?.access_token)
            return response.status(409).json({
              success: false,
              error: "Connect MCP server before enabling",
            });
        }
        const connection = await WorkspaceMcpConnection.setEnabled(
          workspace.id,
          serverName,
          enabled
        );
        if (!enabled && typeof hypervisor.stopWorkspaceServer === "function")
          await hypervisor.stopWorkspaceServer(workspace.id, serverName);
        return response.status(200).json({
          success: true,
          connection: connectionStatus(serverName, connection),
        });
      } catch {
        return response
          .status(500)
          .json({ success: false, error: "Unable to toggle MCP connection" });
      }
    }
  );

  app.get(
    "/mcp-servers/force-reload",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (_request, response) => {
      try {
        const mcp = new MCPCompatibilityLayer();
        await mcp.reloadMCPServers();
        return response.status(200).json({
          success: true,
          error: null,
          servers: await mcp.servers(),
        });
      } catch (error) {
        console.error("Error force reloading MCP servers:", error);
        return response.status(500).json({
          success: false,
          error: error.message,
          servers: [],
        });
      }
    }
  );

  app.get(
    "/mcp-servers/list",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { workspaceSlug } = request.query;
        let enabledNames = null;
        if (workspaceSlug !== undefined) {
          if (typeof workspaceSlug !== "string" || !workspaceSlug.trim())
            return response
              .status(400)
              .json({ success: false, error: "Invalid workspaceSlug" });
          const workspace = await Workspace.get({ slug: workspaceSlug });
          if (!workspace)
            return response
              .status(404)
              .json({ success: false, error: "Workspace not found" });
          enabledNames = await WorkspaceMcpConnection.enabledNames(
            workspace.id
          );
        }
        const allServers = await new MCPCompatibilityLayer().servers();
        const servers =
          enabledNames === null
            ? allServers
            : allServers.filter((server) => enabledNames.includes(server.name));
        return response.status(200).json({
          success: true,
          servers,
        });
      } catch (error) {
        console.error("Error listing MCP servers:", error);
        return response.status(500).json({
          success: false,
          error: error.message,
        });
      }
    }
  );

  app.post(
    "/mcp-servers/toggle",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { name } = reqBody(request);
        const result = await new MCPCompatibilityLayer().toggleServerStatus(
          name
        );
        return response.status(200).json({
          success: result.success,
          error: result.error,
        });
      } catch (error) {
        console.error("Error toggling MCP server:", error);
        return response.status(500).json({
          success: false,
          error: error.message,
        });
      }
    }
  );

  app.post(
    "/mcp-servers/delete",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { name } = reqBody(request);
        const result = await new MCPCompatibilityLayer().deleteServer(name);
        return response.status(200).json({
          success: result.success,
          error: result.error,
        });
      } catch (error) {
        console.error("Error deleting MCP server:", error);
        return response.status(500).json({
          success: false,
          error: error.message,
        });
      }
    }
  );

  app.post(
    "/mcp-servers/toggle-tool",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { serverName, toolName, enabled } = reqBody(request);
        const result = await new MCPCompatibilityLayer().toggleToolSuppression(
          serverName,
          toolName,
          enabled
        );
        return response.status(200).json({
          success: result.success,
          error: result.error,
          suppressedTools: result.suppressedTools,
        });
      } catch (error) {
        console.error("Error toggling MCP tool:", error);
        return response.status(500).json({
          success: false,
          error: error.message,
          suppressedTools: [],
        });
      }
    }
  );
}

module.exports = { mcpServersEndpoints };
