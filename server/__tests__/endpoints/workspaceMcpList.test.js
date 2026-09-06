/* global jest */
const { describe, beforeEach, it, expect } = require("@jest/globals");
require("../utils/lark/_polyfill");
jest.mock("../../models/workspace", () => ({ Workspace: { get: jest.fn() } }));
jest.mock("../../models/workspaceMcpConnection", () => ({
  WorkspaceMcpConnection: { enabledNames: jest.fn(), find: jest.fn() },
}));
jest.mock("../../utils/MCP", () => jest.fn());

const { Workspace } = require("../../models/workspace");
const {
  WorkspaceMcpConnection,
} = require("../../models/workspaceMcpConnection");
const MCPCompatibilityLayer = require("../../utils/MCP");
jest.mock("../../models/systemSettings");
const { SystemSettings } = require("../../models/systemSettings");
const { mcpServersEndpoints } = require("../../endpoints/mcpServers");

let route;
let servers;
let bootWorkspaceServer;
let listTools;
const oauthPlaceholder = {
  name: "flowaccount",
  config: { anythingllm: { perWorkspaceAuth: true } },
  running: false,
  tools: [],
  error: null,
  process: null,
};
async function invoke(query = {}, user = { role: "admin" }) {
  const response = {
    locals: { user },
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    sendStatus(code) {
      this.statusCode = code;
      return this;
    },
    end() {
      return this;
    },
  };
  const request = { query, headers: {} };
  // Session validation has its own tests; execute the real role guard here.
  let allowed = false;
  await route.middlewares[1](request, response, () => {
    allowed = true;
  });
  if (allowed) await route.handler(request, response);
  return response;
}

