/* global jest */
const { describe, beforeEach, afterAll, it, expect } = require("@jest/globals");

jest.mock(
  "../../../utils/MCP/hypervisor",
  () =>
    class {
      constructor() {
        this.mcps = { flowaccount: {}, other: {} };
        this.mcpServerConfigs = [
          { name: "flowaccount", server: {} },
          { name: "other", server: {} },
        ];
        this.bootMCPServers = jest.fn().mockResolvedValue(undefined);
      }
    }
);
jest.mock(
  "../../../models/workspaceMcpConnection",
  () => ({ WorkspaceMcpConnection: { list: jest.fn() } }),
  { virtual: true }
);
const {
  WorkspaceMcpConnection,
} = require("../../../models/workspaceMcpConnection");
const MCPCompatibilityLayer = require("../../../utils/MCP");

describe("workspace MCP connection model", () => {
  const { randomUUID } = require("crypto");
  const prisma = require("../../../utils/prisma");
  const { WorkspaceMcpConnection: model } = jest.requireActual(
    "../../../models/workspaceMcpConnection"
  );
  afterAll(async () => prisma.$disconnect());

  it("keeps allowlist and credentials scoped and independently updated", async () => {
    const ids = [];
    try {
      for (let i = 0; i < 2; i++) {
        const row = await prisma.workspaces.create({
          data: { name: "MCP model test", slug: `mcp-model-${randomUUID()}` },
        });
        ids.push(row.id);
      }
      const [first, second] = ids;
      expect(await model.list(first)).toEqual([]);
      expect(await model.isAllowed(first, "flowaccount")).toBe(false);
      await model.saveTokens(first, "flowaccount", {
        access_token: "first-token",
        refresh_token: "refresh-token",
        expires_at: new Date(Date.now() + 60000),
        company_label: "Test company",
      });
      expect(await model.isAllowed(first, "flowaccount")).toBe(false);
      await model.setEnabled(first, "flowaccount", true);
      expect(await model.enabledNames(first)).toEqual(["flowaccount"]);
      expect(await model.isAllowed(first, "flowaccount")).toBe(true);
      expect(await model.find(second, "flowaccount")).toBeNull();
      await model.setEnabled(second, "flowaccount", true);
      await model.saveTokens(first, "flowaccount", {
        access_token: "new-token",
      });
      expect(await model.find(first, "flowaccount")).toMatchObject({
        enabled: true,
        access_token: "new-token",
        refresh_token: "refresh-token",
      });
      await model.clearTokens(first, "flowaccount");
      expect(await model.find(first, "flowaccount")).toMatchObject({
        enabled: true,
        access_token: null,
        refresh_token: null,
        expires_at: null,
        company_label: null,
      });
      await model.setEnabled(first, "flowaccount", false);
      expect(await model.enabledNames(first)).toEqual([]);
      expect(await model.isAllowed(second, "flowaccount")).toBe(true);
      await expect(model.clearTokens(first, "missing")).resolves.toEqual({
        count: 0,
      });
    } finally {
      await prisma.workspaces.deleteMany({ where: { id: { in: ids } } });
    }
  });
});

describe("workspace MCP gating", () => {
  let layer;
  beforeEach(() => {
    MCPCompatibilityLayer._instance = undefined;
    layer = new MCPCompatibilityLayer();
    WorkspaceMcpConnection.list.mockReset().mockResolvedValue([]);
  });

  it("denies all servers when workspace has no connections", async () => {
    expect(await layer.activeMCPServers({ id: 1 })).toEqual([]);
  });

  it("includes only enabled running servers", async () => {
    WorkspaceMcpConnection.list.mockResolvedValue([
      { server_name: "flowaccount", enabled: true },
      { server_name: "other", enabled: false },
      { server_name: "offline", enabled: true },
    ]);
    expect(await layer.activeMCPServers({ id: 1 })).toEqual([
      "@@mcp_flowaccount",
    ]);
  });

  it("fails closed for an invalid supplied workspace", async () => {
    for (const workspace of [null, {}, { id: "1" }, { id: 0 }]) {
      expect(await layer.activeMCPServers(workspace)).toEqual([]);
    }
    expect(WorkspaceMcpConnection.list).not.toHaveBeenCalled();
    expect(layer.bootMCPServers).not.toHaveBeenCalled();
  });

  it("preserves unfiltered admin behavior without workspace", async () => {
    expect(await layer.activeMCPServers()).toEqual([
      "@@mcp_flowaccount",
      "@@mcp_other",
    ]);
    expect(WorkspaceMcpConnection.list).not.toHaveBeenCalled();
    expect(layer.bootMCPServers).toHaveBeenCalledWith();
  });

  it("requires access_token for perWorkspaceAuth servers", async () => {
    layer.mcpServerConfigs[0].server.anythingllm = { perWorkspaceAuth: true };
    const connection = { server_name: "flowaccount", enabled: true };
    WorkspaceMcpConnection.list.mockResolvedValue([connection]);
    expect(await layer.activeMCPServers({ id: 1 })).toEqual([]);
    connection.access_token = "workspace-token";
    expect(await layer.activeMCPServers({ id: 1 })).toEqual([
      "@@mcp_flowaccount",
    ]);
  });

  it("does not cache filtered results across workspaces or updates", async () => {
    WorkspaceMcpConnection.list.mockImplementation(async (workspaceId) => [
      {
        server_name: workspaceId === 1 ? "flowaccount" : "other",
        enabled: true,
      },
    ]);
    expect(await layer.activeMCPServers({ id: 1 })).toEqual([
      "@@mcp_flowaccount",
    ]);
    const sameLayer = new MCPCompatibilityLayer();
    expect(sameLayer).toBe(layer);
    expect(await sameLayer.activeMCPServers({ id: 2 })).toEqual([
      "@@mcp_other",
    ]);
    WorkspaceMcpConnection.list.mockResolvedValue([]);
    expect(await layer.activeMCPServers({ id: 1 })).toEqual([]);
    expect(Object.keys(layer.mcps)).toEqual(["flowaccount", "other"]);
  });
});
