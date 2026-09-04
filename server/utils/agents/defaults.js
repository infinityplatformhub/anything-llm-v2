const AgentPlugins = require("./aibitat/plugins");
const { SystemSettings } = require("../../models/systemSettings");
const {
  WorkspaceAgentSettings,
} = require("../../models/workspaceAgentSettings");
const { safeJsonParse } = require("../http");
const Provider = require("./aibitat/providers/ai-provider");
const ImportedPlugin = require("./imported");
const { AgentFlows } = require("../agentFlows");
const MCPCompatibilityLayer = require("../MCP");

// Skills that must never be injected when the instance is running in multi-user mode.
const SINGLE_USER_ONLY_SKILLS = new Set(["create-scheduled-job"]);

/**
 * Configuration for agent skills that require availability checks and disabled sub-skill lists.
 * Each entry maps a skill name to its availability checker and disabled skills list key.
 */
const SKILL_FILTER_CONFIG = {
  "filesystem-agent": {
    getAvailability: () =>
      require("./aibitat/plugins/filesystem/lib").isToolAvailable(),
    disabledSettingKey: "disabled_filesystem_skills",
  },
  "create-files-agent": {
    getAvailability: () =>
      require("./aibitat/plugins/create-files/lib").isToolAvailable(),
    disabledSettingKey: "disabled_create_files_skills",
  },
  "gmail-agent": {
    getAvailability: async () =>
      require("./aibitat/plugins/gmail/lib").GmailBridge.isToolAvailable(),
    disabledSettingKey: "disabled_gmail_skills",
  },
  "outlook-agent": {
    getAvailability: async () =>
      require("./aibitat/plugins/outlook/lib").OutlookBridge.isToolAvailable(),
    disabledSettingKey: "disabled_outlook_skills",
  },
};

const USER_AGENT = {
  name: "USER",
  getDefinition: () => {
    return {
      interrupt: "ALWAYS",
      role: "I am the human monitor and oversee this chat. Any questions on action or decision making should be directed to me.",
    };
  },
};

const WORKSPACE_AGENT = {
  name: "@agent",
  /**
   * Get the definition for the workspace agent with its role (prompt) and functions in Aibitat format
   * @param {string} _provider - Unused, kept for call-site compatibility
   * @param {import("@prisma/client").workspaces | null} workspace
   * @param {import("@prisma/client").users | null} user
   * @param {string} [prompt] - Current user message for memory reranking
   * @returns {Promise<{ role: string, functions: object[] }>}
   */
  getDefinition: async (
    _provider = null,
    workspace = null,
    user = null,
    prompt = ""
  ) => {
    let [role, clarifyingQuestionsSkills] = await Promise.all([
      Provider.systemPrompt({
        workspace,
        user,
        prompt,
      }),
      clarifyingQuestionsSkillIfEnabled(),
    ]);

    // If clarifying questions tools are enabled, add a note to the role that the user must use the request-user-input tool to ask questions.
    if (!!clarifyingQuestionsSkills?.length)
      role +=
        "\n\nWhen you need information from the user (URLs, file paths, preferences, choices, etc.), you MUST use the request-user-input tool. Do not ask questions in your text response - the user cannot reply to text. Only the tool can collect user input.";

    return {
      role,
      functions: [
        ...(await agentSkillsForWorkspace(workspace)),
        ...clarifyingQuestionsSkills,
        ...ImportedPlugin.activeImportedPlugins(),
        ...AgentFlows.activeFlowPlugins(),
        ...(await new MCPCompatibilityLayer().activeMCPServers()),
      ],
    };
  },
};

/**
 * Conditionally include the request-user-input sub-tools in the workspace agent's
 * function list when the admin has enabled clarifying questions.
 * Returns an empty array when disabled so the tools aren't visible to the LLM.
 * Names use the parent#child convention so #attachPlugins loads each sub-tool.
 * @returns {Promise<string[]>}
 */
