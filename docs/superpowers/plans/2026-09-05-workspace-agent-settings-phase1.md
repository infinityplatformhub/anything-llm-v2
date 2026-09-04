# Workspace-scoped agent capabilities — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Built-in agent skills are enabled per workspace (deny by default) instead of globally, with an admin-only API and a workspace selector on Admin › Agents.

**Architecture:** New Prisma table `workspace_agent_settings` (1:1 with `workspaces`) holds `enabled_skills` JSON. `WORKSPACE_AGENT.getDefinition()` in `server/utils/agents/defaults.js` reads that row for the workspace instead of the global `default_agent_skills` / `disabled_agent_skills` system settings. New admin endpoints `GET/POST /admin/workspace/:slug/agent-skills`. Frontend Admin › Agents page gets a workspace selector and routes the built-in skill toggles through the new endpoint. Custom skills, flows, MCP, credentials, jobs stay global in this phase (phases 2-6).

**Tech Stack:** Node/Express, Prisma (SQLite), Jest (root `jest.config.cjs`, run from repo root), React + Vite frontend.

**Issue:** #1 · **Spec:** `docs/superpowers/specs/2026-09-05-workspace-scoped-agent-capabilities.md` · **Mockup:** `docs/superpowers/mockups/workspace-owned-agent-capabilities.html` @ `ce6093ef`

**Evidence contract:** `npx jest server/__tests__/utils/agents/workspaceScoping.test.js` → `Tests:       2 passed`

**Ledger:** every ruling goes to `.superpowers/sdd/<plan>/ledger.md` as `Ruling: <what> — <why> — <cost if wrong>`.

---

## File map

| Path | Action | Responsibility |
|---|---|---|
| `server/prisma/schema.prisma` | modify | add `workspace_agent_settings` model + relation on `workspaces` |
| `server/prisma/migrations/<ts>_workspace_agent_settings/migration.sql` | create (via `prisma migrate dev`) | table DDL |
| `server/models/workspaceAgentSettings.js` | create | `get(workspaceId)`, `enabledSkills(workspaceId)`, `setEnabledSkills(workspaceId, skills)` |
| `server/utils/agents/defaults.js:86-194` | modify | `agentSkillsFromSystemSettings()` → `agentSkillsForWorkspace(workspace)` |
| `server/__tests__/utils/agents/workspaceScoping.test.js` | create | evidence contract (2 tests) |
| `server/__tests__/models/workspaceAgentSettings.test.js` | create | model unit tests |
| `server/endpoints/admin.js` | modify | add `GET/POST /admin/workspace/:slug/agent-skills` |
| `server/__tests__/endpoints/adminWorkspaceAgentSkills.test.js` | create | endpoint auth + shape tests |
| `frontend/src/models/admin.js` | modify | `workspaceAgentSkills(slug)`, `updateWorkspaceAgentSkills(slug, skills)` |
| `frontend/src/pages/Admin/Agents/WorkspaceSelector/index.jsx` | create | dropdown, `?workspace=<slug>` sync |
| `frontend/src/pages/Admin/Agents/index.jsx` | modify | selector + load/save built-in skills per workspace |
| `frontend/src/pages/WorkspaceSettings/AgentConfig/index.jsx:86-106` | modify | link carries `?workspace=<slug>`, copy no longer says "all workspaces" |

**Skill id vocabulary (unchanged):** keys of `AgentPlugins` in `server/utils/agents/aibitat/plugins/index.js` (e.g. `rag-memory`, `document-summarizer`, `web-scraping`, `web-browsing`, `sql-agent`, `create-chart`, `save-file-to-browser`, …). `enabled_skills` stores those keys. Sub-skill filtering (`SKILL_FILTER_CONFIG`, `disabled_filesystem_skills` etc.) stays global in this phase.

---

### Task 1: Prisma model + migration

**Files:**
- Modify: `server/prisma/schema.prisma:121-152` (workspaces) and append new model
- Create: migration via CLI

- [ ] **Step 1: Add model**

