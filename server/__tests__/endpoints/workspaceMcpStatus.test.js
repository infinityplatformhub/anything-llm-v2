/* global jest */
const { describe, beforeEach, it, expect } = require("@jest/globals");
require("../utils/lark/_polyfill");
jest.mock("../../models/workspace", () => ({ Workspace: { get: jest.fn() } }));
jest.mock("../../models/workspaceMcpConnection", () => ({
  WorkspaceMcpConnection: {
    list: jest.fn(),
    find: jest.fn(),
    setEnabled: jest.fn(),
  },
}));
jest.mock("../../utils/MCP", () => jest.fn());
jest.mock("../../models/systemSettings");
const { Workspace } = require("../../models/workspace");
const {
  WorkspaceMcpConnection,
} = require("../../models/workspaceMcpConnection");
const MCPCompatibilityLayer = require("../../utils/MCP");
const { SystemSettings } = require("../../models/systemSettings");
const { validatedRequest } = require("../../utils/middleware/validatedRequest");
const { mcpServersEndpoints } = require("../../endpoints/mcpServers");

let routes, stopWorkspaceServer;
async function invoke(
  method = "get",
  body = {},
  slug = "legal",
  user = { role: "admin" }
) {
  const route = routes[method];
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
  const request = {
    params: { slug },
    body,
    headers: {},
    header: () => undefined,
  };
  let allowed = false;
  await route.middlewares[1](request, response, () => {
    allowed = true;
  });
  if (allowed) await route.handler(request, response);
  return response;
}

