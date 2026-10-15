const { reqBody } = require("../utils/http");
const { Workspace } = require("../models/workspace");
const { WorkspaceMcpConnection } = require("../models/workspaceMcpConnection");
const MCPCompatibilityLayer = require("../utils/MCP");
const oauth = require("../utils/MCP/oauth");
const prisma = require("../utils/prisma");
const { EncryptionManager } = require("../utils/EncryptionManager");
const { PersonalMcpGrant: Grant } = require("../models/personalMcpGrant");
const personalCaller = require("../utils/MCP/personalCaller");
const { personalAuth, validateApiKey } = require("../utils/MCP/personalAuth");
const personalCalls = new Set();
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");

function mcpOAuthEndpoints(app) {
  if (!app) return;
  const encryption = new EncryptionManager();
  const middleware = [
    validatedRequest,
    flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default]),
  ];
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
    const hypervisor = new MCPCompatibilityLayer();
    const config = (await hypervisor.findServerConfig(serverName, workspace))
      ?.server;
    if (
      !workspace ||
      !(
        config?.anythingllm?.perWorkspaceAuth === true ||
        config?.anythingllm?.perUserAuth === true
      ) ||
      typeof config.url !== "string" ||
      config.command
    )
      throw new Error("invalid_target");
    if (config.anythingllm?.perUserAuth) {
      require("../utils/MCP/serverConfig").validateWorkspaceServerConfig(
        config
      );
    }
    return {
      workspace,
      serverUrl: config.url,
      hypervisor,
      config,
      personal: config.anythingllm?.perUserAuth === true,
    };
  }

  async function authorize(response, destination) {
    if (destination.personal)
      return personalCaller.fromResponse(response, destination.workspace);
    if (
      response.locals?.multiUserMode &&
      response.locals?.user?.role !== ROLES.admin
    )
      throw new Error("personal_auth_required");
    return null;
  }

  app.get(
    "/mcp/oauth/start/:workspaceSlug/:serverName",
    middleware,
    async (request, response) => {
      try {
        const { workspaceSlug, serverName } = request.params;
        const destination = await target(workspaceSlug, serverName);
        const { workspace, serverUrl, config, personal, hypervisor } =
          destination;
        const identity = await authorize(response, destination);
        if (personalAuth(config).type !== "oauth")
          throw new Error("invalid_target");
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
          userId: personal ? identity.userId : userId(response),
        });
        const grant = personal
          ? await Grant.begin(workspace.id, identity.userId, serverName, config)
          : null;
        if (personal)
          await hypervisor.personalRuntime.stop(
            workspace.id,
            serverName,
            identity.userId
          );
        const encrypted = encryption.encrypt(
          JSON.stringify({
            codeVerifier: flow.codeVerifier,
            workspaceId: workspace.id,
            serverUrl,
            redirectUri,
            personal,
            fingerprint: personal ? Grant.fingerprint(config) : null,
            grantVersion: grant?.version,
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
      } catch (error) {
        if (error.message === "personal_auth_required")
          return response.status(401).json({ error: "personal_auth_required" });
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
    const destination = `/workspace/${encodeURIComponent(state.wsSlug)}${flow.personal ? "" : "/settings/agent-config"}?mcp=${encodeURIComponent(state.serverName)}`;
    try {
      const current = await target(state.wsSlug, state.serverName);
      const { workspace, serverUrl, config, personal, hypervisor } = current;
      if (personalAuth(config).type !== "oauth")
        throw new Error("invalid_target");
      if (workspace.id !== flow.workspaceId || serverUrl !== flow.serverUrl)
        throw new Error("invalid_target");
      if (personal !== (flow.personal === true))
        throw new Error("invalid_target");
      if (personal) {
        await personalCaller.fromOAuthState(state.userId, workspace);
        const grant = await Grant.find(
          workspace.id,
          state.userId,
          state.serverName,
          config
        );
        if (
          Grant.fingerprint(config) !== flow.fingerprint ||
          grant?.version !== flow.grantVersion
        )
          throw new Error("invalid_target");
      }
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
      if (personal) {
        // Exchange can take time: recheck active membership + destination again.
        const latest = await target(state.wsSlug, state.serverName);
        await personalCaller.fromOAuthState(state.userId, latest.workspace);
        if (
          latest.workspace.id !== workspace.id ||
          !latest.personal ||
          Grant.fingerprint(latest.config) !== flow.fingerprint ||
          !(await Grant.save(
            workspace.id,
            state.userId,
            state.serverName,
            flow.grantVersion,
            config,
            tokens
          ))
        ) {
          await oauth.revokeTokens(tokens, serverUrl).catch(() => {});
          throw new Error("invalid_target");
        }
        await hypervisor.personalRuntime.stop(
          workspace.id,
          state.serverName,
          state.userId
        );
        return response.redirect(`${destination}&connected=1`);
      }
      await WorkspaceMcpConnection.saveTokens(
        workspace.id,
        state.serverName,
        tokens
      );
      try {
        await WorkspaceMcpConnection.setEnabled(
          workspace.id,
          state.serverName,
          true
        );
      } catch (error) {
        // Model methods do not accept a transaction client.
        await WorkspaceMcpConnection.clearTokens(
          workspace.id,
          state.serverName
        );
        throw error;
      }
      return response.redirect(`${destination}&connected=1`);
    } catch {
      return response.redirect(`${destination}&error=oauth_callback_failed`);
    }
  });

  app.post(
    "/workspace/:slug/mcp-personal/:name/api-key",
    [validatedRequest],
    async (request, response) => {
      try {
        const { slug, name } = request.params;
        const destination = await target(slug, name);
        const identity = await personalCaller.fromResponse(
          response,
          destination.workspace
        );
        if (
          !destination.personal ||
          personalAuth(destination.config).type !== "apiKey"
        )
          return response.status(400).json({ error: "invalid_target" });
        const body = reqBody(request);
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).length !== 1 ||
          !Object.hasOwn(body, "apiKey")
        )
          return response.status(400).json({ error: "invalid_api_key" });
        const apiKey = validateApiKey(body.apiKey);
        const { workspace, config, hypervisor } = destination;
        const snapshot = await Grant.snapshot(
          workspace.id,
          identity.userId,
          name,
          config
        );
        await hypervisor.probeServerConfig(config, { accessToken: apiKey });
        const current = await target(slug, name);
        const currentIdentity = await personalCaller.fromResponse(
          response,
          current.workspace
        );
        if (
          current.workspace.id !== workspace.id ||
          currentIdentity.userId !== identity.userId ||
          !current.personal ||
          Grant.fingerprint(current.config) !== Grant.fingerprint(config) ||
          !(await Grant.saveApiKey(
            workspace.id,
            identity.userId,
            name,
            snapshot,
            config,
            apiKey
          ))
        )
          return response
            .status(409)
            .json({ error: "personal_connection_changed" });
        await hypervisor.personalRuntime.stop(
          workspace.id,
          name,
          identity.userId
        );
        return response.status(200).json({ success: true });
      } catch (error) {
        if (error.message === "personal_auth_required")
          return response.status(401).json({ error: "personal_auth_required" });
        if (error.message === "invalid_api_key")
          return response.status(400).json({ error: "invalid_api_key" });
        return response.status(400).json({ error: "personal_api_key_failed" });
      }
    }
  );

  app.post(
    "/workspace/:slug/mcp-personal/:name/call",
    [validatedRequest],
    async (request, response) => {
      let key;
      try {
        const workspace = await Workspace.get({ slug: request.params.slug });
        const identity = await personalCaller.fromResponse(response, workspace);
        const body = reqBody(request);
        if (
          typeof body?.toolName !== "string" ||
          !body.toolName.trim() ||
          !body.arguments ||
          typeof body.arguments !== "object" ||
          Array.isArray(body.arguments)
        )
          return response.status(400).json({ error: "invalid_arguments" });
        key = JSON.stringify([
          workspace.id,
          identity.userId,
          request.params.name,
        ]);
        if (personalCalls.has(key)) {
          key = null;
          return response.status(409).json({ error: "busy" });
        }
        personalCalls.add(key);
        const value = await new MCPCompatibilityLayer().personalRuntime.call(
          workspace,
          request.params.name,
          { name: body.toolName, arguments: body.arguments },
          identity
        );
        const { boundedResult } = require("./workspaceMcpServers");
        return response.status(200).json({
          success: true,
          ...boundedResult(MCPCompatibilityLayer.returnMCPResult(value)),
        });
      } catch {
        return response
          .status(401)
          .json({ error: "personal_call_unavailable" });
      } finally {
        if (key) personalCalls.delete(key);
      }
    }
  );

  app.post("/mcp/oauth/disconnect", middleware, async (request, response) => {
    try {
      const { workspaceSlug, serverName } = reqBody(request);
      const destination = await target(workspaceSlug, serverName);
      const { workspace, hypervisor, personal, config, serverUrl } =
        destination;
      const identity = await authorize(response, destination);
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
              payload.serverName === serverName &&
              (!personal || payload.userId === identity.userId)
            );
          } catch {
            return false;
          }
        })
        .map(({ state }) => state);
      await prisma.lark_oauth_states.deleteMany({
        where: { mode: "mcp", state: { in: matching } },
      });
      if (personal) {
        const grant = await Grant.find(
          workspace.id,
          identity.userId,
          serverName,
          config
        );
        let remoteRevoked = false;
        try {
          if (
            personalAuth(config).type === "oauth" &&
            (grant?.access_token || grant?.refresh_token)
          )
            remoteRevoked = await oauth.revokeTokens(grant, serverUrl);
        } catch {
          /* Clear locally even when provider is unavailable. */
        }
        // CAS prevents a slow revoke from disconnecting a newer authorization.
        if (grant)
          await Grant.clearGeneration(
            workspace.id,
            identity.userId,
            serverName,
            grant.generation
          );
        await hypervisor.personalRuntime.stop(
          workspace.id,
          serverName,
          identity.userId
        );
        return response.status(200).json({ success: true, remoteRevoked });
      }
      await WorkspaceMcpConnection.setEnabled(workspace.id, serverName, false);
      await WorkspaceMcpConnection.clearTokens(workspace.id, serverName);
      if (typeof hypervisor.stopWorkspaceServer === "function")
        await hypervisor.stopWorkspaceServer(workspace.id, serverName);
      return response.status(200).json({ success: true, remoteRevoked: false });
    } catch (error) {
      if (error.message === "personal_auth_required")
        return response.status(401).json({ error: "personal_auth_required" });
      return response.status(400).json({ error: "oauth_disconnect_failed" });
    }
  });

  app.get(
    "/workspace/:slug/mcp-personal",
    [validatedRequest],
    async (request, response) => {
      try {
        const workspace = await Workspace.get({ slug: request.params.slug });
        const identity = await personalCaller.fromResponse(response, workspace);
        const mcp = new MCPCompatibilityLayer();
        const owned = await mcp.workspaceServerConfigs(workspace.id);
        const names = new Set(owned.map((entry) => entry.name));
        const catalog = [
          ...owned,
          ...mcp.mcpServerConfigs.filter((entry) => !names.has(entry.name)),
        ];
        const servers = await Promise.all(
          catalog
            .filter((entry) => entry.server.anythingllm?.perUserAuth === true)
            .map(async ({ name, server }) => {
              const grant = await Grant.find(
                workspace.id,
                identity.userId,
                name,
                server
              );
              return {
                name,
                authType: personalAuth(server).type,
                accountLabel: grant?.enabled
                  ? Grant.publicLabel(grant.account_label)
                  : null,
                connected: !!grant?.enabled && !!grant.access_token,
                needsReauth: !!grant && !grant.enabled,
                expiresAt: grant?.expires_at ?? null,
              };
            })
        );
        return response.status(200).json({ servers });
      } catch {
        return response.status(401).json({ error: "personal_auth_required" });
      }
    }
  );

  app.get(
    "/workspace/:slug/mcp-personal/:name/tools",
    [validatedRequest],
    async (request, response) => {
      try {
        const workspace = await Workspace.get({ slug: request.params.slug });
        const identity = await personalCaller.fromResponse(response, workspace);
        const tools = await new MCPCompatibilityLayer().personalRuntime.tools(
          workspace,
          request.params.name,
          identity
        );
        return response.status(200).json({ tools });
      } catch {
        return response
          .status(401)
          .json({ error: "personal_tools_unavailable" });
      }
    }
  );
}

module.exports = { mcpOAuthEndpoints };
