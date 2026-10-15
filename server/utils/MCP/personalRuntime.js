const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { PersonalMcpGrant: Grant } = require("../../models/personalMcpGrant");
const caller = require("./personalCaller");
const oauth = require("./oauth");
const { personalAuth, credentialHeaders } = require("./personalAuth");
const { validateWorkspaceServerConfig } = require("./serverConfig");

class PersonalMcpRuntime {
  clients = new Map();
  boots = new Map();
  epochs = new Map();
  categoryBindings = new WeakMap();
  constructor(hypervisor) {
    this.hypervisor = hypervisor;
  }
  key(workspace, userId, name) {
    return JSON.stringify([workspace.id, userId, name]);
  }
  async target(workspace, name, identity) {
    const userId = await caller.assert(identity, workspace);
    await this.hypervisor.syncPersonalDefinitions();
    const config = (await this.hypervisor.findServerConfig(name, workspace))
      ?.server;
    if (config?.anythingllm?.perUserAuth !== true)
      throw new Error("invalid_personal_target");
    validateWorkspaceServerConfig(config);
    const grant = await Grant.find(workspace.id, userId, name, config);
    if (!grant?.enabled || !grant.access_token)
      throw new Error("MCP authentication required");
    return { userId, config, grant };
  }
  async boot(workspace, name, identity) {
    const userId = await caller.assert(identity, workspace);
    const key = this.key(workspace, userId, name);
    if (this.boots.has(key)) return this.boots.get(key);
    const epoch = this.epochs.get(key) || 0;
    const pending = this.connect(workspace, name, identity, key, epoch);
    this.boots.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.boots.get(key) === pending) this.boots.delete(key);
    }
  }
  async connect(workspace, name, identity, key, epoch) {
    let { userId, config, grant } = await this.target(
      workspace,
      name,
      identity
    );
    if (
      personalAuth(config).type === "oauth" &&
      grant.expires_at &&
      new Date(grant.expires_at).getTime() < Date.now() + 60000
    ) {
      if (!grant.refresh_token) throw new Error("MCP authentication required");
      const lease = await Grant.acquireRefresh(
        workspace.id,
        userId,
        name,
        grant.version,
        config
      );
      if (lease === null) throw new Error("MCP token refresh busy");
      grant = { ...grant, version: lease };
      let tokens;
      try {
        tokens = await oauth.refreshTokens(grant.refresh_token, config.url);
        tokens.account_label ??= grant.account_label;
      } catch (error) {
        if (
          error.status === 401 ||
          (error.status === 400 && error.code === "invalid_grant")
        ) {
          await Grant.clear(workspace.id, userId, name, grant.version);
          await this.closeClient(key);
          throw new Error("MCP authentication required");
        }
        await Grant.releaseRefresh(workspace.id, userId, name, lease);
        throw new Error("MCP token refresh unavailable");
      }
      const current = await this.target(workspace, name, identity);
      if (
        Grant.fingerprint(current.config) !== Grant.fingerprint(config) ||
        current.grant.version !== grant.version ||
        !(await Grant.save(
          workspace.id,
          userId,
          name,
          grant.version,
          config,
          tokens
        ))
      )
        throw new Error("MCP connection changed during refresh");
      ({ config, grant } = await this.target(workspace, name, identity));
    }
    const existing = this.clients.get(key);
    if (
      existing?.version === grant.version &&
      existing.fingerprint === Grant.fingerprint(config)
    )
      return existing.client;
    await this.closeClient(key);
    const client = new Client({ name, version: "1.0.0" });
    let timer,
      expired = false;
    try {
      const transport = this.hypervisor.createHttpTransport({
        ...config,
        headers: credentialHeaders(config, grant.access_token),
      });
      const connecting = client.connect(transport);
      // Close again if an SDK connect resolves after the deadline.
      connecting.then(
        () => {
          if (expired) client.close().catch(() => {});
        },
        () => {}
      );
      await Promise.race([
        connecting,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(new Error("MCP connection timeout"));
          }, 30000);
        }),
      ]);
      const current = await this.target(workspace, name, identity);
      if (
        (this.epochs.get(key) || 0) !== epoch ||
        current.grant.version !== grant.version ||
        Grant.fingerprint(current.config) !== Grant.fingerprint(config)
      )
        throw new Error("MCP connection changed during connect");
      this.clients.set(key, {
        client,
        version: grant.version,
        fingerprint: Grant.fingerprint(config),
      });
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      if (error.status === 401 || error.code === 401) {
        await Grant.clear(workspace.id, userId, name, grant.version);
        throw new Error("MCP authentication required");
      }
      throw new Error("MCP connection unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
  async tools(workspace, name, identity) {
    const client = await this.boot(workspace, name, identity);
    const userIdBefore = await caller.assert(identity, workspace);
    const captured = this.clients.get(this.key(workspace, userIdBefore, name));
    let tools;
    try {
      ({ tools } = await client.listTools());
    } catch (error) {
      if ((error.status === 401 || error.code === 401) && captured?.client === client) {
        await Grant.clear(workspace.id, userIdBefore, name, captured.version);
        if (this.clients.get(this.key(workspace, userIdBefore, name)) === captured)
          await this.closeClient(this.key(workspace, userIdBefore, name));
        throw new Error("MCP authentication required");
      }
      throw new Error("MCP tool discovery failed");
    }
    const { config, grant, userId } = await this.target(
      workspace,
      name,
      identity
    );
    const cached = this.clients.get(this.key(workspace, userId, name));
    if (cached?.client !== client || cached.version !== grant.version)
      throw new Error("MCP connection changed");
    return (tools || []).filter(
      (tool) => !(config.anythingllm.suppressedTools || []).includes(tool.name)
    );
  }
  async call(workspace, name, request, identity) {
    const tools = await this.tools(workspace, name, identity);
    if (!tools.some((tool) => tool.name === request?.name))
      throw new Error("personal_tool_not_allowed");
    return this.executeRequest(workspace, name, request, identity);
  }
  async loadCategories(workspace, name, args, identity) {
    const before = await this.target(workspace, name, identity);
    if (name !== 'redball-store' || before.config.anythingllm.categoryLoading !== true) throw new Error('invalid_category_target');
    const result = await this.call(workspace, name, { name: 'load_tool_categories', arguments: args }, identity);
    const current = await this.target(workspace, name, identity);
    if (before.grant.generation !== current.grant.generation || Grant.fingerprint(before.config) !== Grant.fingerprint(current.config)) throw new Error('category_connection_changed');
    const envelope = require('./categoryTools').parseCategoryResponse(result, args.categories, current.config.url);
    if (!envelope) return { result, envelope: null, binding: null };
    const binding = Object.freeze({});
    this.categoryBindings.set(binding, { workspaceId: workspace.id, userId: current.userId, name, generation: current.grant.generation,
      fingerprint: Grant.fingerprint(current.config), revision: envelope.catalog_revision, tools: new Set(envelope.tools.map(tool => tool.name)) });
    return { result, envelope, binding };
  }
  async callLoadedTool(workspace, name, request, identity, binding) {
    const allowed = this.categoryBindings.get(binding);
    const current = await this.target(workspace, name, identity);
    this.assertCategoryBinding(allowed, workspace, name, request, current);
    await this.boot(workspace, name, identity);
    return this.executeRequest(workspace, name, { name: request.name, arguments: request.arguments, _meta: { 'medusa/catalog_revision': allowed.revision } }, identity, allowed);
  }
  assertCategoryBinding(allowed, workspace, name, request, current) {
    if (!allowed || allowed.workspaceId !== workspace.id || allowed.userId !== current.userId || allowed.name !== name || allowed.generation !== current.grant.generation || allowed.fingerprint !== Grant.fingerprint(current.config) || current.config.anythingllm.categoryLoading !== true || !allowed.tools.has(request?.name) || (current.config.anythingllm.suppressedTools || []).includes(request.name)) throw new Error('category_tool_not_allowed');
  }
  async executeRequest(workspace, name, request, identity, categoryBinding) {
    const target = await this.target(workspace, name, identity);
    if (categoryBinding) this.assertCategoryBinding(categoryBinding, workspace, name, request, target);
    const { userId, grant } = target;
    const entry = this.clients.get(this.key(workspace, userId, name));
    if (!entry || entry.version !== grant.version)
      throw new Error("MCP connection changed");
    try {
      const result = await entry.client.callTool(request);
      const current = await this.target(workspace, name, identity);
      if (categoryBinding) this.assertCategoryBinding(categoryBinding, workspace, name, request, current);
      if (current.grant.version !== grant.version)
        throw new Error("MCP connection changed");
      return result;
    } catch (error) {
      if (error.status === 401 || error.code === 401) {
        await Grant.clear(workspace.id, userId, name, grant.version);
        await this.stop(workspace.id, name, userId);
        throw new Error("MCP authentication required");
      }
      // A tool may mutate before failing: never replay a tool request.
      throw new Error("MCP tool call failed");
    }
  }
  async closeClient(key) {
    const entry = this.clients.get(key);
    this.clients.delete(key);
    if (entry) await entry.client.close().catch(() => {});
  }
  async stop(workspaceId, name, userId) {
    const keys = new Set([...this.clients.keys(), ...this.boots.keys()]);
    for (const key of keys) {
      const [ws, user, server] = JSON.parse(key);
      if (
        (workspaceId == null || ws === workspaceId) &&
        (name == null || server === name) &&
        (userId == null || user === userId)
      ) {
        this.epochs.set(key, (this.epochs.get(key) || 0) + 1);
        await this.closeClient(key);
      }
    }
  }
  async stopAll() {
    await this.stop(null, null);
  }
}
module.exports = { PersonalMcpRuntime };