describe("workspace MCP status and toggle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    routes = {};
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    Workspace.get.mockResolvedValue({ id: 5, slug: "legal" });
    WorkspaceMcpConnection.list.mockResolvedValue([
      {
        server_name: "flowaccount",
        enabled: true,
        access_token: "secret-access",
        refresh_token: "secret-refresh",
        company_label: "Company",
        expires_at: "2030-01-01",
      },
      { server_name: "plain", enabled: false, access_token: null },
    ]);
    WorkspaceMcpConnection.find.mockResolvedValue(null);
    WorkspaceMcpConnection.setEnabled.mockImplementation(
      async (_id, serverName, enabled) => ({ server_name: serverName, enabled })
    );
    stopWorkspaceServer = jest.fn().mockResolvedValue(undefined);
    MCPCompatibilityLayer.mockImplementation(() => ({
      stopWorkspaceServer,
      mcpServerConfigs: [
        {
          name: "flowaccount",
          server: { anythingllm: { perWorkspaceAuth: true } },
        },
        { name: "plain", server: {} },
        { name: "missing-row", server: {} },
      ],
    }));
    mcpServersEndpoints({
      get(path, middlewares, handler) {
        if (path === "/workspace/:slug/mcp")
          routes.get = { middlewares, handler };
      },
      post(path, middlewares, handler) {
        if (path === "/workspace/:slug/mcp/toggle")
          routes.post = { middlewares, handler };
      },
    });
  });

  it.each(["get", "post"])(
    "retains authentication and admin guard for %s",
    async (method) => {
      expect(routes[method].middlewares[0]).toBe(validatedRequest);
      expect((await invoke(method, {}, "legal", null)).statusCode).toBe(401);
      expect(
        (await invoke(method, {}, "legal", { role: "default" })).statusCode
      ).toBe(401);
      expect(Workspace.get).not.toHaveBeenCalled();
    }
  );

  it("returns complete catalog with safe connection status", async () => {
    const response = await invoke();
    expect(response.statusCode).toBe(200);
    expect(response.body.connections).toEqual([
      {
        serverName: "flowaccount",
        enabled: true,
        connected: true,
        needsReauth: false,
        companyLabel: "Company",
        expiresAt: "2030-01-01",
      },
      {
        serverName: "plain",
        enabled: false,
        connected: false,
        needsReauth: false,
        companyLabel: null,
        expiresAt: null,
      },
      {
        serverName: "missing-row",
        enabled: false,
        connected: false,
        needsReauth: false,
        companyLabel: null,
        expiresAt: null,
      },
    ]);
    expect(JSON.stringify(response.body)).not.toMatch(
      /access_token|refresh_token|secret-/
    );
    expect(WorkspaceMcpConnection.list).toHaveBeenCalledWith(5);
  });

  it.each([
    ["refresh-token", false],
    [null, true],
  ])(
    "reports needsReauth for refresh token %p",
    async (refresh_token, needsReauth) => {
      WorkspaceMcpConnection.list.mockResolvedValue([
        {
          server_name: "flowaccount",
          access_token: "access-token",
          refresh_token,
        },
      ]);
      const response = await invoke();
      expect(response.body.connections[0].needsReauth).toBe(needsReauth);
    }
  );

  it("enables ordinary server and returns safe row", async () => {
    const response = await invoke("post", {
      serverName: "plain",
      enabled: true,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      success: true,
      connection: {
        serverName: "plain",
        enabled: true,
        connected: false,
        needsReauth: false,
        companyLabel: null,
        expiresAt: null,
      },
    });
    expect(WorkspaceMcpConnection.setEnabled).toHaveBeenCalledWith(
      5,
      "plain",
      true
    );
  });

  it("rejects OAuth enable before connection without writing row", async () => {
    expect(
      (await invoke("post", { serverName: "flowaccount", enabled: true }))
        .statusCode
    ).toBe(409);
    expect(WorkspaceMcpConnection.setEnabled).not.toHaveBeenCalled();
  });

  it("allows connected OAuth server and never returns tokens", async () => {
    const row = {
      enabled: true,
      access_token: "secret-access",
      refresh_token: "secret-refresh",
    };
    WorkspaceMcpConnection.find.mockResolvedValue(row);
    WorkspaceMcpConnection.setEnabled.mockResolvedValue(row);
    const response = await invoke("post", {
      serverName: "flowaccount",
      enabled: true,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.connection.connected).toBe(true);
    expect(JSON.stringify(response.body)).not.toMatch(
      /access_token|refresh_token|secret-/
    );
  });

  it("allows disabling unconnected OAuth server", async () => {
    expect(
      (await invoke("post", { serverName: "flowaccount", enabled: false }))
        .statusCode
    ).toBe(200);
    expect(WorkspaceMcpConnection.setEnabled).toHaveBeenCalledWith(
      5,
      "flowaccount",
      false
    );
  });

  it.each([false, true])(
    "stops workspace client only when enabled is false: %s",
    async (enabled) => {
      WorkspaceMcpConnection.find.mockResolvedValue({ access_token: "token" });
      const response = await invoke("post", {
        serverName: "flowaccount",
        enabled,
      });
      expect(response.statusCode).toBe(200);
      expect(WorkspaceMcpConnection.setEnabled).toHaveBeenCalledWith(
        5,
        "flowaccount",
        enabled
      );
      if (enabled) expect(stopWorkspaceServer).not.toHaveBeenCalled();
      else expect(stopWorkspaceServer).toHaveBeenCalledWith(5, "flowaccount");
    }
  );

  it("returns failure when stopping disabled workspace client fails", async () => {
    stopWorkspaceServer.mockRejectedValue(new Error("close failed"));
    const response = await invoke("post", {
      serverName: "flowaccount",
      enabled: false,
    });
    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(WorkspaceMcpConnection.setEnabled).toHaveBeenCalledWith(
      5,
      "flowaccount",
      false
    );
  });

  it("rejects unknown server", async () => {
    expect(
      (await invoke("post", { serverName: "unknown", enabled: true }))
        .statusCode
    ).toBe(404);
    expect(WorkspaceMcpConnection.setEnabled).not.toHaveBeenCalled();
  });

  it.each(["get", "post"])(
    "rejects unknown workspace for %s",
    async (method) => {
      Workspace.get.mockResolvedValue(null);
      expect(
        (
          await invoke(
            method,
            { serverName: "plain", enabled: true },
            "missing"
          )
        ).statusCode
      ).toBe(404);
      expect(WorkspaceMcpConnection.setEnabled).not.toHaveBeenCalled();
    }
  );

  it.each(["", " ", [], null])("rejects malformed slug %p", async (slug) => {
    for (const method of ["get", "post"])
      expect((await invoke(method, {}, slug)).statusCode).toBe(400);
    expect(Workspace.get).not.toHaveBeenCalled();
  });

  it.each([
    { serverName: "plain", enabled: "true" },
    { serverName: [], enabled: true },
    {},
  ])("rejects malformed toggle %p", async (body) => {
    expect((await invoke("post", body)).statusCode).toBe(400);
    expect(WorkspaceMcpConnection.setEnabled).not.toHaveBeenCalled();
  });
});