Append to `server/prisma/schema.prisma`:

```prisma
model workspace_agent_settings {
  id             Int        @id @default(autoincrement())
  workspace_id   Int        @unique
  enabled_skills String     @default("[]") // JSON array of AgentPlugins keys
  skill_configs  String?    // reserved for phase 4 (encrypted JSON)
  createdAt      DateTime   @default(now())
  lastUpdatedAt  DateTime   @default(now())
  workspace      workspaces @relation(fields: [workspace_id], references: [id], onDelete: Cascade, onUpdate: Cascade)
}
```

Add inside `model workspaces { … }` after line 151 (`memories memories[]`):

```prisma
  agent_settings               workspace_agent_settings?
```

- [ ] **Step 2: Generate migration**

Run from `server/`:
```bash
npx prisma migrate dev --name workspace_agent_settings
```
Expected: new folder `server/prisma/migrations/<ts>_workspace_agent_settings/` containing `CREATE TABLE "workspace_agent_settings"` with `"workspace_id" INTEGER NOT NULL` and a unique index on `workspace_id`. Then `npx prisma generate` runs automatically.

- [ ] **Step 3: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations
git commit -m "feat(agents): add workspace_agent_settings table"
```

---

### Task 2: Model `WorkspaceAgentSettings`

**Files:**
- Create: `server/models/workspaceAgentSettings.js`
- Test: `server/__tests__/models/workspaceAgentSettings.test.js`

- [ ] **Step 1: Write failing test**

```js
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
    expect(await WorkspaceAgentSettings.enabledSkills(7)).toEqual(["rag-memory", "sql-agent"]);
  });

  it("enabledSkills returns [] on corrupt JSON", async () => {
    prisma.workspace_agent_settings.findUnique.mockResolvedValue({ enabled_skills: "{oops" });
    expect(await WorkspaceAgentSettings.enabledSkills(7)).toEqual([]);
  });

  it("setEnabledSkills upserts only known string ids, deduped", async () => {
    prisma.workspace_agent_settings.upsert.mockResolvedValue({ enabled_skills: '["rag-memory"]' });
    const res = await WorkspaceAgentSettings.setEnabledSkills(7, ["rag-memory", "rag-memory", 42, "not-a-skill"]);
    expect(prisma.workspace_agent_settings.upsert).toHaveBeenCalledWith({
      where: { workspace_id: 7 },
      create: { workspace_id: 7, enabled_skills: '["rag-memory"]' },
      update: { enabled_skills: '["rag-memory"]', lastUpdatedAt: expect.any(Date) },
    });
    expect(res.error).toBeNull();
    expect(res.enabledSkills).toEqual(["rag-memory"]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
npx jest server/__tests__/models/workspaceAgentSettings.test.js
```
Expected: `Cannot find module '../../models/workspaceAgentSettings'`

- [ ] **Step 3: Implement**

`server/models/workspaceAgentSettings.js`:

```js
const prisma = require("../utils/prisma");
const { safeJsonParse } = require("../utils/http");
const AgentPlugins = require("../utils/agents/aibitat/plugins");

const WorkspaceAgentSettings = {
  /** @returns {Promise<string[]>} AgentPlugins keys enabled for this workspace. Empty when unset. */
  enabledSkills: async function (workspaceId) {
    const row = await prisma.workspace_agent_settings.findUnique({
      where: { workspace_id: Number(workspaceId) },
    });
    const parsed = safeJsonParse(row?.enabled_skills ?? "[]", []);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
  },

  /**
   * Replace the enabled skill list. Unknown ids and non-strings are dropped.
   * @returns {Promise<{enabledSkills: string[], error: string|null}>}
   */
  setEnabledSkills: async function (workspaceId, skills = []) {
    try {
      const clean = [
        ...new Set(
          (Array.isArray(skills) ? skills : []).filter(
            (s) => typeof s === "string" && Object.prototype.hasOwnProperty.call(AgentPlugins, s)
          )
        ),
      ];
      const json = JSON.stringify(clean);
      await prisma.workspace_agent_settings.upsert({
        where: { workspace_id: Number(workspaceId) },
        create: { workspace_id: Number(workspaceId), enabled_skills: json },
        update: { enabled_skills: json, lastUpdatedAt: new Date() },
      });
      return { enabledSkills: clean, error: null };
    } catch (error) {
      console.error(error.message);
      return { enabledSkills: [], error: error.message };
    }
  },
};

module.exports = { WorkspaceAgentSettings };
```

Check the real export shape of `server/utils/agents/aibitat/plugins/index.js` first: if it exports `{ AgentPlugins }` or default object, adjust the `require`. Confirm `"rag-memory"` is a key and `"not-a-skill"` is not.

- [ ] **Step 4: Run, expect PASS**

```bash
npx jest server/__tests__/models/workspaceAgentSettings.test.js
```
Expected: `Tests:       4 passed`

- [ ] **Step 5: Commit**

```bash
git add server/models/workspaceAgentSettings.js server/__tests__/models/workspaceAgentSettings.test.js
git commit -m "feat(agents): WorkspaceAgentSettings model, deny-by-default enabled skills"
```

---

### Task 3: Per-workspace filter in `getDefinition` (evidence contract)

**Files:**
- Modify: `server/utils/agents/defaults.js:86-194`
- Create: `server/__tests__/utils/agents/workspaceScoping.test.js`

- [ ] **Step 1: Write the failing contract test**

`server/__tests__/utils/agents/workspaceScoping.test.js`:

```js
process.env.STORAGE_DIR = __dirname;
process.env.NODE_ENV = "test";

jest.mock("../../../models/systemPromptVariables");
jest.mock("../../../models/systemSettings");
jest.mock("../../../models/workspaceAgentSettings");
jest.mock("../../../utils/agents/imported", () => ({
  activeImportedPlugins: jest.fn().mockReturnValue([]),
}));
jest.mock("../../../utils/agentFlows", () => ({
  AgentFlows: { activeFlowPlugins: jest.fn().mockReturnValue([]) },
}));
jest.mock("../../../utils/MCP", () =>
  jest.fn().mockImplementation(() => ({ activeMCPServers: jest.fn().mockResolvedValue([]) }))
);

const { SystemPromptVariables } = require("../../../models/systemPromptVariables");
const { SystemSettings } = require("../../../models/systemSettings");
const { WorkspaceAgentSettings } = require("../../../models/workspaceAgentSettings");
const { WORKSPACE_AGENT } = require("../../../utils/agents/defaults");

const wsA = { id: 1, slug: "a", name: "A" };
const wsB = { id: 2, slug: "b", name: "B" };

describe("workspace-scoped agent skills", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    SystemPromptVariables.expandSystemPromptVariables.mockImplementation(async (p) => p);
    // Global settings must be irrelevant now: pretend admin enabled everything globally.
    SystemSettings.getValueOrFallback = jest.fn(async ({ label }) => {
      if (label === "default_agent_skills") return JSON.stringify(["sql-agent", "web-browsing"]);
      if (label === "disabled_agent_skills") return "[]";
      return "[]";
    });
    SystemSettings.isMultiUserMode = jest.fn().mockResolvedValue(true);
    WorkspaceAgentSettings.enabledSkills.mockImplementation(async (id) =>
      id === wsA.id ? ["rag-memory", "sql-agent"] : []
    );
  });

  it("workspace A cannot see skills enabled for workspace B and vice versa", async () => {
    WorkspaceAgentSettings.enabledSkills.mockImplementation(async (id) => {
      if (id === wsA.id) return ["rag-memory"];
      if (id === wsB.id) return ["web-browsing"];
      return [];
    });
    const a = await WORKSPACE_AGENT.getDefinition(null, wsA, null, "");
    const b = await WORKSPACE_AGENT.getDefinition(null, wsB, null, "");
    expect(a.functions).toContain("rag-memory");
    expect(a.functions.some((f) => f.startsWith("web-browsing"))).toBe(false);
    expect(b.functions.some((f) => f.startsWith("web-browsing"))).toBe(true);
    expect(b.functions).not.toContain("rag-memory");
  });

  it("new workspace has zero enabled capabilities even when global settings enable skills", async () => {
    WorkspaceAgentSettings.enabledSkills.mockResolvedValue([]);
    const def = await WORKSPACE_AGENT.getDefinition(null, { id: 99, slug: "new" }, null, "");
    expect(def.functions).toEqual([]);
  });
});
```

Adjust the exact function names asserted (`"rag-memory"`, `"web-browsing"`) to match `AgentPlugins[key].name` for those keys — read `server/utils/agents/aibitat/plugins/index.js`. If `web-browsing` is a multi-plugin (`Array.isArray(.plugin)`), the loaded names are `${parent}#${child}`; the `startsWith` assertion covers both.

