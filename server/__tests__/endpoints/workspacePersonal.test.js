/* global jest */
const { describe, beforeEach, it, expect } = require("@jest/globals");
require("../utils/lark/_polyfill");

jest.mock("../../models/workspace", () => ({
  Workspace: {
    ensurePersonal: jest.fn(),
    whereWithUser: jest.fn(),
    where: jest.fn(),
  },
}));
jest.mock("../../utils/http", () => ({
  multiUserMode: jest.fn(),
  userFromSession: jest.fn(),
  reqBody: jest.fn(),
  safeJsonParse: jest.fn(),
}));
jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_req, _res, next) => next(),
}));
jest.mock("../../utils/middleware/multiUserProtected", () => ({
  flexUserRoleValid: () => (_req, _res, next) => next(),
  ROLES: {
    all: "<all>",
    admin: "admin",
    manager: "manager",
    default: "default",
  },
}));
jest.mock("../../utils/middleware/validWorkspace", () => ({
  validWorkspaceSlug: (_r, _s, n) => n(),
}));
jest.mock("../../utils/files", () => ({}));
jest.mock("../../utils/files/multer", () => ({
  handleFileUpload: () => (_r, _s, n) => n(),
}));
jest.mock("../../models/documents", () => ({ Document: {} }));
jest.mock("../../models/vectors", () => ({ DocumentVectors: {} }));
jest.mock("../../models/workspaceChats", () => ({ WorkspaceChats: {} }));
jest.mock("../../models/telemetry", () => ({ Telemetry: {} }));
jest.mock("../../models/eventLogs", () => ({ EventLogs: {} }));
jest.mock("../../models/workspacesSuggestedMessages", () => ({
  WorkspaceSuggestedMessages: {},
}));
jest.mock("../../utils/helpers", () => ({
  getVectorDbClass: jest.fn(),
  stripThinkingFromText: jest.fn(),
}));
jest.mock("../../utils/helpers/chat/responses", () => ({
  convertToChatHistory: jest.fn(),
}));

const { Workspace } = require("../../models/workspace");
const { multiUserMode, userFromSession } = require("../../utils/http");
const { workspaceEndpoints } = require("../../endpoints/workspaces");

let listRoute;
beforeEach(() => {
  jest.clearAllMocks();
  const app = {
    get: (path, mws, handler) => {
      if (path === "/workspaces") listRoute = handler;
    },
    post: () => {},
    delete: () => {},
    put: () => {},
    patch: () => {},
  };
  workspaceEndpoints(app);
});

async function invoke() {
  const response = {
    locals: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    sendStatus(code) {
      this.statusCode = code;
      return { end: () => {} };
    },
  };
  await listRoute({}, response);
  return response;
}

describe("GET /workspaces personal auto-create", () => {
  const user = { id: 7, username: "alice", role: "default" };

  it("ensures a personal workspace before listing in multi-user mode", async () => {
    multiUserMode.mockReturnValue(true);
    userFromSession.mockResolvedValue(user);
    Workspace.ensurePersonal.mockResolvedValue({
      workspace: { id: 1 },
      created: true,
    });
    Workspace.whereWithUser.mockResolvedValue([{ id: 1 }]);

    const res = await invoke();

    expect(Workspace.ensurePersonal).toHaveBeenCalledWith(user);
    expect(Workspace.ensurePersonal.mock.invocationCallOrder[0]).toBeLessThan(
      Workspace.whereWithUser.mock.invocationCallOrder[0]
    );
    expect(res.body).toEqual({ workspaces: [{ id: 1 }] });
  });

  it("skips ensurePersonal in single-user mode", async () => {
    multiUserMode.mockReturnValue(false);
    userFromSession.mockResolvedValue(null);
    Workspace.where.mockResolvedValue([]);
    const res = await invoke();
    expect(Workspace.ensurePersonal).not.toHaveBeenCalled();
    expect(res.body).toEqual({ workspaces: [] });
  });

  it("still returns the list when ensurePersonal reports no creation", async () => {
    multiUserMode.mockReturnValue(true);
    userFromSession.mockResolvedValue(user);
    Workspace.ensurePersonal.mockResolvedValue({
      workspace: null,
      created: false,
    });
    Workspace.whereWithUser.mockResolvedValue([]);
    const res = await invoke();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ workspaces: [] });
  });

  it("passes only the session user to ensurePersonal, never request data", async () => {
    multiUserMode.mockReturnValue(true);
    userFromSession.mockResolvedValue(user);
    Workspace.ensurePersonal.mockResolvedValue({
      workspace: null,
      created: false,
    });
    Workspace.whereWithUser.mockResolvedValue([]);
    await listRoute(
      { body: { username: "evil" }, query: { name: "evil" } },
      {
        locals: {},
        status() {
          return this;
        },
        json() {
          return this;
        },
        sendStatus() {
          return { end() {} };
        },
      }
    );
    expect(Workspace.ensurePersonal).toHaveBeenCalledTimes(1);
    expect(Workspace.ensurePersonal.mock.calls[0][0]).toBe(user);
  });
});
