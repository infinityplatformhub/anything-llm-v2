process.env.NODE_ENV = "test";
jest.mock("../../utils/prisma", () => ({
  workspace_agent_settings: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
}));
const prisma = require("../../utils/prisma");
const { WorkspaceAgentSettings } = require("../../models/workspaceAgentSettings");

describe("WorkspaceAgentSettings", () => {
  beforeEach(() => jest.clearAllMocks());

  it("enabledSkills returns [] when no row exists (deny by default)", async () => {
    prisma.workspace_agent_settings.findUnique.mockResolvedValue(null);
    expect(await WorkspaceAgentSettings.enabledSkills(7)).toEqual([]);
  });

  it("enabledSkills parses stored JSON", async () => {
    prisma.workspace_agent_settings.findUnique.mockResolvedValue({
      enabled_skills: '["rag-memory","sql-agent"]',
    });
    expect(await WorkspaceAgentSettings.enabledSkills(7)).toEqual([
      "rag-memory",
      "sql-agent",
    ]);
  });

  it("enabledSkills returns [] on corrupt JSON", async () => {
    prisma.workspace_agent_settings.findUnique.mockResolvedValue({
      enabled_skills: "{oops",
    });
    expect(await WorkspaceAgentSettings.enabledSkills(7)).toEqual([]);
  });

  it("setEnabledSkills upserts only known string ids, deduped", async () => {
    prisma.workspace_agent_settings.upsert.mockResolvedValue({
      enabled_skills: '["rag-memory"]',
    });
    const res = await WorkspaceAgentSettings.setEnabledSkills(7, [
      "rag-memory",
      "rag-memory",
      42,
      "not-a-skill",
    ]);
    expect(prisma.workspace_agent_settings.upsert).toHaveBeenCalledWith({
      where: { workspace_id: 7 },
      create: { workspace_id: 7, enabled_skills: '["rag-memory"]' },
      update: {
        enabled_skills: '["rag-memory"]',
        lastUpdatedAt: expect.any(Date),
      },
    });
    expect(res.error).toBeNull();
    expect(res.enabledSkills).toEqual(["rag-memory"]);
  });
});
