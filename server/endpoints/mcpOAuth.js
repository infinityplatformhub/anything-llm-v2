const { reqBody } = require("../utils/http");
const { Workspace } = require("../models/workspace");
const { WorkspaceMcpConnection } = require("../models/workspaceMcpConnection");
const MCPHypervisor = require("../utils/MCP/hypervisor");
const oauth = require("../utils/MCP/oauth");
const prisma = require("../utils/prisma");
const { EncryptionManager } = require("../utils/EncryptionManager");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");

function mcpOAuthEndpoints(app) {
  if (!app) return;
  const encryption = new EncryptionManager();
  const middleware = [validatedRequest, flexUserRoleValid([ROLES.admin])];
  const userId = (response) => response.locals.user?.id ?? null;

  async function target(workspaceSlug, serverName) {
    if (
      typeof workspaceSlug !== "string" ||
      !workspaceSlug.trim() ||
      typeof serverName !== "string" ||
      !serverName.trim()
    )
      throw new Error("invalid_target");
    const workspace = await Workspace.get({ slug: workspaceSlug });
    const hypervisor = new MCPHypervisor();
    const config = hypervisor.mcpServerConfigs.find(
      ({ name }) => name === serverName
    )?.server;
    if (
      !workspace ||
      config?.anythingllm?.perWorkspaceAuth !== true ||
      typeof config.url !== "string" ||
      config.command
    )
      throw new Error("invalid_target");
    return { workspace, serverUrl: config.url, hypervisor };
  }

  app.get(
    "/mcp/oauth/start/:workspaceSlug/:serverName",
    middleware,
    async (request, response) => {
      try {
        const { workspaceSlug, serverName } = request.params;
        const { workspace, serverUrl } = await target(
          workspaceSlug,
          serverName
        );
        if (!process.env.SERVER_URL || !process.env.JWT_SECRET)
          return response.status(500).json({ error: "oauth_misconfigured" });
        const origin = new URL(process.env.SERVER_URL);
        if (
          !["http:", "https:"].includes(origin.protocol) ||
          origin.username ||
          origin.password ||
          origin.search ||
          origin.hash
        )
          return response.status(500).json({ error: "oauth_misconfigured" });
        const redirectUri = `${process.env.SERVER_URL.replace(/\/$/, "")}/api/mcp/oauth/callback`;
        await prisma.lark_oauth_states.deleteMany({
          where: { mode: "mcp", expiresAt: { lte: new Date() } },
        });
        const flow = await oauth.authorizeUrl({
          serverUrl,
          redirectUri,
          wsSlug: workspaceSlug,
          serverName,
          userId: userId(response),
        });
        const encrypted = encryption.encrypt(
          JSON.stringify({
            codeVerifier: flow.codeVerifier,
            workspaceId: workspace.id,
            serverUrl,
            redirectUri,
          })
        );
        if (!encrypted) throw new Error("oauth_state_failed");
        await prisma.lark_oauth_states.create({
          data: {
            state: flow.state,
            code_verifier: encrypted,
            mode: "mcp",
            user_id: userId(response),
            expiresAt: new Date(flow.exp),
          },
        });
        return response.status(200).json({ url: flow.url });
      } catch {
        return response.status(400).json({ error: "oauth_start_failed" });
      }
    }
  );

  app.get("/mcp/oauth/callback", async (request, response) => {
    let state, flow;
    try {
      state = oauth.verifyState(request.query.state);
      const row = await prisma.$transaction(async (tx) => {
        const stored = await tx.lark_oauth_states.findUnique({
          where: { state: request.query.state },
        });
        if (
          !stored ||
          stored.mode !== "mcp" ||
          stored.user_id !== state.userId ||
          stored.expiresAt <= new Date()
        )
          return null;
        const consumed = await tx.lark_oauth_states.deleteMany({
          where: {
            state: stored.state,
            mode: "mcp",
            expiresAt: { gt: new Date() },
          },
        });
        return consumed.count === 1 ? stored : null;
      });
      if (!row) throw new Error("invalid_state");
      flow = JSON.parse(encryption.decrypt(row.code_verifier));
      if (!flow?.codeVerifier) throw new Error("invalid_state");
    } catch {
      return response.status(400).json({ error: "invalid_state" });
    }
    const destination = `/workspace/${encodeURIComponent(state.wsSlug)}/settings/agent-config?mcp=${encodeURIComponent(state.serverName)}`;
    try {
      const { workspace, serverUrl } = await target(
        state.wsSlug,
        state.serverName
      );
      if (workspace.id !== flow.workspaceId || serverUrl !== flow.serverUrl)
        throw new Error("invalid_target");
      if (request.query.error) {
        const error =
          request.query.error === "access_denied"
            ? "access_denied"
            : "authorization_failed";
        return response.redirect(`${destination}&error=${error}`);
      }
      if (
        typeof request.query.code !== "string" ||
        !request.query.code ||
        request.query.code.length > 8192
      )
        throw new Error("invalid_code");
      const tokens = await oauth.exchangeCode({
        serverUrl,
        redirectUri: flow.redirectUri,
        code: request.query.code,
        codeVerifier: flow.codeVerifier,
      });
      await WorkspaceMcpConnection.saveTokens(
        workspace.id,
        state.serverName,
        tokens
      );
      await WorkspaceMcpConnection.setEnabled(
        workspace.id,
        state.serverName,
        true
      );
      return response.redirect(`${destination}&connected=1`);
    } catch {
      return response.redirect(`${destination}&error=oauth_callback_failed`);
    }
  });

  app.post("/mcp/oauth/disconnect", middleware, async (request, response) => {
    try {
      const { workspaceSlug, serverName } = reqBody(request);
      const { workspace, hypervisor } = await target(workspaceSlug, serverName);
      const states = await prisma.lark_oauth_states.findMany({
        where: { mode: "mcp" },
        select: { state: true },
      });
      const matching = states
        .filter(({ state }) => {
          try {
            const payload = oauth.verifyState(state);
            return (
              payload.wsSlug === workspaceSlug &&
              payload.serverName === serverName
            );
          } catch {
            return false;
          }
        })
        .map(({ state }) => state);
      await prisma.lark_oauth_states.deleteMany({
        where: { mode: "mcp", state: { in: matching } },
      });
      await WorkspaceMcpConnection.clearTokens(workspace.id, serverName);
      if (typeof hypervisor.stopWorkspaceServer === "function")
        await hypervisor.stopWorkspaceServer(workspace.id, serverName);
      return response.status(200).json({ success: true, remoteRevoked: false });
    } catch {
      return response.status(400).json({ error: "oauth_disconnect_failed" });
    }
  });
}

module.exports = { mcpOAuthEndpoints };