async function clarifyingQuestionsSkillIfEnabled() {
  const enabled =
    (await SystemSettings.getValueOrFallback(
      { label: "agent_clarifying_questions_enabled" },
      "false"
    )) === "true";
  if (!enabled) return [];

  const parentName = AgentPlugins.requestUserInput.name;
  const subPlugins = AgentPlugins.requestUserInput.plugin;
  if (!Array.isArray(subPlugins)) return [];
  return subPlugins.map((sub) => `${parentName}#${sub.name}`);
}

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
        systemFunctions.push(
          `${AgentPlugins[skillName].name}#${subPlugin.name}`
        );
      }
      continue;
    }
    systemFunctions.push(AgentPlugins[skillName].name);
  }
  return systemFunctions;
}

/**
 * Resolve a UI skill/tool identifier into the names needed to toggle it on a live
 * agent session. `loadable` are the funcsToLoad-style identifiers handed to the
 * plugin loader to (re)register the tool via `aibitat.use()`; `registered` are the
 * resulting `aibitat.functions` Map keys to delete when disabling.
 *
 * Handles flows (`@@flow_<uuid>`), multi-stage parents (e.g. sql-agent -> each
 * child), imported hubIds, MCP server tools, single built-ins, and sub-skill
 * child names.
 * @param {string} skill - Skill key, `@@flow_<uuid>`, MCP `<server>-<tool>`, hubId, or sub-skill name.
 * @param {object} [opts]
 * @param {string|null} [opts.serverName] - MCP server name; required to enable an MCP tool.
 * @returns {{ loadable: string[], registered: string[] }}
 */
function resolveAgentSkill(skill = "", { serverName = null } = {}) {
  // Flow tool: loaded by `@@flow_<uuid>`, registered under its sanitized tool name.
  if (skill.startsWith("@@flow_")) {
    const uuid = skill.replace("@@flow_", "");
    const flow = AgentFlows.loadFlow(uuid);
    if (!flow) return { loadable: [], registered: [] };
    return {
      loadable: [skill],
      registered: [AgentFlows.sanitizeToolName(flow.name) || `flow_${uuid}`],
    };
  }

  // MCP server tool (`<server>-<tool>`): the Map key matches the UI id exactly.
  // Enabling reloads the server so the current suppression state is respected.
  if (serverName)
    return { loadable: [`@@mcp_${serverName}`], registered: [skill] };

  // Top-level built-in skill.
  const plugin = AgentPlugins[skill];
  if (plugin) {
    // Multi-stage plugin (e.g. sql-agent) registers one function per child.
    if (Array.isArray(plugin.plugin))
      return {
        loadable: plugin.plugin.map((c) => `${plugin.name}#${c.name}`),
        registered: plugin.plugin.map((c) => c.name),
      };
    return { loadable: [plugin.name], registered: [plugin.name] };
  }

  // Imported plugin referenced by hubId (registered under the hubId itself).
  if (ImportedPlugin.validateImportedPluginHandler(skill))
    return { loadable: [`@@${skill}`], registered: [skill] };

  // Sub-skill child name (e.g. a filesystem-agent child): find its parent so the
  // loader can attach just that child via the `parent#child` convention.
  for (const key of Object.keys(AgentPlugins)) {
    const parent = AgentPlugins[key];
    if (!Array.isArray(parent?.plugin)) continue;
    const child = parent.plugin.find((c) => c.name === skill);
    if (child)
      return {
        loadable: [`${parent.name}#${child.name}`],
        registered: [child.name],
      };
  }

  // Fallback: treat the id as both the loadable entry and the registered name.
  return { loadable: [skill], registered: [skill] };
}

module.exports = {
  USER_AGENT,
  WORKSPACE_AGENT,
  agentSkillsFromSystemSettings: agentSkillsForWorkspace,
  agentSkillsForWorkspace,
  resolveAgentSkill,
};
