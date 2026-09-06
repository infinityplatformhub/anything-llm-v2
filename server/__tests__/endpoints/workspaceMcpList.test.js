/* global jest */
const { describe, beforeEach, it, expect } = require("@jest/globals");
require("../utils/lark/_polyfill");
jest.mock("../../models/workspace", () => ({ Workspace: { get: jest.fn() } }));
jest.mock("../../models/workspaceMcpConnection", () => ({
  WorkspaceMcpConnection: { enabledNames: jest.fn() },
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
    MCPCompatibilityLayer.mockImplementation(() => ({
      servers: async () => servers,
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

  it.each([{}, { workspaceSlug: "legal" }])(
    "preserves admin-only role guard for %p",
    async (query) => {
      const response = await invoke(query, { role: "default" });
      expect(response.statusCode).toBe(401);
      expect(MCPCompatibilityLayer).not.toHaveBeenCalled();
    }
  );
});
