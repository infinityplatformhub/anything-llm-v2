const prisma = require("../utils/prisma");
const { safeJsonParse } = require("../utils/http");

const WorkspaceAgentSettings = {
  /** @returns {Promise<string[]>} AgentPlugins keys enabled for this workspace. Empty when unset. */
  enabledSkills: async function (workspaceId) {
    const row = await prisma.workspace_agent_settings.findUnique({
      where: { workspace_id: Number(workspaceId) },
    });
    const parsed = safeJsonParse(row?.enabled_skills ?? "[]", []);
    return Array.isArray(parsed)
      ? parsed.filter((s) => typeof s === "string")
      : [];
  },

  /**
   * Replace the enabled skill list. Unknown ids and non-strings are dropped.
   * @returns {Promise<{enabledSkills: string[], error: string|null}>}
   */
  setEnabledSkills: async function (workspaceId, skills = []) {
    try {
      const AgentPlugins = require("../utils/agents/aibitat/plugins");
      const clean = [
        ...new Set(
          (Array.isArray(skills) ? skills : []).filter(
            (s) =>
              typeof s === "string" &&
              Object.prototype.hasOwnProperty.call(AgentPlugins, s)
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
