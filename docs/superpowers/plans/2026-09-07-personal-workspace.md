# Personal Workspace Auto-Create Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every multi-user `default`-role user gets one workspace of their own, created lazily on first workspace list.

**Architecture:** One model helper `Workspace.ensurePersonal(user)` decides whether to create; the `GET /workspaces` route calls it before listing. Reuses `Workspace.new(name, creatorId)` which already links `workspace_users` and de-duplicates slugs. No schema, no frontend change.

**Tech Stack:** Node/Express, Prisma (SQLite), Jest.

**Spec:** `docs/superpowers/specs/2026-09-07-personal-workspace-design.md`

## Global Constraints

- Role gate values come from `ROLES` in `server/utils/middleware/multiUserProtected.js`; never compare against string literals.
- Workspace name template is a true constant, inline, named, with a comment.
- Creation must never throw out of the list route: log and return the list.
- Owner/name derive only from the session user (`response.locals.user`); never from request body/query.
- Jest in this repo on Node 26: run from `server/` as `node ../node_modules/jest/bin/jest.js <path>`. Any test that (transitively) requires `models/user` must first `require("../utils/lark/_polyfill")` (SlowBuffer shim). Read gate/jest output via `| base64` if the terminal filter garbles it.
- Coding mindset: no hardcoded environment values; no unnamed shortcuts. A deliberate simplification must be marked `// ponytail: <ceiling> — <upgrade path>`.

---

### Task 1: `Workspace.ensurePersonal(user)` model helper

**Files:**
- Modify: `server/models/workspace.js` (add method inside the `Workspace` object, after `new`)
- Test: `server/__tests__/models/workspaceEnsurePersonal.test.js`

**Interfaces:**
- Consumes: `Workspace.new(name, creatorId)` → `{ workspace, message }`; `Workspace.whereWithUser(user, clause, limit)`; `ROLES.default`.
- Produces: `Workspace.ensurePersonal(user) → Promise<{ workspace: object|null, created: boolean }>`. Caller (Task 2) relies on it never throwing.

- [ ] **Step 1: Write the failing tests**

```js
// server/__tests__/models/workspaceEnsurePersonal.test.js
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
```

- [ ] **Step 2: Run to verify it fails**

Run (from `server/`): `node ../node_modules/jest/bin/jest.js __tests__/models/workspaceEnsurePersonal.test.js`
Expected: FAIL — `Workspace.ensurePersonal is not a function`.

- [ ] **Step 3: Implement**

Add inside `Workspace` in `server/models/workspace.js`, directly after the `new` method:

```js
  /**
   * Ensure a `default`-role user owns at least one workspace. Idempotent: the
   * lookup only counts workspaces the user is a member of, so a second call
   * after creation is a no-op. Never throws — the caller is the sidebar list
   * route, which must still return.
   * @param {{id:number, username:string, role:string}|null} user
   * @returns {Promise<{workspace: object|null, created: boolean}>}
   */
  ensurePersonal: async function (user) {
    const none = { workspace: null, created: false };
    if (!user?.id || user.role !== ROLES.default) return none;
    try {
      const existing = await this.whereWithUser(user, {}, 1);
      if (existing.length > 0) return none;
      // Name template is product copy, not environment config; a true constant.
      const name = `${user.username}'s workspace`;
      const { workspace, message } = await this.new(name, user.id);
      if (!workspace) {
        console.error("ensurePersonal: failed to create workspace", message);
        return none;
      }
      return { workspace, created: true };
    } catch (error) {
      console.error("ensurePersonal:", error.message);
      return none;
    }
  },
```

- [ ] **Step 4: Run to verify it passes**

Run: `node ../node_modules/jest/bin/jest.js __tests__/models/workspaceEnsurePersonal.test.js`
Expected: `Tests: 5 passed, 5 total`.

- [ ] **Step 5: Commit**

```bash
git add server/models/workspace.js server/__tests__/models/workspaceEnsurePersonal.test.js
git commit -m "feat(workspace): ensurePersonal creates a default user's first workspace (#39)"
```

---

### Task 2: Call `ensurePersonal` from `GET /workspaces`

**Files:**
- Modify: `server/endpoints/workspaces.js:377-392` (the `app.get("/workspaces", ...)` route)
- Test: `server/__tests__/endpoints/workspacePersonal.test.js`

**Interfaces:**
- Consumes: `Workspace.ensurePersonal(user)` from Task 1; `multiUserMode(response)` and `userFromSession(request, response)` from `server/utils/http`.
- Produces: nothing new; response shape `{ workspaces: [] }` unchanged.

- [ ] **Step 1: Write the failing tests**

```js
// server/__tests__/endpoints/workspacePersonal.test.js
/* global jest */
const { describe, beforeEach, it, expect } = require("@jest/globals");
require("../utils/lark/_polyfill");

