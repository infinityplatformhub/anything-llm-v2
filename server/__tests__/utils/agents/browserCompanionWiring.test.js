process.env.STORAGE_DIR = __dirname;
process.env.NODE_ENV = "test";

/**
 * Starts where a user starts: "I enabled the Browser companion skill."
 *
 * Every other test for this feature starts downstream of the break — the
 * extension suites drive `dispatch.handle`, the server suites drive the plugin
 * handlers, the live-Chrome run fed the WebSocket by hand. All of them passed
 * while the model was handed ZERO browser tools, because nothing ran the path
 * that turns an enabled skill into the function list a provider is called with.
 *
 * That path has exactly two halves and they have to agree:
 *   1. `WORKSPACE_AGENT.getDefinition()` -> `agentSkillsForWorkspace()` decides
 *      what NAMES go in the agent's `functions` array (defaults.js).
 *   2. `AgentHandler.createAIbitat()` -> `#attachPlugins` registers handlers in
 *      `aibitat.functions` under the names the plugin chose.
 * `aibitat/index.js` resolves (1) against (2) with
 * `this.functions.get(#parseFunctionName(name))` and DROPS every miss with
 * `.filter((a) => !!a)`. A silent drop is why this shipped dead.
 *
 * So this test resolves the two halves against each other the same way, through
 * the real handler and the real attach path, and asserts all eleven tools
 * survive. No `aibitat.function()` calls of its own: registering the tools here
 * would test this file, not the wiring.
 */
require("./../lark/_polyfill");

const fs = require("fs");
const path = require("path");

jest.mock("../../../models/systemPromptVariables");
jest.mock("../../../models/systemSettings");
jest.mock("../../../models/workspaceAgentSettings", () => ({
  WorkspaceAgentSettings: { enabledSkills: jest.fn().mockResolvedValue([]) },
}));
jest.mock("../../../models/workspaceChats", () => ({
  WorkspaceChats: { where: jest.fn().mockResolvedValue([]) },
}));
jest.mock("../../../utils/agents/imported", () => ({
  activeImportedPlugins: jest.fn().mockReturnValue([]),
  validateImportedPluginHandler: jest.fn().mockReturnValue(false),
}));
jest.mock("../../../utils/agentFlows", () => ({
  AgentFlows: { activeFlowPlugins: jest.fn().mockReturnValue([]) },
}));
jest.mock("../../../utils/MCP", () =>
  jest.fn().mockImplementation(() => ({
    activeMCPServers: jest.fn().mockResolvedValue([]),
  }))
);

const {
  SystemPromptVariables,
} = require("../../../models/systemPromptVariables");
const { SystemSettings } = require("../../../models/systemSettings");
const {
  WorkspaceAgentSettings,
} = require("../../../models/workspaceAgentSettings");
const { AgentHandler } = require("../../../utils/agents");
const { WORKSPACE_AGENT } = require("../../../utils/agents/defaults");
const AgentPlugins = require("../../../utils/agents/aibitat/plugins");
const {
  browserCompanion,
} = require("../../../utils/agents/aibitat/plugins/browser-companion");

const workspace = { id: 1, slug: "ws", name: "WS", openAiPrompt: null };

/**
 * The resolution `aibitat.reply()` performs before every model call, copied in
 * behaviour from server/utils/agents/aibitat/index.js:921-923 — `#parseFunctionName`
 * is private, so its one rule (`parent#child` -> `child`, `@@x` -> `x`) is
 * reproduced here rather than reached into.
 *
 * Kept deliberately literal: this is the line the bug hid behind, and a helper
 * that "resolved" more cleverly than production would hide it again.
 */
function toolsTheModelSees(aibitat, definition) {
  return (definition.functions || [])
    .map((name) => {
      if (!name.includes("#") && !name.startsWith("@@")) return name;
      if (name.startsWith("@@")) return name.replace("@@", "");
      return name.split("#")[1];
    })
    .map((name) => aibitat.functions.get(name))
    .filter((a) => !!a);
}