- [ ] **Step 2: Run, expect FAIL**

```bash
npx jest server/__tests__/utils/agents/workspaceScoping.test.js
```
Expected: FAIL. Test 1 fails because A sees `web-browsing` from global setting; test 2 fails because functions non-empty. If `jest.mock("../../../models/workspaceAgentSettings")` errors "cannot find module", Task 2 was not done.

- [ ] **Step 3: Implement filter**

In `server/utils/agents/defaults.js`:

Add import near the top with the other model requires:
```js
const { WorkspaceAgentSettings } = require("../../models/workspaceAgentSettings");
```

Replace line 89 `...(await agentSkillsFromSystemSettings()),` with:
```js
        ...(await agentSkillsForWorkspace(workspace)),
```

Replace the whole `agentSkillsFromSystemSettings` function (lines 120-194) with:

```js
/**
 * Built-in skills enabled for this workspace. Deny by default: a workspace
 * with no settings row gets no built-in skills. Global
 * `default_agent_skills` / `disabled_agent_skills` are no longer consulted.
 * @param {import("@prisma/client").workspaces | null} workspace
 * @returns {Promise<string[]>}
 */
async function agentSkillsForWorkspace(workspace) {
  if (!workspace?.id) return [];
  const systemFunctions = [];
  const isMultiUser = await SystemSettings.isMultiUserMode();
  const enabled = await WorkspaceAgentSettings.enabledSkills(workspace.id);

  // Pre-load disabled sub-skills and availability for configured skills (still global in phase 1)
  const skillFilterState = {};
  for (const skillName of Object.keys(SKILL_FILTER_CONFIG)) {
    if (!enabled.includes(skillName)) continue;
    const config = SKILL_FILTER_CONFIG[skillName];
    skillFilterState[skillName] = {
      available: await config.getAvailability(),
      disabledSubSkills: safeJsonParse(
        await SystemSettings.getValueOrFallback(
          { label: config.disabledSettingKey },
          "[]"
        ),
        []
      ),
    };
  }

  for (const skillName of enabled) {
    if (!AgentPlugins.hasOwnProperty(skillName)) continue;
    if (isMultiUser && SINGLE_USER_ONLY_SKILLS.has(skillName)) continue;

    if (Array.isArray(AgentPlugins[skillName].plugin)) {
      for (const subPlugin of AgentPlugins[skillName].plugin) {
        const filterState = skillFilterState[skillName];
        if (filterState) {
          if (!filterState.available) continue;
          if (filterState.disabledSubSkills.includes(subPlugin.name)) continue;
        }
        systemFunctions.push(`${AgentPlugins[skillName].name}#${subPlugin.name}`);
      }
      continue;
    }
    systemFunctions.push(AgentPlugins[skillName].name);
  }
  return systemFunctions;
}
```

Delete `DEFAULT_SKILLS` usage in this function only. If `DEFAULT_SKILLS` is exported/used elsewhere (grep `DEFAULT_SKILLS` in `server/`), leave the constant in place.

- [ ] **Step 4: Run contract, expect PASS**

```bash
npx jest server/__tests__/utils/agents/workspaceScoping.test.js
```
Expected: `Tests:       2 passed`

- [ ] **Step 5: Run existing agent tests, fix breakage**

```bash
npx jest server/__tests__/utils/agents
```
`defaults.test.js` mocks `SystemSettings.getValueOrFallback` → `"[]"` and has no `WorkspaceAgentSettings` mock. Add to its mocks:
```js
jest.mock("../../../models/workspaceAgentSettings", () => ({
  WorkspaceAgentSettings: { enabledSkills: jest.fn().mockResolvedValue([]) },
}));
```
Any test in that file that asserted a default skill (e.g. `rag-memory`) appears must now set `WorkspaceAgentSettings.enabledSkills.mockResolvedValue(["rag-memory"])` explicitly. Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add server/utils/agents/defaults.js server/__tests__/utils/agents
git commit -m "feat(agents): built-in skills resolved per workspace, deny by default"
```

