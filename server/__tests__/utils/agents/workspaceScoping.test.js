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
const { WORKSPACE_AGENT } = require("../../../utils/agents/defaults");

const wsA = { id: 1, slug: "a", name: "A" };
const wsB = { id: 2, slug: "b", name: "B" };

describe("workspace-scoped agent skills", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    SystemPromptVariables.expandSystemPromptVariables.mockImplementation(
      async (prompt) => prompt
    );
    // Global settings must be irrelevant now: pretend admin enabled everything globally.
    SystemSettings.getValueOrFallback = jest.fn(async ({ label }) => {
      if (label === "default_agent_skills")
        return JSON.stringify(["sql-agent", "web-browsing"]);
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
    const def = await WORKSPACE_AGENT.getDefinition(
      null,
      { id: 99, slug: "new" },
      null,
      ""
    );
    expect(def.functions).toEqual([]);
  });
});
