/* global jest */
const { describe, it, expect, afterEach } = require("@jest/globals");
const fs = require("fs");

jest.mock("../../../utils/http", () => ({
  reqBody: (request) => request.body,
}));
jest.mock("../../../models/workspace", () => ({
  Workspace: { get: jest.fn().mockResolvedValue({ id: 7 }) },
}));
jest.mock("../../../models/workspaceMcpConnection", () => ({
  WorkspaceMcpConnection: { setEnabled: jest.fn(), clearTokens: jest.fn() },
}));
jest.mock("../../../utils/prisma", () => ({
  lark_oauth_states: {
    findMany: jest.fn().mockResolvedValue([]),
    deleteMany: jest.fn(),
  },
}));
jest.mock("../../../utils/EncryptionManager", () => ({
  EncryptionManager: jest.fn(),
}));
jest.mock("../../../utils/middleware/validatedRequest", () => ({
  validatedRequest: jest.fn(),
}));
jest.mock("../../../utils/middleware/multiUserProtected", () => ({
  flexUserRoleValid: jest.fn(),
  ROLES: { admin: "admin" },
}));
jest.mock("../../../utils/helpers/shell", () => ({
  patchShellEnvironmentPath: jest.fn(),
}));
jest.mock("../../../utils/MCP/oauth", () => ({}));

afterEach(() => jest.restoreAllMocks());

describe("MCP singleton initialization order", () => {
  it.each([true, false])(
    "preserves agent methods when OAuth initializes first: %s",
    async (oauthFirst) => {
      let Layer, Hypervisor, disconnect, initial;
      jest.spyOn(console, "log").mockImplementation(() => {});
      jest.resetModules();
      const existsSync = fs.existsSync;
      jest
        .spyOn(fs, "existsSync")
        .mockImplementation((filePath) =>
          String(filePath).endsWith("anythingllm_mcp_servers.json")
            ? true
            : existsSync(filePath)
        );
      try {
        Hypervisor = require("../../../utils/MCP/hypervisor");
        Hypervisor._instance = undefined;
        Layer = require("../../../utils/MCP");
        Layer._instance = undefined;
        if (!oauthFirst) initial = new Layer();
        const { mcpOAuthEndpoints } = require("../../../endpoints/mcpOAuth");
        mcpOAuthEndpoints({
          get: jest.fn(),
          post: (_path, _middleware, handler) => (disconnect = handler),
        });
        jest
          .spyOn(Hypervisor.prototype, "mcpServerConfigs", "get")
          .mockReturnValue([
            {
              name: "remote",
              server: {
                url: "https://mcp.example/mcp",
                anythingllm: { perWorkspaceAuth: true },
              },
            },
          ]);
        const response = {
          status: jest.fn().mockReturnThis(),
          json: jest.fn().mockReturnThis(),
        };
        await disconnect(
          { body: { workspaceSlug: "workspace", serverName: "remote" } },
          response
        );
        expect(response.status).toHaveBeenCalledWith(200);
        const layer = new Layer();
        expect(layer).toBe(Hypervisor._instance);
        if (initial) expect(layer).toBe(initial);
        expect(typeof layer.activeMCPServers).toBe("function");
        expect(typeof layer.servers).toBe("function");
        expect(typeof layer.convertServerToolsToPlugins).toBe("function");
      } finally {
        if (Hypervisor) Hypervisor._instance = undefined;
        if (Layer) Layer._instance = undefined;
      }
    }
  );
});