---

### Task 4: Admin endpoints

**Files:**
- Modify: `server/endpoints/admin.js` (add two routes inside `adminEndpoints(app)`)
- Test: `server/__tests__/endpoints/adminWorkspaceAgentSkills.test.js`

- [ ] **Step 1: Write failing test**

Look at one existing test in `server/__tests__/endpoints/` for how routes are exercised (supertest vs calling handler). Follow that pattern. Test body:

```js
process.env.NODE_ENV = "test";
jest.mock("../../models/workspace");
jest.mock("../../models/workspaceAgentSettings");
jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_req, _res, next) => next(),
}));
const mockRoleCheck = jest.fn();
jest.mock("../../utils/middleware/multiUserProtected", () => ({
  ROLES: { admin: "admin", manager: "manager", default: "default", all: "<all>" },
  flexUserRoleValid: (roles) => {
    mockRoleCheck(roles);
    return (_req, _res, next) => next();
  },
}));

const express = require("express");
const request = require("supertest");
const { Workspace } = require("../../models/workspace");
const { WorkspaceAgentSettings } = require("../../models/workspaceAgentSettings");
const { adminEndpoints } = require("../../endpoints/admin");

function buildApp() {
  const app = express();
  app.use(express.json());
  adminEndpoints(app);
  return app;
}

describe("/admin/workspace/:slug/agent-skills", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Workspace.get.mockResolvedValue({ id: 5, slug: "legal" });
  });

  it("routes are admin-only", () => {
    buildApp();
    const adminOnlyCalls = mockRoleCheck.mock.calls.filter(
      ([roles]) => Array.isArray(roles) && roles.length === 1 && roles[0] === "admin"
    );
    expect(adminOnlyCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("GET returns enabledSkills for the workspace", async () => {
    WorkspaceAgentSettings.enabledSkills.mockResolvedValue(["rag-memory"]);
    const res = await request(buildApp()).get("/admin/workspace/legal/agent-skills");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabledSkills: ["rag-memory"] });
    expect(WorkspaceAgentSettings.enabledSkills).toHaveBeenCalledWith(5);
  });

  it("GET 404 on unknown workspace", async () => {
    Workspace.get.mockResolvedValue(null);
    const res = await request(buildApp()).get("/admin/workspace/nope/agent-skills");
    expect(res.status).toBe(404);
  });

  it("POST replaces enabledSkills", async () => {
    WorkspaceAgentSettings.setEnabledSkills.mockResolvedValue({ enabledSkills: ["sql-agent"], error: null });
    const res = await request(buildApp())
      .post("/admin/workspace/legal/agent-skills")
      .send({ enabledSkills: ["sql-agent"] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, enabledSkills: ["sql-agent"], error: null });
    expect(WorkspaceAgentSettings.setEnabledSkills).toHaveBeenCalledWith(5, ["sql-agent"]);
  });

  it("POST 400 when enabledSkills is not an array", async () => {
    const res = await request(buildApp())
      .post("/admin/workspace/legal/agent-skills")
      .send({ enabledSkills: "sql-agent" });
    expect(res.status).toBe(400);
  });
});
```

