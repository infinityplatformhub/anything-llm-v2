/* global jest */
const { describe, beforeEach, it, expect } = require("@jest/globals");
require("../utils/lark/_polyfill");
jest.mock("../../utils/prisma", () => ({ workspaces: { count: jest.fn() } }));
jest.mock("../../models/systemSettings", () => ({ SystemSettings: { get: jest.fn() } }));
jest.mock("../../models/workspaceUsers", () => ({
  WorkspaceUser: { get: jest.fn() },
}));

const prisma = require("../../utils/prisma");
const { WorkspaceUser } = require("../../models/workspaceUsers");
const { Workspace } = require("../../models/workspace");
const { ROLES } = require("../../utils/middleware/multiUserProtected");

const defaultUser = { id: 7, username: "alice", role: ROLES.default };

describe("Workspace.ensurePersonal", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    prisma.workspaces.count.mockReset();
    WorkspaceUser.get.mockReset().mockResolvedValue({ id: 1 });
    jest.spyOn(Workspace, "new");
    jest.spyOn(Workspace, "delete").mockResolvedValue(true);
  });

  it("creates '<username>'s workspace' for a default user with no workspaces", async () => {
    prisma.workspaces.count.mockResolvedValue(0);
    const ws = { id: 1, slug: "alice-s-workspace", name: "alice's workspace" };
    Workspace.new.mockResolvedValue({ workspace: ws, message: null });

    const result = await Workspace.ensurePersonal(defaultUser);

    expect(Workspace.new).toHaveBeenCalledTimes(1);
    expect(Workspace.new).toHaveBeenCalledWith("alice's workspace", 7);
    expect(result).toEqual({ workspace: ws, created: true });
  });

  it("does nothing when the default user already has a workspace", async () => {
    prisma.workspaces.count.mockResolvedValue(1);
    const result = await Workspace.ensurePersonal(defaultUser);
    expect(Workspace.new).not.toHaveBeenCalled();
    expect(result).toEqual({ workspace: null, created: false });
  });

  it("does nothing for admin or manager users", async () => {
    prisma.workspaces.count.mockResolvedValue(0);
    for (const role of [ROLES.admin, ROLES.manager]) {
      await Workspace.ensurePersonal({ ...defaultUser, role });
    }
    expect(Workspace.new).not.toHaveBeenCalled();
    expect(prisma.workspaces.count).not.toHaveBeenCalled();
  });

  it("does nothing when user is missing", async () => {
    expect(await Workspace.ensurePersonal(null)).toEqual({ workspace: null, created: false });
    expect(Workspace.new).not.toHaveBeenCalled();
  });

  it("does not create when the membership lookup fails", async () => {
    prisma.workspaces.count.mockRejectedValue(new Error("lookup failed"));
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const result = await Workspace.ensurePersonal(defaultUser);

    expect(Workspace.new).not.toHaveBeenCalled();
    expect(result).toEqual({ workspace: null, created: false });
    expect(errSpy).toHaveBeenCalled();
  });

  it("removes the workspace when its membership link is missing", async () => {
    prisma.workspaces.count.mockResolvedValue(0);
    const ws = { id: 9, slug: "alice-s-workspace", name: "alice's workspace" };
    Workspace.new.mockResolvedValue({ workspace: ws, message: null });
    WorkspaceUser.get.mockResolvedValue(null);
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const result = await Workspace.ensurePersonal(defaultUser);

    expect(Workspace.delete).toHaveBeenCalledWith({ id: 9 });
    expect(result).toEqual({ workspace: null, created: false });
    expect(errSpy).toHaveBeenCalled();
  });

  it("deduplicates concurrent calls and clears the in-flight entry", async () => {
    prisma.workspaces.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const ws = { id: 1, slug: "alice-s-workspace", name: "alice's workspace" };
    Workspace.new.mockResolvedValue({ workspace: ws, message: null });

    const first = Workspace.ensurePersonal(defaultUser);
    const second = Workspace.ensurePersonal(defaultUser);
    const results = await Promise.all([first, second]);

    expect(Workspace.new).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      { workspace: ws, created: true },
      { workspace: ws, created: true },
    ]);

    await Workspace.ensurePersonal(defaultUser);
    expect(prisma.workspaces.count).toHaveBeenCalledTimes(2);
  });

  it("does nothing when username is missing", async () => {
    const result = await Workspace.ensurePersonal({ ...defaultUser, username: null });

    expect(Workspace.new).not.toHaveBeenCalled();
    expect(prisma.workspaces.count).not.toHaveBeenCalled();
    expect(result).toEqual({ workspace: null, created: false });
  });

  it("swallows creation failure and reports created:false", async () => {
    prisma.workspaces.count.mockResolvedValue(0);
    Workspace.new.mockResolvedValue({ workspace: null, message: "boom" });
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const result = await Workspace.ensurePersonal(defaultUser);
    expect(result).toEqual({ workspace: null, created: false });
    expect(errSpy).toHaveBeenCalled();
  });
});
