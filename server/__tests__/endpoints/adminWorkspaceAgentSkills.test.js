process.env.NODE_ENV = "test";

jest.mock("../../models/workspace", () => ({
  Workspace: { get: jest.fn() },
}));
jest.mock("../../models/workspaceAgentSettings", () => ({
  WorkspaceAgentSettings: {
    enabledSkills: jest.fn(),
    setEnabledSkills: jest.fn(),
  },
}));
jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_req, _res, next) => next(),
}));
const mockRoleCheck = jest.fn();
jest.mock("../../utils/middleware/multiUserProtected", () => {
  const roles = {
    admin: "admin",
    manager: "manager",
    default: "default",
    all: "<all>",
  };
  const guard = (allowedRoles) => {
    const middleware = (_req, _res, next) => next();
    middleware.allowedRoles = allowedRoles;
    return middleware;
  };
  return {
    ROLES: roles,
    strictMultiUserRoleValid: guard,
    flexUserRoleValid: (allowedRoles) => {
      mockRoleCheck(allowedRoles);
      return guard(allowedRoles);
    },
  };
});

const { Workspace } = require("../../models/workspace");
const {
  WorkspaceAgentSettings,
} = require("../../models/workspaceAgentSettings");
const { ROLES } = require("../../utils/middleware/multiUserProtected");
const { adminEndpoints } = require("../../endpoints/admin");

const routePath = "/admin/workspace/:slug/agent-skills";

function buildApp() {
  const routes = new Map();
  const rolesByRoute = new Map();
  const app = { routes, rolesByRoute };

  for (const method of ["get", "post", "delete"]) {
    app[method] = (path, ...callbacks) => {
      const handler = callbacks.pop();
      const middlewares = callbacks.flat();
      const key = `${method.toUpperCase()} ${path}`;
      routes.set(key, { path, middlewares, handler });
      rolesByRoute.set(
        key,
        middlewares.find((middleware) => middleware.allowedRoles)?.allowedRoles
      );
    };
  }

  adminEndpoints(app);
  return app;
}

function mockResponse() {
  return {
    statusCode: null,
    body: undefined,
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
      return this;
    },
    end() {
      return this;
    },
  };
}

async function invoke(app, method, { slug = "legal", body = {} } = {}) {
  const route = app.routes.get(`${method} ${routePath}`);
  if (!route) return null;
  const response = mockResponse();
  await route.handler({ params: { slug }, body }, response);
  return response;
}

describe("/admin/workspace/:slug/agent-skills", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Workspace.get.mockResolvedValue({ id: 5, slug: "legal" });
  });

  it("registers GET and POST as admin-only routes", () => {
    const app = buildApp();

    expect(app.routes.has(`GET ${routePath}`)).toBe(true);
    expect(app.routes.has(`POST ${routePath}`)).toBe(true);
    expect(app.rolesByRoute.get(`GET ${routePath}`)).toEqual([ROLES.admin]);
    expect(app.rolesByRoute.get(`POST ${routePath}`)).toEqual([ROLES.admin]);
  });

  it("GET returns enabledSkills for the workspace", async () => {
    WorkspaceAgentSettings.enabledSkills.mockResolvedValue(["rag-memory"]);
    const response = await invoke(buildApp(), "GET");

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ enabledSkills: ["rag-memory"] });
    expect(Workspace.get).toHaveBeenCalledWith({ slug: "legal" });
    expect(WorkspaceAgentSettings.enabledSkills).toHaveBeenCalledWith(5);
  });

  it("GET and POST return 404 for an unknown workspace", async () => {
    Workspace.get.mockResolvedValue(null);
    const app = buildApp();

    expect((await invoke(app, "GET", { slug: "nope" })).statusCode).toBe(404);
    expect(
      (
        await invoke(app, "POST", {
          slug: "nope",
          body: { enabledSkills: [] },
        })
      ).statusCode
    ).toBe(404);
  });

  it("POST replaces enabledSkills", async () => {
    WorkspaceAgentSettings.setEnabledSkills.mockResolvedValue({
      enabledSkills: ["sql-agent"],
      error: null,
    });
    const response = await invoke(buildApp(), "POST", {
      body: { enabledSkills: ["sql-agent"] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      success: true,
      enabledSkills: ["sql-agent"],
      error: null,
    });
    expect(WorkspaceAgentSettings.setEnabledSkills).toHaveBeenCalledWith(5, [
      "sql-agent",
    ]);
  });

  it("POST returns 400 when enabledSkills is not an array", async () => {
    const response = await invoke(buildApp(), "POST", {
      body: { enabledSkills: "sql-agent" },
    });

    expect(response.statusCode).toBe(400);
    expect(WorkspaceAgentSettings.setEnabledSkills).not.toHaveBeenCalled();
  });
});
