require("../utils/lark/_polyfill");
/* global jest */
const { describe, beforeEach, it, expect } = require("@jest/globals");
process.env.NODE_ENV = "test";
jest.mock("../../utils/prisma", () => ({
  workspace_agent_settings: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
}));
const prisma = require("../../utils/prisma");
const {
  WorkspaceAgentSettings,
  DEFAULT_ENABLED_SKILLS,
} = require("../../models/workspaceAgentSettings");

describe("WorkspaceAgentSettings", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns [] when no row exists", async () => {
    prisma.workspace_agent_settings.findUnique.mockResolvedValue(null);

    expect(await WorkspaceAgentSettings.enabledSkills(7)).toEqual([]);
    expect(prisma.workspace_agent_settings.findUnique).toHaveBeenCalledWith({
      where: { workspace_id: 7 },
      select: { enabled_skills: true },
    });
  });

  it("parses valid stored JSON", async () => {
    prisma.workspace_agent_settings.findUnique.mockResolvedValue({
      enabled_skills: '["rag-memory","sql-agent"]',
    });

    expect(await WorkspaceAgentSettings.enabledSkills(7)).toEqual([
      "rag-memory",
      "sql-agent",
    ]);
  });

  it("returns [] for corrupt JSON", async () => {
    prisma.workspace_agent_settings.findUnique.mockResolvedValue({
      enabled_skills: "{oops",
    });

    expect(await WorkspaceAgentSettings.enabledSkills(7)).toEqual([]);
  });

  it("returns [] for non-array JSON", async () => {
    prisma.workspace_agent_settings.findUnique.mockResolvedValue({
      enabled_skills: '{"a":1}',
    });

    expect(await WorkspaceAgentSettings.enabledSkills(7)).toEqual([]);
  });

  it("rejects aliases when reading", async () => {
    prisma.workspace_agent_settings.findUnique.mockResolvedValue({
      enabled_skills: '["memory","rag-memory"]',
    });

    expect(await WorkspaceAgentSettings.enabledSkills(7)).toEqual([
      "rag-memory",
    ]);
  });

  it("drops stale ids when reading", async () => {
    prisma.workspace_agent_settings.findUnique.mockResolvedValue({
      enabled_skills: '["rag-memory","ghost-skill"]',
    });

    expect(await WorkspaceAgentSettings.enabledSkills(7)).toEqual([
      "rag-memory",
    ]);
  });

  it("returns [] and logs when reading fails", async () => {
    const error = new Error("read failed");
    const consoleError = jest.spyOn(console, "error").mockImplementation();
    prisma.workspace_agent_settings.findUnique.mockRejectedValue(error);

    try {
      expect(await WorkspaceAgentSettings.enabledSkills(7)).toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(error);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("upserts canonical string ids, deduped", async () => {
    const result = await WorkspaceAgentSettings.setEnabledSkills(7, [
      "rag-memory",
      "rag-memory",
      42,
      "memory",
      "not-a-skill",
    ]);

    expect(prisma.workspace_agent_settings.upsert).toHaveBeenCalledWith({
      where: { workspace_id: 7 },
      create: { workspace_id: 7, enabled_skills: '["rag-memory"]' },
      update: { enabled_skills: '["rag-memory"]' },
    });
    expect(result).toEqual({ enabledSkills: ["rag-memory"], error: null });
  });

  it("rejects inherited property names when writing", async () => {
    await WorkspaceAgentSettings.setEnabledSkills(7, [
      "rag-memory",
      "toString",
      "hasOwnProperty",
    ]);

    expect(prisma.workspace_agent_settings.upsert).toHaveBeenCalledWith({
      where: { workspace_id: 7 },
      create: { workspace_id: 7, enabled_skills: '["rag-memory"]' },
      update: { enabled_skills: '["rag-memory"]' },
    });
  });

  it("seedDefaults upserts the default enabled skills", async () => {
    const result = await WorkspaceAgentSettings.seedDefaults(7);

    expect(prisma.workspace_agent_settings.upsert).toHaveBeenCalledWith({
      where: { workspace_id: 7 },
      create: {
        workspace_id: 7,
        enabled_skills: JSON.stringify(DEFAULT_ENABLED_SKILLS),
      },
      update: { enabled_skills: JSON.stringify(DEFAULT_ENABLED_SKILLS) },
    });
    expect(result).toEqual({
      enabledSkills: DEFAULT_ENABLED_SKILLS,
      error: null,
    });
  });

  it("exports exactly the default enabled skills in order", () => {
    expect(DEFAULT_ENABLED_SKILLS).toEqual([
      "rag-memory",
      "document-summarizer",
      "web-scraping",
      "filesystem-agent",
      "create-files-agent",
      "create-chart",
      "generate-image",
      "web-browsing",
      "sql-agent",
      "lark-cli",
    ]);
  });

  it("returns null skills and error when writing fails", async () => {
    const error = new Error("write failed");
    const consoleError = jest.spyOn(console, "error").mockImplementation();
    prisma.workspace_agent_settings.upsert.mockRejectedValue(error);

    try {
      expect(await WorkspaceAgentSettings.setEnabledSkills(7, [])).toEqual({
        enabledSkills: null,
        error: "write failed",
      });
      expect(consoleError).toHaveBeenCalledWith(error);
    } finally {
      consoleError.mockRestore();
    }
  });
});