jest.mock("../../models/workspace", () => ({
  Workspace: { ensurePersonal: jest.fn(), whereWithUser: jest.fn(), where: jest.fn() },
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
  ROLES: { all: "<all>", admin: "admin", manager: "manager", default: "default" },
}));
jest.mock("../../utils/middleware/validWorkspace", () => ({ validWorkspaceSlug: (_r, _s, n) => n() }));
jest.mock("../../utils/files", () => ({}));
jest.mock("../../utils/files/multer", () => ({ handleFileUpload: () => (_r, _s, n) => n() }));
jest.mock("../../models/documents", () => ({ Document: {} }));
jest.mock("../../models/vectors", () => ({ DocumentVectors: {} }));
jest.mock("../../models/workspaceChats", () => ({ WorkspaceChats: {} }));
jest.mock("../../models/telemetry", () => ({ Telemetry: {} }));
jest.mock("../../models/eventLogs", () => ({ EventLogs: {} }));
jest.mock("../../models/workspacesSuggestedMessages", () => ({ WorkspaceSuggestedMessages: {} }));
jest.mock("../../utils/helpers", () => ({ getVectorDbClass: jest.fn(), stripThinkingFromText: jest.fn() }));
jest.mock("../../utils/helpers/chat/responses", () => ({ convertToChatHistory: jest.fn() }));

const { Workspace } = require("../../models/workspace");
const { multiUserMode, userFromSession } = require("../../utils/http");
const { workspaceEndpoints } = require("../../endpoints/workspaces");

let listRoute;
beforeEach(() => {
  jest.clearAllMocks();
  const app = {
    get: (path, mws, handler) => { if (path === "/workspaces") listRoute = handler; },
    post: () => {}, delete: () => {}, put: () => {}, patch: () => {},
  };
  workspaceEndpoints(app);
});

async function invoke() {
  const response = {
    locals: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    sendStatus(code) { this.statusCode = code; return { end: () => {} }; },
  };
  await listRoute({}, response);
  return response;
}

describe("GET /workspaces personal auto-create", () => {
  const user = { id: 7, username: "alice", role: "default" };

  it("ensures a personal workspace before listing in multi-user mode", async () => {
    multiUserMode.mockReturnValue(true);
    userFromSession.mockResolvedValue(user);
    Workspace.ensurePersonal.mockResolvedValue({ workspace: { id: 1 }, created: true });
    Workspace.whereWithUser.mockResolvedValue([{ id: 1 }]);

    const res = await invoke();

    expect(Workspace.ensurePersonal).toHaveBeenCalledWith(user);
    expect(Workspace.ensurePersonal.mock.invocationCallOrder[0])
      .toBeLessThan(Workspace.whereWithUser.mock.invocationCallOrder[0]);
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
    Workspace.ensurePersonal.mockResolvedValue({ workspace: null, created: false });
    Workspace.whereWithUser.mockResolvedValue([]);
    const res = await invoke();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ workspaces: [] });
  });

  it("passes only the session user to ensurePersonal, never request data", async () => {
    multiUserMode.mockReturnValue(true);
    userFromSession.mockResolvedValue(user);
    Workspace.ensurePersonal.mockResolvedValue({ workspace: null, created: false });
    Workspace.whereWithUser.mockResolvedValue([]);
    await listRoute({ body: { username: "evil" }, query: { name: "evil" } }, {
      locals: {}, status() { return this; }, json() { return this; }, sendStatus() { return { end() {} }; },
    });
    expect(Workspace.ensurePersonal).toHaveBeenCalledTimes(1);
    expect(Workspace.ensurePersonal.mock.calls[0][0]).toBe(user);
  });
});
```

If `workspaceEndpoints(app)` throws on a missing mock (the module has more requires than listed), add a `jest.mock` for that module returning `{}` — do not remove any existing test.

- [ ] **Step 2: Run to verify it fails**

Run: `node ../node_modules/jest/bin/jest.js __tests__/endpoints/workspacePersonal.test.js`
Expected: the first and fourth tests FAIL (`ensurePersonal` not called).

- [ ] **Step 3: Implement**

Replace the body of the `/workspaces` route in `server/endpoints/workspaces.js`:

```js
      try {
        const user = await userFromSession(request, response);
        const isMultiUser = multiUserMode(response);
        if (isMultiUser) await Workspace.ensurePersonal(user);
        const workspaces = isMultiUser
          ? await Workspace.whereWithUser(user)
          : await Workspace.where();

        response.status(200).json({ workspaces });
      } catch (e) {
```

- [ ] **Step 4: Run to verify it passes**

Run: `node ../node_modules/jest/bin/jest.js __tests__/endpoints/workspacePersonal.test.js __tests__/models/workspaceEnsurePersonal.test.js`
Expected: `Tests: 9 passed, 9 total`.

- [ ] **Step 5: Commit**

```bash
git add server/endpoints/workspaces.js server/__tests__/endpoints/workspacePersonal.test.js
git commit -m "feat(workspace): auto-create a personal workspace for default users on list (#39)"
```