If `supertest` is not installed at root or in `server/` (`ls node_modules/supertest server/node_modules/supertest`), check how other endpoint tests invoke handlers and mirror that instead of adding a dependency. Record as a Ruling either way.

Note on the admin-only assertion: it counts *any* admin-only registration in `admin.js`, so it is a weak guard. Strengthen it by also asserting, after `buildApp()`, that `app._router.stack` contains a layer whose `route.path === "/admin/workspace/:slug/agent-skills"` for both `get` and `post`.

- [ ] **Step 2: Run, expect FAIL**

```bash
npx jest server/__tests__/endpoints/adminWorkspaceAgentSkills.test.js
```
Expected: 404 on both routes (not registered).

- [ ] **Step 3: Implement routes**

In `server/endpoints/admin.js`, add requires at top (check they are not already imported):
```js
const { Workspace } = require("../models/workspace");
const { WorkspaceAgentSettings } = require("../models/workspaceAgentSettings");
```

Inside `adminEndpoints(app)` add:

```js
  app.get(
    "/admin/workspace/:slug/agent-skills",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const workspace = await Workspace.get({ slug: String(request.params.slug) });
        if (!workspace) return response.sendStatus(404).end();
        const enabledSkills = await WorkspaceAgentSettings.enabledSkills(workspace.id);
        response.status(200).json({ enabledSkills });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/admin/workspace/:slug/agent-skills",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const workspace = await Workspace.get({ slug: String(request.params.slug) });
        if (!workspace) return response.sendStatus(404).end();
        const { enabledSkills } = reqBody(request);
        if (!Array.isArray(enabledSkills)) return response.sendStatus(400).end();
        const result = await WorkspaceAgentSettings.setEnabledSkills(workspace.id, enabledSkills);
        response.status(200).json({ success: !result.error, ...result });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );
```