describe("workspace MCP list", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    Workspace.get.mockResolvedValue({ id: 5, slug: "legal" });
    WorkspaceMcpConnection.enabledNames.mockResolvedValue(["flowaccount"]);
    servers = [{ name: "flowaccount" }, { name: "other" }];
    WorkspaceMcpConnection.find.mockResolvedValue({
      enabled: true,
      access_token: "access-secret",
      refresh_token: "refresh-secret",
    });
    listTools = jest.fn().mockResolvedValue({
      tools: [
        {
          name: "get_company_info",
          description: "Company info",
          inputSchema: {},
        },
        { name: "handle_mcp_connection_mcp_internal" },
      ],
    });
    bootWorkspaceServer = jest.fn().mockResolvedValue({ listTools });
    MCPCompatibilityLayer.mockImplementation(() => ({
      servers: async () => servers,
      bootWorkspaceServer,
    }));
    mcpServersEndpoints({
      get(path, middlewares, handler) {
        if (path === "/mcp-servers/list") route = { middlewares, handler };
      },
      post() {},
    });
  });

  it("retains session validation middleware", () => {
    const {
      validatedRequest,
    } = require("../../utils/middleware/validatedRequest");
    expect(route.middlewares[0]).toBe(validatedRequest);
  });

  it("preserves single-user role bypass", async () => {
    SystemSettings.isMultiUserMode.mockResolvedValue(false);
    expect((await invoke({}, null)).body.servers).toEqual(servers);
  });

  it("keeps unfiltered admin list without workspaceSlug", async () => {
    const response = await invoke();
    expect(response.statusCode).toBe(200);
    expect(response.body.servers).toEqual(servers);
    expect(Workspace.get).not.toHaveBeenCalled();
    expect(WorkspaceMcpConnection.enabledNames).not.toHaveBeenCalled();
  });

  it("filters by enabled names for resolved workspace", async () => {
    const response = await invoke({ workspaceSlug: "legal" });
    expect(response.body.servers).toEqual([servers[0]]);
    expect(Workspace.get).toHaveBeenCalledWith({ slug: "legal" });
    expect(WorkspaceMcpConnection.enabledNames).toHaveBeenCalledWith(5);
  });

  it("returns no servers for workspace with no enabled connections", async () => {
    WorkspaceMcpConnection.enabledNames.mockResolvedValue([]);
    expect((await invoke({ workspaceSlug: "legal" })).body.servers).toEqual([]);
  });

  it("lists workspace client tools for enabled OAuth connections", async () => {
    servers = [oauthPlaceholder];
    const response = await invoke({ workspaceSlug: "legal" });
    expect(response.body.servers).toEqual([
      {
        ...oauthPlaceholder,
        running: true,
        tools: [
          {
            name: "get_company_info",
            description: "Company info",
            inputSchema: {},
          },
        ],
      },
    ]);
    expect(bootWorkspaceServer).toHaveBeenCalledWith(
      { id: 5, slug: "legal" },
      "flowaccount"
    );
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    { enabled: true },
    { enabled: true, access_token: "access-secret" },
    {
      enabled: false,
      access_token: "access-secret",
      refresh_token: "refresh-secret",
    },
  ])(
    "does not boot OAuth connection without enabled tokens: %p",
    async (connection) => {
      servers = [oauthPlaceholder];
      WorkspaceMcpConnection.find.mockResolvedValue(connection);
      expect((await invoke({ workspaceSlug: "legal" })).body.servers).toEqual([
        oauthPlaceholder,
      ]);
      expect(bootWorkspaceServer).not.toHaveBeenCalled();
    }
  );

  it("does not boot OAuth servers absent from workspace allowlist", async () => {
    servers = [oauthPlaceholder];
    WorkspaceMcpConnection.enabledNames.mockResolvedValue([]);
    expect((await invoke({ workspaceSlug: "legal" })).body.servers).toEqual([]);
    expect(bootWorkspaceServer).not.toHaveBeenCalled();
  });

  it("keeps global OAuth catalog as placeholders without booting", async () => {
    servers = [oauthPlaceholder];
    expect((await invoke()).body.servers).toEqual([oauthPlaceholder]);
    expect(bootWorkspaceServer).not.toHaveBeenCalled();
  });

  it.each(["boot", "listTools"])(
    "returns safe placeholder on %s failure",
    async (failure) => {
      servers = [oauthPlaceholder];
      const operation = failure === "boot" ? bootWorkspaceServer : listTools;
      operation.mockRejectedValue(
        new Error("provider exposed access-secret refresh-secret")
      );
      const response = await invoke({ workspaceSlug: "legal" });
      expect(response.statusCode).toBe(200);
      expect(response.body.servers).toEqual([
        {
          ...oauthPlaceholder,
          error: "Unable to load tools for this MCP server",
        },
      ]);
      expect(JSON.stringify(response.body)).not.toContain("secret");
    }
  );

  it("rejects unknown workspace before reading allowlist", async () => {
    Workspace.get.mockResolvedValue(null);
    expect((await invoke({ workspaceSlug: "missing" })).statusCode).toBe(404);
    expect(WorkspaceMcpConnection.enabledNames).not.toHaveBeenCalled();
  });

  it.each(["", ["legal"], { slug: "legal" }])(
    "rejects malformed workspaceSlug %p",
    async (workspaceSlug) => {
      expect((await invoke({ workspaceSlug })).statusCode).toBe(400);
      expect(Workspace.get).not.toHaveBeenCalled();
      expect(WorkspaceMcpConnection.enabledNames).not.toHaveBeenCalled();
    }
  );

  it("allows manager members to list workspace tools without tokens", async () => {
    servers = [oauthPlaceholder];
    const user = { id: 7, role: "manager" };
    const response = await invoke({ workspaceSlug: "legal" }, user);
    expect(response.statusCode).toBe(200);
    expect(Workspace.get).toHaveBeenCalledWith({
      slug: "legal",
      workspace_users: { some: { user_id: user.id } },
    });
    expect(response.body.servers[0].tools[0].name).toBe("get_company_info");
    expect(JSON.stringify(response.body)).not.toMatch(
      /access_token|refresh_token|secret/
    );
  });

  it("strips server config secrets for managers but preserves admin config", async () => {
    const config = {
      anythingllm: { custom: true },
      headers: { Authorization: "Bearer plain-secret" },
      env: { API_KEY: "envsecret" },
    };
    servers = [{ name: "other", config }];
    WorkspaceMcpConnection.enabledNames.mockResolvedValue(["other"]);

    const managerResponse = await invoke(
      { workspaceSlug: "legal" },
      { id: 7, role: "manager" }
    );
    expect(managerResponse.body.servers[0].config.anythingllm).toEqual(
      config.anythingllm
    );
    expect(JSON.stringify(managerResponse.body)).not.toContain("plain-secret");
    expect(JSON.stringify(managerResponse.body)).not.toContain("envsecret");

    const adminResponse = await invoke({ workspaceSlug: "legal" });
    expect(adminResponse.body.servers[0].config).toEqual(config);
  });

  it("rejects manager non-members before reading allowlist", async () => {
    Workspace.get.mockImplementation(async ({ workspace_users }) =>
      workspace_users ? null : { id: 5, slug: "legal" }
    );
    expect(
      (await invoke({ workspaceSlug: "legal" }, { id: 7, role: "manager" }))
        .statusCode
    ).toBe(404);
    expect(WorkspaceMcpConnection.enabledNames).not.toHaveBeenCalled();
    expect(MCPCompatibilityLayer).not.toHaveBeenCalled();
  });

  it("rejects manager global catalog without workspaceSlug", async () => {
    expect((await invoke({}, { id: 7, role: "manager" })).statusCode).toBe(401);
    expect(MCPCompatibilityLayer).not.toHaveBeenCalled();
  });

  it.each([{}, { workspaceSlug: "legal" }])(
    "rejects default users for %p",
    async (query) => {
      const response = await invoke(query, { role: "default" });
      expect(response.statusCode).toBe(401);
      expect(MCPCompatibilityLayer).not.toHaveBeenCalled();
    }
  );
});
