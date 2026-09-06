const http = require("http");
const crypto = require("crypto");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");

function json(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

class MockMcp {
  constructor() {
    this.requests = [];
    this.errors = [];
    this.clients = new Map();
    this.codes = new Map();
    this.accessTokens = new Map();
    this.refreshTokens = new Map();
    this.issued = [];
    this.refreshMode = "ok";
    this.label = "Company A";
  }

  requestsFor(pathname) {
    return this.requests.filter((request) => request.pathname === pathname);
  }

  issue(label) {
    const access_token = `mcp-access-${crypto.randomUUID()}`;
    const refresh_token = `mcp-refresh-${crypto.randomUUID()}`;
    this.accessTokens.set(access_token, label);
    this.refreshTokens.set(refresh_token, label);
    const pair = {
      access_token,
      refresh_token,
      expires_in: 3600,
      token_type: "Bearer",
    };
    this.issued.push(pair);
    return pair;
  }

  async handle(request, response) {
    const url = new URL(request.url, this.origin);
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw
      ? request.headers["content-type"]?.includes("application/json")
        ? JSON.parse(raw)
        : Object.fromEntries(new URLSearchParams(raw))
      : {};
    this.requests.push({
      pathname: url.pathname,
      method: request.method,
      query: Object.fromEntries(url.searchParams),
      headers: request.headers,
      body,
    });
    if (url.pathname === "/.well-known/oauth-protected-resource")
      return json(response, 200, {
        resource: this.origin,
        authorization_servers: [this.origin],
      });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(response, 200, {
        issuer: this.origin,
        authorization_endpoint: `${this.origin}/oauth/authorize`,
        token_endpoint: `${this.origin}/oauth/token`,
        registration_endpoint: `${this.origin}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [
          "openid",
          "profile",
          "flowaccount-api",
          "offline_access",
        ],
      });
    if (url.pathname === "/oauth/register") {
      const client_id = crypto.randomUUID();
      this.clients.set(client_id, body);
      return json(response, 201, { client_id });
    }
    if (url.pathname === "/oauth/authorize") {
      const params = Object.fromEntries(url.searchParams);
      const client = this.clients.get(params.client_id);
      if (
        !client?.redirect_uris.includes(params.redirect_uri) ||
        !params.state ||
        params.code_challenge_method !== "S256" ||
        !/^[\w-]{43}$/.test(params.code_challenge)
      )
        return json(response, 400, { error: "invalid_request" });
      const target = new URL(params.redirect_uri);
      target.searchParams.set("state", params.state);
      if (params.deny === "1")
        target.searchParams.set("error", "access_denied");
      else {
        const code = crypto.randomUUID();
        this.codes.set(code, { ...params, label: this.label });
        target.searchParams.set("code", code);
      }
      response.writeHead(302, { Location: target.toString() });
      return response.end();
    }
    if (url.pathname === "/oauth/token") {
      if (body.grant_type === "authorization_code") {
        const code = this.codes.get(body.code);
        if (
          !code ||
          code.client_id !== body.client_id ||
          code.redirect_uri !== body.redirect_uri ||
          crypto
            .createHash("sha256")
            .update(body.code_verifier || "")
            .digest("base64url") !== code.code_challenge
        )
          return json(response, 400, { error: "invalid_grant" });
        this.codes.delete(body.code);
        return json(response, 200, this.issue(code.label));
      }
      if (body.grant_type === "refresh_token") {
        if (this.refreshMode === "unavailable")
          return json(response, 503, {
            error: "temporarily_unavailable",
            error_description: body.refresh_token,
          });
        const label = this.refreshTokens.get(body.refresh_token);
        if (this.refreshMode === "invalid_grant" || !label)
          return json(response, 400, {
            error: "invalid_grant",
            error_description: body.refresh_token,
          });
        this.refreshTokens.delete(body.refresh_token);
        return json(response, 200, this.issue(label));
      }
      return json(response, 400, { error: "unsupported_grant_type" });
    }
    if (["/mcp", "/plain"].includes(url.pathname)) {
      const label =
        url.pathname === "/plain"
          ? "Public company"
          : this.accessTokens.get(
              request.headers.authorization?.replace(/^Bearer /, "")
            );
      if (!label) return json(response, 401, { error: "unauthorized" });
      if (request.method !== "POST")
        return json(response, 405, { error: "method_not_allowed" });
      const mcp = new McpServer({ name: "fake-company", version: "1.0.0" });
      mcp.registerTool(
        "get_company_info",
        { description: "Read token owner's company", inputSchema: {} },
        async () => ({ content: [{ type: "text", text: label }] })
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      response.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      return transport.handleRequest(request, response, body);
    }
    return json(response, 404, { error: "not_found" });
  }

  async start() {
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        this.errors.push(error.message);
        if (!response.headersSent)
          json(response, 500, { error: "fake_failed" });
        else response.end();
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    this.origin = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }

  async stop() {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

module.exports = { MockMcp };
