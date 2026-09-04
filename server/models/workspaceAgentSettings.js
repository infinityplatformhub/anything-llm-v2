const prisma = require("../utils/prisma");

function parseSkillIds(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function canonicalSkillIds(list) {
  const AgentPlugins = require("../utils/agents/aibitat/plugins");
  return [
    ...new Set(
      list.filter(
        (s) =>
          typeof s === "string" &&
          Object.prototype.hasOwnProperty.call(AgentPlugins, s) &&
          AgentPlugins[s].name === s
      )
    ),
  ];
}

const WorkspaceAgentSettings = {
  /**
   * @param {number|string} workspaceId
   * @returns {Promise<string[]>} Canonical skill ids enabled for this workspace.
   */
  enabledSkills: async function (workspaceId) {
    try {
      const workspace_id = Number(workspaceId);
      const row = await prisma.workspace_agent_settings.findUnique({
        where: { workspace_id },
        select: { enabled_skills: true },
      });
      return canonicalSkillIds(parseSkillIds(row?.enabled_skills ?? "[]"));
    } catch (error) {
      console.error(error);
      return [];
    }
  },

  /**
   * Replace enabled skills with canonical, known skill ids.
   * @param {number|string} workspaceId
   * @param {string[]} skills
   * @returns {Promise<{enabledSkills: string[]|null, error: string|null}>}
   */
  setEnabledSkills: async function (workspaceId, skills) {
    try {
      const workspace_id = Number(workspaceId);
      const clean = canonicalSkillIds(Array.isArray(skills) ? skills : []);
      const json = JSON.stringify(clean);
      await prisma.workspace_agent_settings.upsert({
        where: { workspace_id },
        create: { workspace_id, enabled_skills: json },
        update: { enabled_skills: json },
      });
      return { enabledSkills: clean, error: null };
    } catch (error) {
      console.error(error);
      return { enabledSkills: null, error: error.message };
    }
  },
};

module.exports = { WorkspaceAgentSettings };