`reqBody`, `validatedRequest`, `flexUserRoleValid`, `ROLES` are already imported in `admin.js` (verify with grep).

- [ ] **Step 4: Run, expect PASS**

```bash
npx jest server/__tests__/endpoints/adminWorkspaceAgentSkills.test.js
```
Expected: `Tests:       5 passed`

- [ ] **Step 5: Regenerate swagger if the repo does it in CI**

```bash
cd server && yarn swagger
```
Commit the swagger output only if the diff is limited to the two new routes.

- [ ] **Step 6: Commit**

```bash
git add server/endpoints/admin.js server/__tests__/endpoints/adminWorkspaceAgentSkills.test.js server/swagger
git commit -m "feat(admin): per-workspace agent-skills endpoints (admin only)"
```

---

### Task 5: Frontend model functions

**Files:**
- Modify: `frontend/src/models/admin.js` (after `updateSystemPreferences`, ~line 189)

- [ ] **Step 1: Add**

```js
  workspaceAgentSkills: async (slug) => {
    return await fetch(`${API_BASE}/admin/workspace/${encodeURIComponent(slug)}/agent-skills`, {
      method: "GET",
      headers: baseHeaders(),
    })
      .then((res) => (res.ok ? res.json() : { enabledSkills: [] }))
      .catch(() => ({ enabledSkills: [] }));
  },
  updateWorkspaceAgentSkills: async (slug, enabledSkills = []) => {
    return await fetch(`${API_BASE}/admin/workspace/${encodeURIComponent(slug)}/agent-skills`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ enabledSkills }),
    })
      .then((res) => res.json())
      .catch((e) => ({ success: false, error: e.message }));
  },
```

- [ ] **Step 2: Lint**

```bash
cd frontend && yarn lint
```
Expected: no errors in `models/admin.js`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/models/admin.js
git commit -m "feat(frontend): admin model calls for per-workspace agent skills"
```

---

### Task 6: WorkspaceSelector component

**Files:**
- Create: `frontend/src/pages/Admin/Agents/WorkspaceSelector/index.jsx`

- [ ] **Step 1: Implement**

```jsx
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Workspace from "@/models/workspace";

