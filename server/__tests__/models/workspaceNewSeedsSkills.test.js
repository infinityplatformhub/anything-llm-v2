/* global jest */
require("../utils/lark/_polyfill");
const { describe, beforeEach, it, expect } = require("@jest/globals");

jest.mock("../../utils/prisma", () => ({
  workspaces: { create: jest.fn(), findFirst: jest.fn() },
}));
jest.mock("../../models/systemSettings", () => ({
  SystemSettings: {
    get: jest.fn().mockResolvedValue(null),
    saneDefaultSystemPrompt: "default prompt",
  },
}));
jest.mock("../../models/workspaceUsers", () => ({
  WorkspaceUser: { create: jest.fn().mockResolvedValue(true) },
}));
jest.mock("../../models/workspaceAgentSettings", () => ({
  WorkspaceAgentSettings: { seedDefaults: jest.fn() },
}));

const prisma = require("../../utils/prisma");
const { WorkspaceUser } = require("../../models/workspaceUsers");
const {
  WorkspaceAgentSettings,
} = require("../../models/workspaceAgentSettings");
const { Workspace } = require("../../models/workspace");

const createdWorkspace = { id: 42, name: "x", slug: "x" };

describe("Workspace.new default agent skills", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    prisma.workspaces.create.mockReset().mockResolvedValue(createdWorkspace);
    WorkspaceUser.create.mockReset().mockResolvedValue(true);
    WorkspaceAgentSettings.seedDefaults.mockReset().mockResolvedValue({
      enabledSkills: [],
      error: null,
    });
    jest.spyOn(Workspace, "get").mockResolvedValue(null);
  });

  it("seeds defaults before creating the workspace membership", async () => {
    await Workspace.new("x", 7);

    expect(WorkspaceAgentSettings.seedDefaults).toHaveBeenCalledTimes(1);
    expect(WorkspaceAgentSettings.seedDefaults).toHaveBeenCalledWith(42);
    expect(
      WorkspaceAgentSettings.seedDefaults.mock.invocationCallOrder[0]
    ).toBeLessThan(WorkspaceUser.create.mock.invocationCallOrder[0]);
  });

  it("seeds defaults when no creator is provided", async () => {
    await Workspace.new("x", null);

    expect(WorkspaceAgentSettings.seedDefaults).toHaveBeenCalledTimes(1);
    expect(WorkspaceAgentSettings.seedDefaults).toHaveBeenCalledWith(42);
    expect(WorkspaceUser.create).not.toHaveBeenCalled();
  });

  it("returns the workspace and creates membership when seeding fails", async () => {
    WorkspaceAgentSettings.seedDefaults.mockResolvedValue({
      enabledSkills: null,
      error: "boom",
    });
    const consoleError = jest.spyOn(console, "error").mockImplementation();

    const result = await Workspace.new("x", 7);

    expect(consoleError).toHaveBeenCalledWith(
      "Workspace.new: could not seed default agent skills",
      42,
      "boom"
    );
    expect(WorkspaceUser.create).toHaveBeenCalledWith(7, 42);
    expect(result).toEqual({ workspace: createdWorkspace, message: null });
  });

  it("does not seed defaults when workspace creation fails", async () => {
    prisma.workspaces.create.mockRejectedValue(new Error("create failed"));
    jest.spyOn(console, "error").mockImplementation();

    const result = await Workspace.new("x", 7);

    expect(WorkspaceAgentSettings.seedDefaults).not.toHaveBeenCalled();
    expect(result).toEqual({ workspace: null, message: "create failed" });
  });
});
