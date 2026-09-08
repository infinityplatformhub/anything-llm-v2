const { reqBody } = require("../utils/http");
const MCPCompatibilityLayer = require("../utils/MCP");
const { Workspace } = require("../models/workspace");
const { WorkspaceMcpServer } = require("../models/workspaceMcpServer");
const { WorkspaceMcpConnection } = require("../models/workspaceMcpConnection");
const {
  validateWorkspaceServerName,
  validateWorkspaceServerConfig,
  maskConfig,
  mergeMaskedConfig,
  parseMcpServersBlock,
} = require("../utils/MCP/serverConfig");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validatedRequest } = require("../utils/middleware/validatedRequest");

// Bound tool output shown in the browser; deployments may lower/raise this limit.
const DEFAULT_MCP_CALL_RESULT_MAX_BYTES = 64 * 1024;
// ponytail: process-local concurrency, not cross-replica. Use a shared lock if scaled out.
const inFlight = new Map();
const VALIDATION_CODES = new Set([
  "invalid_name",
  "invalid_config",
  "invalid_url",
  "invalid_type",
  "invalid_headers",
  "invalid_anythingllm",
  "invalid_masked_header",
  "invalid_mcp_servers",
  "invalid_probe_timeout",
  "headers_too_large",
  "stdio_not_supported",
]);

function validationCode(error) {
  if (VALIDATION_CODES.has(error?.message)) return error.message;
  // Field names are attacker-controlled and can themselves contain credentials.
  if (error?.message?.startsWith("unknown_field:")) return "unknown_field";
  return null;
}

function fail(response, status, error) {
  return response.status(status).json({ success: false, error });
}

function bodyOf(request) {
  try {
    return reqBody(request);
  } catch {
    throw new Error("invalid_config");
  }
}

async function workspaceFor(request, response) {
  const { slug } = request.params;
  if (typeof slug !== "string" || !slug.trim()) {
    fail(response, 400, "invalid_slug");
    return null;
  }
  const user = response.locals.user;
  const workspace = await Workspace.get({
    slug,
    ...(user?.role === ROLES.manager && {
      workspace_users: { some: { user_id: user.id ?? null } },
    }),
  });
  if (!workspace) fail(response, 404, "workspace_not_found");
  return workspace;
}

async function exclusively(workspaceId, name, response, operation) {
  const key = `${workspaceId}:${name}`;
  if (inFlight.has(key)) return fail(response, 409, "busy");
  inFlight.set(key, true);
  try {
    return await operation();
  } finally {
    inFlight.delete(key);
  }
}

function boundedResult(value) {
  const configured = Number(process.env.MCP_CALL_RESULT_MAX_BYTES);
  const limit =
    Number.isSafeInteger(configured) && configured > 0
      ? configured
      : DEFAULT_MCP_CALL_RESULT_MAX_BYTES;
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= limit) return { result: value, truncated: false };
  let end = limit;
  // Back up over a partial UTF-8 sequence rather than emitting replacement bytes.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { result: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

