const { safeJsonParse } = require("../../http");
const path = require("path");
const fs = require("fs");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");
const {
  SSEClientTransport,
} = require("@modelcontextprotocol/sdk/client/sse.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { patchShellEnvironmentPath } = require("../../helpers/shell");
const {
  WorkspaceMcpConnection,
} = require("../../../models/workspaceMcpConnection");
const { refreshTokens } = require("../oauth");

/**
 * @typedef {'stdio' | 'http'} MCPServerTypes
 */

/**
 * @class MCPHypervisor
 * @description A class that manages MCP servers found in the storage/plugins/anythingllm_mcp_servers.json file.
 * This class is responsible for booting, stopping, and reloading MCP servers - it is the user responsibility for the MCP server definitions
 * to me correct and also functioning tools depending on their deployment (docker vs local) as well as the security of said tools
 * since MCP is basically arbitrary code execution.
 *
 * @notice This class is a singleton.
 * @notice Each MCP tool has dependencies specific to it and this call WILL NOT check for them.
 * For example, if the tools requires `npx` then the context in which AnythingLLM mains process is running will need to access npx.
 * This is typically not common in our pre-built image so may not function. But this is the case anywhere MCP is used.
 *
 * AnythingLLM will take care of porting MCP servers to agent-callable functions via @agent directive.
 * @see MCPCompatibilityLayer.convertServerToolsToPlugins
 */
class MCPHypervisor {
  static _instance;
  /**
   * The path to the JSON file containing the MCP server definitions.
   * @type {string}
   */
  mcpServerJSONPath;

  /**
   * The MCP servers currently running.
   * @type { { [key: string]: Client & {transport: {_process: import('child_process').ChildProcess}, aibitatToolIds: string[]} } }
   */
  mcps = {};
  /**
   * The results of the MCP server loading process.
   * @type { { [key: string]: {status: 'success' | 'failed', message: string} } }
   */
  mcpLoadingResults = {};
  workspaceBoots = new Map();

  workspaceServerKey(workspace, name) {
    if (!Number.isInteger(workspace?.id) || workspace.id <= 0)
      throw new Error("MCP workspace is required");
    return `${workspace.id}:${name}`;
  }

  async stopWorkspaceServer(workspaceId, serverName) {
    const key = this.workspaceServerKey({ id: workspaceId }, serverName);
    const pending = this.workspaceBoots.get(key);
    this.workspaceBoots.delete(key);
    if (pending) await pending.catch(() => {});
    const client = this.mcps[key];
    delete this.mcps[key];
    if (client) await client.close();
  }

  async markWorkspaceReauth(workspace, name) {
    await this.stopWorkspaceServer(workspace.id, name);
    await WorkspaceMcpConnection.saveTokens(workspace.id, name, {
      refresh_token: null,
      expires_at: new Date(0),
    });
  }

  async refreshWorkspaceTokens(workspace, name, server, connection) {
    if (!connection.refresh_token)
      throw new Error("MCP authentication required");
    let tokens;
    try {
      tokens = await refreshTokens(connection.refresh_token, server.url);
    } catch (error) {
      if (
        error.status === 401 ||
        (error.status === 400 && error.code === "invalid_grant")
      ) {
        await WorkspaceMcpConnection.saveTokens(workspace.id, name, {
          refresh_token: null,
          expires_at: new Date(0),
        });
        throw new Error("MCP authentication required");
      }
      throw new Error("MCP token refresh unavailable");
    }
    const current = await WorkspaceMcpConnection.find(workspace.id, name);
    if (
      !current?.enabled ||
      current.access_token !== connection.access_token ||
      current.refresh_token !== connection.refresh_token
    )
      throw new Error("MCP connection changed during refresh");
    await WorkspaceMcpConnection.saveTokens(workspace.id, name, tokens);
    return { ...connection, ...tokens };
  }

  async bootWorkspaceServer(workspace, serverName, retryAuth = true) {
    const key = this.workspaceServerKey(workspace, serverName);
    if (this.workspaceBoots.has(key)) return this.workspaceBoots.get(key);
    const pending = this.connectWorkspaceServer(
      workspace,
      serverName,
      retryAuth
    );
    this.workspaceBoots.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.workspaceBoots.get(key) === pending)
        this.workspaceBoots.delete(key);
    }
  }

  async connectWorkspaceServer(workspace, name, retryAuth) {
    const key = this.workspaceServerKey(workspace, name);
    const server = this.mcpServerConfigs.find((s) => s.name === name)?.server;
    if (!server?.anythingllm?.perWorkspaceAuth)
      throw new Error("MCP workspace authentication is not configured");
    const transport = this.#parseServerType(server);
    if (transport !== "http")
      throw new Error(
        "MCP perWorkspaceAuth requires a remote transport; stdio is not supported"
      );
    this.#validateServerDefinitionByType(name, server, "http");
    let connection = await WorkspaceMcpConnection.find(workspace.id, name);
    if (
      !connection?.enabled ||
      !connection.access_token ||
      !connection.refresh_token
    )
      throw new Error("MCP authentication required");
    const expiring =
      connection.expires_at &&
      new Date(connection.expires_at).getTime() < Date.now() + 60000;
    const existing = this.mcps[key];
    if (
      existing &&
      !expiring &&
      existing.workspaceAccessToken === connection.access_token
    )
      return existing;
    if (existing) {
      delete this.mcps[key];
      await existing.close();
    }
    if (expiring)
      connection = await this.refreshWorkspaceTokens(
        workspace,
        name,
        server,
        connection
      );

    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = new Headers(server.headers);
      headers.set("Authorization", `Bearer ${connection.access_token}`);
      const client = new Client({ name, version: "1.0.0" });
      const transport = this.createHttpTransport({
        ...server,
        headers: Object.fromEntries(headers),
      });
      let timeout;
      try {
        await Promise.race([
          client.connect(transport),
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("MCP connection timeout")),
              30000
            );
          }),
        ]);
        client.workspaceAccessToken = connection.access_token;
        this.mcps[key] = client;
        return client;
      } catch (error) {
        await client.close().catch(() => {});
        if (error.status !== 401 && error.code !== 401)
          throw new Error("MCP connection failed");
        if (attempt === 1 || !retryAuth) {
          await WorkspaceMcpConnection.saveTokens(workspace.id, name, {
            refresh_token: null,
            expires_at: new Date(0),
          });
          throw new Error("MCP authentication required");
        }
        connection = await this.refreshWorkspaceTokens(
          workspace,
          name,
          server,
          connection
        );
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  async callWorkspaceTool(workspace, name, args) {
    let client = await this.bootWorkspaceServer(workspace, name);
    try {
      return await client.callTool(args);
    } catch (error) {
      if (error.status !== 401 && error.code !== 401)
        throw new Error("MCP tool call failed");
    }
    await this.stopWorkspaceServer(workspace.id, name);
    const server = this.mcpServerConfigs.find((s) => s.name === name)?.server;
    const connection = await WorkspaceMcpConnection.find(workspace.id, name);
    if (!connection?.enabled || !connection.access_token)
      throw new Error("MCP authentication required");
    await this.refreshWorkspaceTokens(workspace, name, server, connection);
    client = await this.bootWorkspaceServer(workspace, name, false);
    try {
      return await client.callTool(args);
    } catch (error) {
      if (error.status === 401 || error.code === 401) {
        await this.markWorkspaceReauth(workspace, name);
        throw new Error("MCP authentication required");
      }
      throw new Error("MCP tool call failed");
    }
  }

  constructor() {
    if (MCPHypervisor._instance) return MCPHypervisor._instance;
    MCPHypervisor._instance = this;
    this.className = "MCPHypervisor";
    this.log("Initializing MCP Hypervisor - subsequent calls will boot faster");
    this.#setupConfigFile();
    return this;
  }

  /**
   * Setup the MCP server definitions file.
   * Will create the file/directory if it doesn't exist already in storage/plugins with blank options
   */
  #setupConfigFile() {
    this.mcpServerJSONPath =
      process.env.NODE_ENV === "development"
        ? path.resolve(
            __dirname,
            `../../../storage/plugins/anythingllm_mcp_servers.json`
          )
        : path.resolve(
            process.env.STORAGE_DIR ??
              path.resolve(__dirname, `../../../storage`),
            `plugins/anythingllm_mcp_servers.json`
          );

    if (!fs.existsSync(this.mcpServerJSONPath)) {
      fs.mkdirSync(path.dirname(this.mcpServerJSONPath), { recursive: true });
      fs.writeFileSync(
        this.mcpServerJSONPath,
        JSON.stringify({ mcpServers: {} }, null, 2),
        { encoding: "utf8" }
      );
    }

    this.log(`MCP Config File: ${this.mcpServerJSONPath}`);
  }

  log(text, ...args) {
    console.log(`\x1b[36m[${this.className}]\x1b[0m ${text}`, ...args);
  }

  /**
   * Get the MCP servers from the JSON file.
   * @returns { { name: string, server: { command: string, args: string[], env: { [key: string]: string } } }[] } The MCP servers.
   */
  get mcpServerConfigs() {
    const servers = safeJsonParse(
      fs.readFileSync(this.mcpServerJSONPath, "utf8"),
      { mcpServers: {} }
    );
    return Object.entries(servers.mcpServers).map(([name, server]) => ({
      name,
      server,
    }));
  }

  /**
   * Remove the MCP server from the config file
   * @param {string} name - The name of the MCP server to remove
   * @returns {boolean} - True if the MCP server was removed, false otherwise
   */
  removeMCPServerFromConfig(name) {
    const servers = safeJsonParse(
      fs.readFileSync(this.mcpServerJSONPath, "utf8"),
      { mcpServers: {} }
    );
    if (!servers.mcpServers[name]) return false;

    delete servers.mcpServers[name];
    fs.writeFileSync(
      this.mcpServerJSONPath,
      JSON.stringify(servers, null, 2),
      "utf8"
    );
    this.log(`MCP server ${name} removed from config file`);
    return true;
  }

  /**
   * Update the suppressed tools for an MCP server
   * @param {string} serverName - The name of the MCP server
   * @param {string} toolName - The name of the tool to toggle
   * @param {boolean} enabled - Whether the tool should be enabled (true) or suppressed (false)
   * @returns {{success: boolean, error: string | null, suppressedTools: string[]}}
   */
  updateSuppressedTools(serverName, toolName, enabled) {
    const servers = safeJsonParse(
      fs.readFileSync(this.mcpServerJSONPath, "utf8"),
      { mcpServers: {} }
    );

    if (!servers.mcpServers[serverName]) {
      return {
        success: false,
        error: `MCP server ${serverName} not found in config file.`,
        suppressedTools: [],
      };
    }

    const server = servers.mcpServers[serverName];
    if (!server.anythingllm) server.anythingllm = {};
    if (!Array.isArray(server.anythingllm.suppressedTools))
      server.anythingllm.suppressedTools = [];

    const suppressedTools = server.anythingllm.suppressedTools;

    if (enabled) {
      const index = suppressedTools.indexOf(toolName);
      if (index > -1) suppressedTools.splice(index, 1);
    } else {
      if (!suppressedTools.includes(toolName)) suppressedTools.push(toolName);
    }

    server.anythingllm.suppressedTools = suppressedTools;
    servers.mcpServers[serverName] = server;

    fs.writeFileSync(
      this.mcpServerJSONPath,
      JSON.stringify(servers, null, 2),
      "utf8"
    );

    this.log(
      `MCP server ${serverName} tool ${toolName} ${enabled ? "enabled" : "suppressed"}`
    );
    return { success: true, error: null, suppressedTools };
  }

  /**
   * Get the suppressed tools for an MCP server
   * @param {string} serverName - The name of the MCP server
   * @returns {string[]} - Array of suppressed tool names
   */
  getSuppressedTools(serverName) {
    const config = this.mcpServerConfigs.find((s) => s.name === serverName);
    return config?.server?.anythingllm?.suppressedTools || [];
  }

  /**
   * Reload the MCP servers - can be used to reload the MCP servers without restarting the server or app
   * and will also apply changes to the config file if any where made.
   */
  async reloadMCPServers() {
    this.pruneMCPServers();
    await this.bootMCPServers();
  }

  /**
   * Start a single MCP server by its server name - public method
   * @param {string} name - The name of the MCP server to start
   * @returns {Promise<{success: boolean, error: string | null}>}
   */
  async startMCPServer(name) {
    if (this.mcps[name])
      return { success: false, error: `MCP server ${name} already running` };
    const config = this.mcpServerConfigs.find((s) => s.name === name);
    if (!config)
      return {
        success: false,
        error: `MCP server ${name} not found in config file`,
      };

    if (config.server?.anythingllm?.perWorkspaceAuth)
      return {
        success: false,
        error: "MCP server requires workspace authentication",
      };

    try {
      await this.#startMCPServer(config);
      this.mcpLoadingResults[name] = {
        status: "success",
        message: `Successfully connected to MCP server: ${name}`,
      };

      return { success: true, message: `MCP server ${name} started` };
    } catch (e) {
      this.log(`Failed to start single MCP server: ${name}`, {
        error: e.message,
        code: e.code,
        syscall: e.syscall,
        path: e.path,
        stack: e.stack,
      });
      this.mcpLoadingResults[name] = {
        status: "failed",
        message: `Failed to start MCP server: ${name} [${e.code || "NO_CODE"}] ${e.message}`,
      };

      // Clean up failed connection
      if (this.mcps[name]) {
        this.mcps[name].close();
        delete this.mcps[name];
      }

      return { success: false, error: e.message };
    }
  }
  /**
   * Prune a single MCP server by its server name
   * @param {string} name - The name of the MCP server to prune
   * @returns {boolean} - True if the MCP server was pruned, false otherwise
   */
  pruneMCPServer(name) {
    if (!name || !this.mcps[name]) return true;

    this.log(`Pruning MCP server: ${name}`);
    const mcp = this.mcps[name];
    if (!mcp.transport) return true;
    const childProcess = mcp.transport._process;
    if (childProcess) childProcess.kill("SIGTERM");
    mcp.transport.close();

    delete this.mcps[name];
    this.mcpLoadingResults[name] = {
      status: "failed",
      message: `Server was stopped manually by the administrator.`,
    };
    return true;
  }

  /**
   * Prune the MCP servers - pkills and forgets all MCP servers
   * @returns {void}
   */
  pruneMCPServers() {
    this.log(`Pruning ${Object.keys(this.mcps).length} MCP servers...`);

    for (const name of Object.keys(this.mcps)) {
      if (!this.mcps[name]) continue;
      const mcp = this.mcps[name];
      if (!mcp.transport) continue;
      const childProcess = mcp.transport._process;
      if (childProcess)
        this.log(`Killing MCP ${name} (PID: ${childProcess.pid})`, {
          killed: childProcess.kill("SIGTERM"),
        });

      mcp.transport.close();
      mcp.close();
    }
    this.mcps = {};
    this.mcpLoadingResults = {};
  }

  /**
   * Build the MCP server environment variables - ensures proper PATH and NODE_PATH
   * inheritance across all platforms and deployment scenarios.
   * @param {Object} server - The server definition
   * @returns {Promise<{env: { [key: string]: string } | {}}}> - The environment variables
   */
  async #buildMCPServerENV(server) {
    const shellEnv = await patchShellEnvironmentPath();
    let baseEnv = {
      PATH:
        shellEnv.PATH ||
        process.env.PATH ||
        "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      NODE_PATH:
        shellEnv.NODE_PATH ||
        process.env.NODE_PATH ||
        "/usr/local/lib/node_modules",
      ...shellEnv, // Include all shell environment variables
    };

    // Docker-specific environment setup
    if (process.env.ANYTHING_LLM_RUNTIME === "docker") {
      baseEnv = {
        // Fixed: NODE_PATH should point to modules directory, not node binary
        NODE_PATH: "/usr/local/lib/node_modules",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        ...baseEnv, // Allow inheritance to override docker defaults if needed
      };
    }

    // No custom environment specified - return base environment
    if (!server?.env || Object.keys(server.env).length === 0) {
      return { env: baseEnv };
    }

    // Merge user-specified environment with base environment
    // User environment takes precedence over defaults
    return {
      env: {
        ...baseEnv,
        ...server.env,
      },
    };
  }

  /**
   * Parse the server type from the server definition
   * @param {Object} server - The server definition
   * @returns {MCPServerTypes | null} - The server type
   */
  #parseServerType(server) {
    if (
      server.type === "sse" ||
      server.type === "streamable" ||
      server.type === "http"
    )
      return "http";
    if (Object.prototype.hasOwnProperty.call(server, "command")) return "stdio";
    if (Object.prototype.hasOwnProperty.call(server, "url")) return "http";
    return null;
  }

  /**
   * Validate the server definition by type
   * - Will throw an error if the server definition is invalid
   * @param {string} name - The name of the MCP server
   * @param {Object} server - The server definition
   * @param {MCPServerTypes} type - The server type
   * @returns {void}
   */
  #validateServerDefinitionByType(name, server, type) {
    if (type === "http") {
      // "type" is optional for http servers - when omitted, SSE is assumed
      // (see createHttpTransport). An explicit unknown value is a config error.
      if (
        server.type !== undefined &&
        !["sse", "streamable", "http"].includes(server.type)
      ) {
        throw new Error("MCP server type must have sse or streamable value.");
      }

      if (!server.url) {
        throw new Error(
          `MCP server "${name}": missing required "url" for ${server.type || "sse"} transport`
        );
      }

      try {
        new URL(server.url);
      } catch {
        throw new Error(`MCP server "${name}": invalid URL "${server.url}"`);
      }
      return;
    }

    if (type === "stdio") {
      if (
        Object.prototype.hasOwnProperty.call(server, "args") &&
        !Array.isArray(server.args)
      )
        throw new Error("MCP server args must be an array");
    }
    return;
  }

  /**
   * Setup the server transport by type and server definition
   * @param {Object} server - The server definition
   * @param {MCPServerTypes} type - The server type
   * @returns {Promise<StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport>} - The server transport
   */
  async #setupServerTransport(server, type) {
    // if not stdio then it is http or sse
    if (type !== "stdio") return this.createHttpTransport(server);

    return new StdioClientTransport({
      command: server.command,
      args: server?.args ?? [],
      ...(await this.#buildMCPServerENV(server)),
    });
  }

  /**
   * Create MCP client transport for http MCP server.
   * @param {Object} server - The server definition
   * @returns {StreamableHTTPClientTransport | SSEClientTransport} - The server transport
   */
  createHttpTransport(server) {
    const url = new URL(server.url);

    // If the server block has a type property then use that to determine the transport type
    switch (server.type) {
      case "streamable":
      case "http":
        return new StreamableHTTPClientTransport(url, {
          requestInit: {
            headers: server.headers,
          },
        });
      default:
        return new SSEClientTransport(url, {
          requestInit: {
            headers: server.headers,
          },
        });
    }
  }

  /**
   * @private Start a single MCP server by its server definition from the JSON file
   * @param {string} name - The name of the MCP server to start
   * @param {Object} server - The server definition
   * @returns {Promise<boolean>}
   */
  async #startMCPServer({ name, server }) {
    if (!name) throw new Error("MCP server name is required");
    if (!server) throw new Error("MCP server definition is required");
    const serverType = this.#parseServerType(server);
    if (!serverType) throw new Error("MCP server command or url is required");

    this.#validateServerDefinitionByType(name, server, serverType);
    this.log(`Attempting to start MCP server: ${name}`);
    const mcp = new Client({ name: name, version: "1.0.0" });
    const transport = await this.#setupServerTransport(server, serverType);

    // Add connection event listeners
    transport.onclose = () => this.log(`${name} - Transport closed`);
    transport.onerror = (error) =>
      this.log(`${name} - Transport error:`, error);
    transport.onmessage = (message) =>
      this.log(`${name} - Transport message:`, message);

    // Connect and await the connection with a timeout
    this.mcps[name] = mcp;
    const connectionPromise = mcp.connect(transport);

    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("Connection timeout")),
        30_000
      ); // 30 second timeout
    });

    try {
      await Promise.race([connectionPromise, timeoutPromise]);
      if (timeoutId) clearTimeout(timeoutId);
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);
      throw error;
    }
    return true;
  }

  /**
   * Boot the MCP servers according to the server definitions.
   * This function will skip booting MCP servers if they are already running.
   * @returns { Promise<{ [key: string]: {status: string, message: string} }> } The results of the boot process.
   */
  async bootMCPServers() {
    const serverDefinitions = this.mcpServerConfigs;
    if (
      serverDefinitions.some(
        ({ name, server }) =>
          !server.anythingllm?.perWorkspaceAuth && this.mcps[name]
      )
    ) {
      this.log("MCP Servers already running, skipping boot.");
      return this.mcpLoadingResults;
    }

    for (const { name, server } of serverDefinitions) {
      if (server.anythingllm?.perWorkspaceAuth) continue;
      if (
        server.anythingllm?.hasOwnProperty("autoStart") &&
        server.anythingllm.autoStart === false
      ) {
        this.log(
          `MCP server ${name} has anythingllm.autoStart property set to false, skipping boot!`
        );
        this.mcpLoadingResults[name] = {
          status: "failed",
          message: `MCP server ${name} has anythingllm.autoStart property set to false, boot skipped!`,
        };
        continue;
      }

      try {
        await this.#startMCPServer({ name, server });
        // Verify the connection is alive?
        // if (!(await mcp.ping())) throw new Error('Connection failed to establish');
        this.mcpLoadingResults[name] = {
          status: "success",
          message: `Successfully connected to MCP server: ${name}`,
        };
      } catch (e) {
        this.log(`Failed to start MCP server: ${name}`, {
          error: e.message,
          code: e.code,
          syscall: e.syscall,
          path: e.path,
          stack: e.stack, // Adding stack trace for better debugging
        });
        this.mcpLoadingResults[name] = {
          status: "failed",
          message: `Failed to start MCP server: ${name} [${e.code || "NO_CODE"}] ${e.message}`,
        };

        // Clean up failed connection
        if (this.mcps[name]) {
          this.mcps[name].close();
          delete this.mcps[name];
        }
      }
    }

    const runningServers = Object.keys(this.mcps);
    this.log(
      `Successfully started ${runningServers.length} MCP servers:`,
      runningServers
    );
    return this.mcpLoadingResults;
  }
}

module.exports = MCPHypervisor;