/**
 * Top bar for Admin › Agents. Every panel below is scoped to the selected workspace.
 * Selection is mirrored to `?workspace=<slug>` so links from Workspace Settings land on the right room.
 */
export default function WorkspaceSelector({ selectedSlug, onChange }) {
  const [workspaces, setWorkspaces] = useState([]);
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    Workspace.all().then((list) => {
      setWorkspaces(list);
      const fromUrl = searchParams.get("workspace");
      const initial = list.find((w) => w.slug === fromUrl)?.slug ?? list[0]?.slug ?? null;
      if (initial && initial !== selectedSlug) onChange(initial);
    });
  }, []);

  const select = (slug) => {
    setSearchParams({ workspace: slug });
    onChange(slug);
  };

  if (workspaces.length === 0) return null;
  return (
    <div className="flex items-center gap-x-3 bg-theme-bg-secondary border border-theme-sidebar-border rounded-lg px-4 py-2 mb-4">
      <label htmlFor="agent-workspace" className="text-xs uppercase tracking-wide text-theme-text-secondary">
        Workspace
      </label>
      <select
        id="agent-workspace"
        value={selectedSlug ?? ""}
        onChange={(e) => select(e.target.value)}
        className="bg-theme-settings-input-bg text-white text-sm rounded-lg px-3 py-1.5 min-w-[220px]"
      >
        {workspaces.map((w) => (
          <option key={w.slug} value={w.slug}>
            {w.name} — /{w.slug}
          </option>
        ))}
      </select>
      <span className="ml-auto text-xs text-theme-text-secondary">
        ทุกอย่างในหน้านี้เป็นของ workspace ที่เลือกเท่านั้น
      </span>
    </div>
  );
}
```

Verify the Tailwind theme class names (`bg-theme-bg-secondary`, `text-theme-text-secondary`, `bg-theme-settings-input-bg`) exist in `frontend/tailwind.config.js`; substitute the closest existing ones if not. Keep the Thai helper string in English if the page has no i18n for Thai; if `useTranslation` keys exist for Admin Agents, add a key `agent.workspaceSelector.scopeNote` in `frontend/src/locales/en/common.js` and run `yarn translations:normalize` from root.

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/Admin/Agents/WorkspaceSelector
git commit -m "feat(frontend): workspace selector for Admin Agents"
```

---

### Task 7: Wire Admin › Agents to per-workspace skills

**Files:**
- Modify: `frontend/src/pages/Admin/Agents/index.jsx:48-232`

- [ ] **Step 1: State**

Add after line 58 (`const [disabledAgentSkills, …]`):
```jsx
  const [workspaceSlug, setWorkspaceSlug] = useState(null);
```
Import at top:
```jsx
import WorkspaceSelector from "./WorkspaceSelector";
```

- [ ] **Step 2: Load per workspace**

Keep the existing `useEffect` at 116-148 for flows/MCP/availability but remove `"disabled_agent_skills"` and `"default_agent_skills"` from the `systemPreferencesByFields` list and remove `setAgentSkills(...)` / `setDisabledAgentSkills(...)` lines 136-139.

Add a second effect:
```jsx
  useEffect(() => {
    if (!workspaceSlug) return;
    let cancelled = false;
    Admin.workspaceAgentSkills(workspaceSlug).then(({ enabledSkills = [] }) => {
      if (cancelled) return;
      setAgentSkills(enabledSkills);
      setDisabledAgentSkills([]);
      setHasChanges(false);
    });
    return () => { cancelled = true; };
  }, [workspaceSlug]);
```

- [ ] **Step 3: Toggle semantics**

Default skills (`rag-memory`, `document-summarizer`, `web-scraping`) were previously "on unless disabled". Now they are ordinary entries in `enabledSkills`. Change `toggleDefaultSkill` (lines 150-158) to:
```jsx
  const toggleDefaultSkill = (skillName) => toggleAgentSkill(skillName);
```
Wherever `DefaultSkillPanel` is rendered with `enabled={!disabledAgentSkills.includes(skill)}`, change to `enabled={agentSkills.includes(skill)}`. Grep `disabledAgentSkills` in the file and in `SkillList`/`AgentSkillSettings` children; every read becomes `!agentSkills.includes(...)` or is deleted. Remove the `disabledAgentSkills` state once unused.