function workspaceMcpServersEndpoints(app) {
  if (!app) return;
  const root = "/workspace/:slug/mcp-servers";
  function route(method, path, roles, handler) {
    app[method](
      path,
      [validatedRequest, flexUserRoleValid(roles)],
      async (request, response) => {
        try {
          const workspace = await workspaceFor(request, response);
          if (!workspace) return response;
          if (Object.hasOwn(request.params, "name") && path.includes(":name"))
            validateWorkspaceServerName(request.params.name);
          return await handler(
            request,
            response,
            workspace,
            new MCPCompatibilityLayer()
          );
        } catch (error) {
          const code = validationCode(error);
          return fail(response, code ? 400 : 500, code ?? "operation_failed");
        }
      }
    );
  }

  route(
    "get",
    root,
    [ROLES.admin, ROLES.manager],
    async (_request, response, workspace, mcp) => {
      const owned = await mcp.workspaceServerConfigs(workspace.id);
      const names = new Set(owned.map(({ name }) => name));
      const catalog = [
        ...owned.map((entry) => ({ ...entry, owner: "workspace" })),
        ...mcp.mcpServerConfigs
          .filter(({ name }) => !names.has(name))
          .map((entry) => ({ ...entry, owner: "global" })),
      ];
      const servers = await Promise.all(
        catalog.map(async ({ name, server, owner }) => {
          const connection = await WorkspaceMcpConnection.find(
            workspace.id,
            name
          );
          return {
            name,
            owner,
            config:
              response.locals.user?.role === ROLES.manager
                ? { anythingllm: server.anythingllm ?? null }
                : maskConfig(server),
            enabled: connection?.enabled === true,
            connected: !!connection?.access_token,
            needsReauth:
              !!connection?.access_token && connection.refresh_token === null,
            expiresAt: connection?.expires_at ?? null,
          };
        })
      );
      return response.status(200).json({ servers });
    }
  );

  route(
    "post",
    root,
    [ROLES.admin],
    async (request, response, workspace, mcp) => {
      const entries = parseMcpServersBlock(bodyOf(request));
      const created = [];
      const errors = [];
      for (const { name, config } of entries) {
        try {
          validateWorkspaceServerName(name);
          if (
            mcp.mcpServerConfigs.some((entry) => entry.name === name) ||
            (await WorkspaceMcpServer.find(workspace.id, name))
          ) {
            errors.push({ name, error: "name_conflict" });
            continue;
          }
          validateWorkspaceServerConfig(config);
          await WorkspaceMcpServer.create(workspace.id, name, config);
          created.push(name);
        } catch (error) {
          errors.push({
            name: typeof name === "string" ? name : null,
            error:
              error.code === "P2002"
                ? "name_conflict"
                : validationCode(error) ?? "create_failed",
          });
        }
      }
      const status = created.length
        ? 201
        : errors.every(({ error }) => error === "name_conflict")
          ? 409
          : 400;
      return response.status(status).json({ created, errors });
    }
  );

  route(
    "put",
    `${root}/:name`,
    [ROLES.admin],
    async (request, response, workspace, mcp) => {
      const { name } = request.params;
      const existing = await WorkspaceMcpServer.find(workspace.id, name);
      if (!existing) return fail(response, 404, "server_not_found");
      const config = mergeMaskedConfig(
        existing.config,
        bodyOf(request)?.config
      );
      validateWorkspaceServerConfig(config);
      await WorkspaceMcpServer.update(workspace.id, name, config);
      await mcp.stopWorkspaceServer(workspace.id, name);
      return response.status(200).json({
        server: { name, owner: "workspace", config: maskConfig(config) },
      });
    }
  );

  route(
    "delete",
    `${root}/:name`,
    [ROLES.admin],
    async (request, response, workspace, mcp) => {
      const { name } = request.params;
      if (!(await WorkspaceMcpServer.find(workspace.id, name)))
        return fail(response, 404, "server_not_found");
      await mcp.stopWorkspaceServer(workspace.id, name);
      await WorkspaceMcpServer.delete(workspace.id, name);
      return response.status(200).json({ success: true });
    }
  );

  route(
    "post",
    `${root}/test`,
    [ROLES.admin],
    async (request, response, workspace, mcp) => {
      const body = bodyOf(request);
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        (!Object.hasOwn(body, "config") && !Object.hasOwn(body, "name"))
      )
        return fail(response, 400, "invalid_config");
      if (Object.hasOwn(body, "name")) validateWorkspaceServerName(body.name);
      return exclusively(
        workspace.id,
        body.name ?? "draft",
        response,
        async () => {
          let config = body.config;
          const options = {};
          if (Object.hasOwn(body, "name")) {
            const saved = await mcp.findServerConfig(body.name, workspace);
            if (!saved) return fail(response, 404, "server_not_found");
            config = saved.server;
            if (config.anythingllm?.perWorkspaceAuth) {
              const connection = await WorkspaceMcpConnection.find(
                workspace.id,
                body.name
              );
              if (!connection?.access_token)
                return fail(response, 409, "not_connected");
              options.accessToken = connection.access_token;
            }
          }
          validateWorkspaceServerConfig(config);
          try {
            const { tools, latencyMs } = await mcp.probeServerConfig(
              config,
              options
            );
            return response.status(200).json({
              success: true,
              tools: tools.map(({ name, description, inputSchema }) => ({
                name,
                description,
                inputSchema,
              })),
              latencyMs,
            });
          } catch (error) {
            const code = validationCode(error);
            return fail(
              response,
              code ? 400 : 200,
              code ??
                (error.message === "MCP probe timeout"
                  ? "probe_timeout"
                  : "probe_failed")
            );
          }
        }
      );
    }
  );

  route(
    "post",
    `${root}/:name/call`,
    [ROLES.admin],
    async (request, response, workspace, mcp) => {
      const { name } = request.params;
      const body = bodyOf(request);
      if (
        typeof body?.toolName !== "string" ||
        !body.toolName.trim() ||
        !body.arguments ||
        typeof body.arguments !== "object" ||
        Array.isArray(body.arguments)
      )
        return fail(response, 400, "invalid_arguments");
      return exclusively(workspace.id, name, response, async () => {
        if (!(await mcp.findServerConfig(name, workspace)))
          return fail(response, 404, "server_not_found");
        if (!(await WorkspaceMcpConnection.isAllowed(workspace.id, name)))
          return fail(response, 409, "not_enabled");
        const started = Date.now();
        try {
          const value = await mcp.callServerTool(workspace, name, {
            name: body.toolName,
            arguments: body.arguments,
          });
          const result = boundedResult(
            MCPCompatibilityLayer.returnMCPResult(value)
          );
          return response.status(200).json({
            success: true,
            ...result,
            latencyMs: Date.now() - started,
          });
        } catch (error) {
          const code =
            error.message === "MCP authentication required"
              ? "not_connected"
              : "call_failed";
          return fail(response, 200, code);
        }
      });
    }
  );
}

module.exports = { workspaceMcpServersEndpoints };
