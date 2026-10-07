const fs = require("fs");
const os = require("os");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "invocation-close-"));
const url = `file:${directory}/fixture.db`;
const mockPrisma = new PrismaClient({ datasources: { db: { url } } });
const writer = new PrismaClient({ datasources: { db: { url } } });
jest.mock("../../utils/prisma", () => mockPrisma);
const {
  WorkspaceAgentInvocation,
} = require("../../models/workspaceAgentInvocation");

beforeAll(async () => {
  await mockPrisma.$executeRawUnsafe(`CREATE TABLE workspace_agent_invocations (
    id INTEGER PRIMARY KEY, uuid TEXT UNIQUE NOT NULL, prompt TEXT NOT NULL,
    closed BOOLEAN DEFAULT false, user_id INTEGER, thread_id INTEGER,
    workspace_id INTEGER NOT NULL, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    lastUpdatedAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await mockPrisma.$executeRawUnsafe(
    "CREATE TABLE other_writes (id INTEGER PRIMARY KEY, value INTEGER DEFAULT 0)"
  );
  await mockPrisma.$executeRawUnsafe("INSERT INTO other_writes(id) VALUES (1)");
});
afterAll(async () => {
  await Promise.all([mockPrisma.$disconnect(), writer.$disconnect()]);
  fs.rmSync(directory, { recursive: true, force: true });
});

it("persists agent closure while another client writes an unrelated row", async () => {
  for (let i = 0; i < 20; i++) {
    const uuid = `concurrent-${i}`;
    await mockPrisma.workspace_agent_invocations.create({
      data: { uuid, prompt: "fixture", workspace_id: 1 },
    });
    await Promise.all([
      WorkspaceAgentInvocation.close(uuid),
      writer.$transaction([
        writer.$executeRawUnsafe(
          "UPDATE other_writes SET value=value+1 WHERE id=1"
        ),
      ]),
    ]);
    expect(
      (
        await mockPrisma.workspace_agent_invocations.findUnique({
          where: { uuid },
        })
      ).closed
    ).toBe(true);
  }
});

it("closing twice or closing a removed invocation is harmless", async () => {
  await mockPrisma.workspace_agent_invocations.create({
    data: { uuid: "repeat", prompt: "fixture", workspace_id: 1 },
  });
  await WorkspaceAgentInvocation.close("repeat");
  await WorkspaceAgentInvocation.close("repeat");
  expect(
    (
      await mockPrisma.workspace_agent_invocations.findUnique({
        where: { uuid: "repeat" },
      })
    ).closed
  ).toBe(true);
  await mockPrisma.workspace_agent_invocations.delete({
    where: { uuid: "repeat" },
  });
  await expect(
    WorkspaceAgentInvocation.close("repeat")
  ).resolves.toBeUndefined();
});

it("concurrent closes affect only their invocation", async () => {
  for (const uuid of ["target", "untouched"]) {
    await mockPrisma.workspace_agent_invocations.create({
      data: { uuid, prompt: "fixture", workspace_id: 1 },
    });
  }
  await Promise.all([
    WorkspaceAgentInvocation.close("target"),
    WorkspaceAgentInvocation.close("target"),
  ]);
  expect(
    (
      await mockPrisma.workspace_agent_invocations.findUnique({
        where: { uuid: "target" },
      })
    ).closed
  ).toBe(true);
  expect(
    (
      await mockPrisma.workspace_agent_invocations.findUnique({
        where: { uuid: "untouched" },
      })
    ).closed
  ).toBe(false);
});

it("reports finalization failure instead of silently swallowing it", async () => {
  await mockPrisma.workspace_agent_invocations.create({
    data: { uuid: "failed", prompt: "fixture", workspace_id: 1 },
  });
  await mockPrisma.$executeRawUnsafe(`CREATE TRIGGER fail_close BEFORE UPDATE ON workspace_agent_invocations
    WHEN OLD.uuid = 'failed' BEGIN SELECT RAISE(ABORT, 'controlled failure'); END`);
  const report = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    await WorkspaceAgentInvocation.close("failed");
    expect(
      (
        await mockPrisma.workspace_agent_invocations.findUnique({
          where: { uuid: "failed" },
        })
      ).closed
    ).toBe(false);
    expect(report).toHaveBeenCalled();
    // Never include query details, credentials, or prompt data in this log.
    expect(report.mock.calls.flat().join(" ")).not.toContain(
      "controlled failure"
    );
  } finally {
    report.mockRestore();
  }
});