- [ ] **Step 4: Save**

In `handleSubmit` (188-232), replace the block that posts `data.system` for skills with:
```jsx
    const skillRes = workspaceSlug
      ? await Admin.updateWorkspaceAgentSkills(workspaceSlug, agentSkills)
      : { success: false, error: "No workspace selected" };
    const { success } = await Admin.updateSystemPreferences(data.system); // other prefs (reranker, clarifying qs, sub-skill toggles) stay global
    await System.updateSystem(data.env);
    if (success && skillRes.success) { … existing refresh, but re-fetch skills via Admin.workspaceAgentSkills(workspaceSlug) … }
```
Remove the hidden `<input name="system::default_agent_skills" …>` / `system::disabled_agent_skills` fields if present (grep `system::default_agent_skills`).

- [ ] **Step 5: Render selector**

At the top of the returned JSX, above the existing skill list/sidebar layout, add:
```jsx
<WorkspaceSelector selectedSlug={workspaceSlug} onChange={setWorkspaceSlug} />
```
When `workspaceSlug` is set and `agentSkills.length === 0`, show above the skill list:
```jsx
<p className="text-xs text-theme-text-secondary mb-2">ห้องนี้ยังไม่เปิด skill ใด — workspace ใหม่เริ่มจากศูนย์</p>
```

- [ ] **Step 6: Manual check**

Run `yarn dev` from root (or the project `run` skill). As admin: open `/settings/agents`, switch workspace, toggle `RAG & long-term memory`, Save, reload, confirm it persists for that workspace only. Create a second workspace, confirm it shows zero enabled. In a chat in the first workspace, `@agent` and confirm it can call RAG; in the second, confirm the agent reports no such tool.

- [ ] **Step 7: Lint + commit**

```bash
cd frontend && yarn lint
git add frontend/src/pages/Admin/Agents
git commit -m "feat(frontend): Admin Agents built-in skills are per workspace"
```

---

### Task 8: Workspace Settings link + copy

**Files:**
- Modify: `frontend/src/pages/WorkspaceSettings/AgentConfig/index.jsx:86-106`

- [ ] **Step 1: Edit**

Change `href={paths.settings.agentSkills()}` to
```jsx
href={`${paths.settings.agentSkills()}?workspace=${encodeURIComponent(workspace.slug)}`}
```
Replace the paragraph text "…These settings will be applied across all workspaces." with:
"Enable or disable agent skills for this workspace only. New workspaces start with no skills enabled."

- [ ] **Step 2: Lint + commit**

```bash
cd frontend && yarn lint
git add frontend/src/pages/WorkspaceSettings/AgentConfig/index.jsx
git commit -m "fix(frontend): agent skills link carries workspace, copy reflects per-workspace scope"
```

---

### Task 9: Full verification

- [ ] `npx jest` from root: all green.
- [ ] `yarn lint:ci` from root: clean.
- [ ] Evidence contract: `npx jest server/__tests__/utils/agents/workspaceScoping.test.js` → `Tests:       2 passed`.
- [ ] `task.sh check --issue 1` passes.

---

## Rulings pre-recorded (PMO)

- Ruling: `enabled_skills` stored as JSON **string** column, not Prisma `Json` — SQLite provider in this repo does not support `Json` type — cost if wrong: none, string is the repo's existing pattern (`system_settings.value`).
- Ruling: sub-skill toggles (`disabled_filesystem_skills`, etc.) and reranker/clarifying settings stay global in phase 1 — spec puts credentials/config in phase 4 — cost if wrong: one more migration later.
- Ruling: `agentProvider`/`agentModel` untouched — spec says manager keeps that — cost: none.
- Ruling: no data migration from `default_agent_skills` into any workspace — spec: deny by default, legacy import is phase 2 — cost: admins must re-enable skills per room after deploy (stated in spec).