async function handlerWithBrowserCompanion() {
  const handler = new AgentHandler({ uuid: "browser-companion-wiring" });
  handler.invocation = {
    workspace,
    workspace_id: workspace.id,
    user_id: null,
    prompt: "test",
  };
  await handler.createAIbitat({ socket: { send: jest.fn() } });
  return handler;
}

describe("browser-companion reaches the model", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    SystemSettings.isMultiUserMode.mockResolvedValue(false);
    SystemSettings.getValueOrFallback.mockResolvedValue("false");
    SystemPromptVariables.expandSystemPromptVariables.mockImplementation(
      async (prompt) => prompt
    );
    // The user enabled exactly this skill, and nothing else.
    WorkspaceAgentSettings.enabledSkills.mockResolvedValue([
      "browser-companion",
    ]);
  });

  // THE test. Fails on the broken wiring with zero tools resolved.
  it("hands the model all eleven page tools when the skill is enabled", async () => {
    const handler = await handlerWithBrowserCompanion();
    const definition = await WORKSPACE_AGENT.getDefinition(
      null,
      workspace,
      null,
      "test"
    );

    const visible = toolsTheModelSees(handler.aibitat, definition).map(
      (fn) => fn.name
    );
    expect(visible.sort()).toEqual([...browserCompanion.toolNames].sort());
    expect(visible).toHaveLength(11);
  });

  // The generic half: no skill a user can switch on may advertise a function
  // that nothing registers. Written against every toggle in the admin UI rather
  // than against browser-companion alone, so the NEXT multi-tool skill is
  // covered without anyone remembering to add a case — this bug was one skill's
  // instance of a class of bug, and the class is what needs the guard.
  //
  // The skill ids are READ OUT of skills.jsx, not retyped. That makes this the
  // guard for a second seam too: `canonicalSkillIds`
  // (models/workspaceAgentSettings.js) drops any id where
  // `AgentPlugins[id].name !== id`, so a typo in the frontend toggle saves and
  // loads nothing, silently. Here such an id resolves to no functions and the
  // count assertion below fails.
  //
  // `lark-cli` is excluded, and only lark-cli: it registers its function only
  // when the invocation HAS a user_id (lark-cli.js), and this handler runs with
  // `user_id: null` (single-user mode). That is a deliberate availability gate,
  // not a wiring break.
  it("leaves no advertised function unresolved for any user-toggleable skill", async () => {
    const skillsSource = fs.readFileSync(
      path.join(__dirname, "../../../../frontend/src/pages/Admin/Agents/skills.jsx"),
      "utf8"
    );
    const uiSkillIds = [
      ...new Set(
        [...skillsSource.matchAll(/^\s*skill:\s*"([^"]+)"/gm)].map((m) => m[1])
      ),
    ];
    expect(uiSkillIds).toContain("browser-companion");

    WorkspaceAgentSettings.enabledSkills.mockResolvedValue(
      uiSkillIds.filter((id) => id !== "lark-cli")
    );
    const handler = await handlerWithBrowserCompanion();
    const definition = await WORKSPACE_AGENT.getDefinition(
      null,
      workspace,
      null,
      "test"
    );

    const unresolved = (definition.functions || []).filter((name) => {
      const key = name.includes("#") ? name.split("#")[1] : name;
      return !handler.aibitat.functions.has(key);
    });
    expect(unresolved).toEqual([]);
    // Every UI toggle must contribute at least one function, or it is a toggle
    // for nothing: the id is absent from AgentPlugins, or misspelled such that
    // canonicalSkillIds silently discards it.
    for (const id of uiSkillIds) {
      if (id === "lark-cli") continue;
      expect(Object.prototype.hasOwnProperty.call(AgentPlugins, id)).toBe(true);
      expect(AgentPlugins[id].name).toBe(id);
    }
    expect(definition.functions.length).toBeGreaterThan(uiSkillIds.length);
  });
});
