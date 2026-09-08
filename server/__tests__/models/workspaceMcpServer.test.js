/* global jest */
const {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} = require("@jest/globals");
jest.mock("../../utils/prisma", () => ({
  workspace_mcp_servers: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  workspace_mcp_connections: { deleteMany: jest.fn() },
  $transaction: jest.fn(),
}));
jest.mock("../../models/systemSettings", () => ({ SystemSettings: {} }));
jest.mock("../../utils/helpers/updateENV", () => ({ dumpENV: jest.fn() }));
jest.mock("../../utils/EncryptionManager", () => {
  const { EncryptionManager } = jest.requireActual(
    "../../utils/EncryptionManager"
  );
  return {
    EncryptionManager: jest
      .fn()
      .mockImplementation(
        () => new EncryptionManager({ key: "test-key", salt: "test-salt" })
      ),
  };
});
const prisma = require("../../utils/prisma");
const { EncryptionManager } = require("../../utils/EncryptionManager");
const {
  WorkspaceMcpServer: Server,
} = require("../../models/workspaceMcpServer");
const config = {
  url: "https://mcp.example/mcp",
  headers: { Authorization: "Bearer test-secret" },
};
let log, warn;
beforeEach(() => {
  jest.clearAllMocks();
  log = jest.spyOn(console, "log").mockImplementation(() => {});
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  prisma.workspace_mcp_servers.create.mockImplementation(async ({ data }) => ({
    id: 1,
    ...data,
  }));
  prisma.workspace_mcp_servers.update.mockImplementation(async ({ data }) => ({
    id: 1,
    workspace_id: 7,
    name: "erp",
    ...data,
  }));
});
afterEach(() => {
  expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls])).not.toMatch(
    /test-secret|mcp\.example|corrupt-ciphertext/
  );
  jest.restoreAllMocks();
});

describe("workspace MCP server model", () => {
  it("validates and encrypts complete config before create", async () => {
    await Server.create(7, "erp", config);
    const { data } = prisma.workspace_mcp_servers.create.mock.calls[0][0];
    expect(data).toMatchObject({ workspace_id: 7, name: "erp" });
    expect(data.config).not.toContain(config.url);
    expect(data.config).not.toContain("test-secret");
    expect(JSON.parse(new EncryptionManager().decrypt(data.config))).toEqual(
      config
    );
  });
  it("rejects invalid config and name before writing", async () => {
    await expect(Server.create(7, "INVALID", config)).rejects.toThrow(
      "invalid_name"
    );
    await expect(
      Server.create(7, "erp", { ...config, command: "node" })
    ).rejects.toThrow("stdio_not_supported");
    expect(prisma.workspace_mcp_servers.create).not.toHaveBeenCalled();
  });
  it("does not write when encryption fails", async () => {
    EncryptionManager.mockImplementationOnce(() => ({ encrypt: () => null }));
    await expect(Server.create(7, "erp", config)).rejects.toThrow(
      "config_encrypt_failed"
    );
    expect(prisma.workspace_mcp_servers.create).not.toHaveBeenCalled();
  });
  it("lists decrypted rows scoped to one workspace", async () => {
    const encrypted = new EncryptionManager().encrypt(JSON.stringify(config));
    prisma.workspace_mcp_servers.findMany.mockResolvedValue([
      { id: 1, workspace_id: 7, name: "erp", config: encrypted },
    ]);
    expect(await Server.listDecrypted(7)).toEqual([
      { id: 1, workspace_id: 7, name: "erp", config },
    ]);
    expect(prisma.workspace_mcp_servers.findMany).toHaveBeenCalledWith({
      where: { workspace_id: 7 },
    });
  });
  it("skips decrypt and JSON failures, logs only each server name", async () => {
    const manager = new EncryptionManager();
    prisma.workspace_mcp_servers.findMany.mockResolvedValue([
      { name: "broken", config: "corrupt-ciphertext" },
      { name: "bad-json", config: manager.encrypt("not json") },
      { name: "erp", config: manager.encrypt(JSON.stringify(config)) },
    ]);
    log.mockClear();
    expect(await Server.listDecrypted(7)).toEqual([{ name: "erp", config }]);
    expect(warn.mock.calls).toEqual([
      ["[WorkspaceMcpServer] Config decrypt failed:", "broken"],
      ["[WorkspaceMcpServer] Config decrypt failed:", "bad-json"],
    ]);
    expect(log.mock.calls.flat().some((value) => value instanceof Error)).toBe(
      false
    );
  });
  it("finds one decrypted row by workspace and name, missing returns null", async () => {
    prisma.workspace_mcp_servers.findUnique
      .mockResolvedValueOnce({
        name: "erp",
        config: new EncryptionManager().encrypt(JSON.stringify(config)),
      })
      .mockResolvedValueOnce(null);
    expect(await Server.find(7, "erp")).toEqual({ name: "erp", config });
    expect(prisma.workspace_mcp_servers.findUnique).toHaveBeenCalledWith({
      where: { workspace_id_name: { workspace_id: 7, name: "erp" } },
    });
    expect(await Server.find(8, "erp")).toBeNull();
  });
  it("validates and encrypts replacement config on update", async () => {
    await Server.update(7, "erp", config);
    const { where, data } =
      prisma.workspace_mcp_servers.update.mock.calls[0][0];
    expect(where).toEqual({
      workspace_id_name: { workspace_id: 7, name: "erp" },
    });
    expect(data.config).not.toContain(config.url);
    expect(JSON.parse(new EncryptionManager().decrypt(data.config))).toEqual(
      config
    );
    await expect(
      Server.update(7, "erp", { url: "https://10.0.0.1" })
    ).rejects.toThrow("invalid_url");
    expect(prisma.workspace_mcp_servers.update).toHaveBeenCalledTimes(1);
  });
  it("deletes connection and server inside the same scoped transaction", async () => {
    const tx = {
      workspace_mcp_connections: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      workspace_mcp_servers: {
        delete: jest.fn().mockResolvedValue({ name: "erp" }),
      },
    };
    prisma.$transaction.mockImplementation(async (operation) => operation(tx));
    await Server.delete(7, "erp");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.workspace_mcp_connections.deleteMany).toHaveBeenCalledWith({
      where: { workspace_id: 7, server_name: "erp" },
    });
    expect(tx.workspace_mcp_servers.delete).toHaveBeenCalledWith({
      where: { workspace_id_name: { workspace_id: 7, name: "erp" } },
    });
    expect(prisma.workspace_mcp_connections.deleteMany).not.toHaveBeenCalled();
    expect(prisma.workspace_mcp_servers.delete).not.toHaveBeenCalled();
  });
});
