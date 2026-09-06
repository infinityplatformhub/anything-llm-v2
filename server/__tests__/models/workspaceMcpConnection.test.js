const {
  describe,
  beforeEach,
  afterEach,
  afterAll,
  it,
  expect,
} = require("@jest/globals");
process.env.NODE_ENV = "test";
const { randomUUID } = require("crypto");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

describe("workspace_mcp_connections schema", () => {
  const workspaceIds = [];
  let workspace;

  beforeEach(async () => {
    workspace = await prisma.workspaces.create({
      data: { name: "MCP schema test", slug: `mcp-schema-${randomUUID()}` },
    });
    workspaceIds.push(workspace.id);
  });

  afterEach(async () => {
    await prisma.workspaces.deleteMany({
      where: { id: { in: workspaceIds } },
    });
    workspaceIds.length = 0;
  });

  afterAll(async () => prisma.$disconnect());

  it("creates and reads a disabled connection with nullable credentials", async () => {
    const connection = await prisma.workspace_mcp_connections.create({
      data: { workspace_id: workspace.id, server_name: "flowaccount" },
    });
    expect(connection).toMatchObject({
      enabled: false,
      access_token: null,
      refresh_token: null,
      expires_at: null,
      company_label: null,
      createdAt: expect.any(Date),
      lastUpdatedAt: expect.any(Date),
    });
    expect(
      await prisma.workspaces.findUnique({
        where: { id: workspace.id },
        include: { mcp_connections: true },
      })
    ).toMatchObject({ mcp_connections: [connection] });
  });

  it("enforces uniqueness within a workspace but allows another workspace", async () => {
    const data = { workspace_id: workspace.id, server_name: "flowaccount" };
    await prisma.workspace_mcp_connections.create({ data });
    await expect(
      prisma.workspace_mcp_connections.create({ data })
    ).rejects.toMatchObject({ code: "P2002" });

    const other = await prisma.workspaces.create({
      data: {
        name: "Other MCP schema test",
        slug: `mcp-schema-${randomUUID()}`,
      },
    });
    workspaceIds.push(other.id);
    await expect(
      prisma.workspace_mcp_connections.create({
        data: { ...data, workspace_id: other.id },
      })
    ).resolves.toMatchObject({ workspace_id: other.id });
  });

  it("deletes connections when their workspace is deleted", async () => {
    const connection = await prisma.workspace_mcp_connections.create({
      data: { workspace_id: workspace.id, server_name: "flowaccount" },
    });
    await prisma.workspaces.delete({ where: { id: workspace.id } });
    expect(
      await prisma.workspace_mcp_connections.findUnique({
        where: { id: connection.id },
      })
    ).toBeNull();
  });
});
