/* global jest */
const { describe, beforeEach, it, expect } = require("@jest/globals");
require("../utils/lark/_polyfill");
jest.mock("../../utils/prisma", () => ({}));
jest.mock("../../models/systemSettings", () => ({ SystemSettings: { get: jest.fn() } }));

const { Workspace } = require("../../models/workspace");
const { ROLES } = require("../../utils/middleware/multiUserProtected");

const defaultUser = { id: 7, username: "alice", role: ROLES.default };

describe("Workspace.ensurePersonal", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(Workspace, "new");
    jest.spyOn(Workspace, "whereWithUser");
  });

  it("creates '<username>'s workspace' for a default user with no workspaces", async () => {
    Workspace.whereWithUser.mockResolvedValue([]);
    const ws = { id: 1, slug: "alice-s-workspace", name: "alice's workspace" };
    Workspace.new.mockResolvedValue({ workspace: ws, message: null });

    const result = await Workspace.ensurePersonal(defaultUser);

    expect(Workspace.new).toHaveBeenCalledTimes(1);
    expect(Workspace.new).toHaveBeenCalledWith("alice's workspace", 7);
    expect(result).toEqual({ workspace: ws, created: true });
  });

  it("does nothing when the default user already has a workspace", async () => {
    Workspace.whereWithUser.mockResolvedValue([{ id: 3 }]);
    const result = await Workspace.ensurePersonal(defaultUser);
    expect(Workspace.new).not.toHaveBeenCalled();
    expect(result).toEqual({ workspace: null, created: false });
  });

  it("does nothing for admin or manager users", async () => {
    Workspace.whereWithUser.mockResolvedValue([]);
    for (const role of [ROLES.admin, ROLES.manager]) {
      await Workspace.ensurePersonal({ ...defaultUser, role });
    }
    expect(Workspace.new).not.toHaveBeenCalled();
    expect(Workspace.whereWithUser).not.toHaveBeenCalled();
  });

  it("does nothing when user is missing", async () => {
    expect(await Workspace.ensurePersonal(null)).toEqual({ workspace: null, created: false });
    expect(Workspace.new).not.toHaveBeenCalled();
  });

  it("swallows creation failure and reports created:false", async () => {
    Workspace.whereWithUser.mockResolvedValue([]);
    Workspace.new.mockResolvedValue({ workspace: null, message: "boom" });
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const result = await Workspace.ensurePersonal(defaultUser);
    expect(result).toEqual({ workspace: null, created: false });
    expect(errSpy).toHaveBeenCalled();
  });
});
