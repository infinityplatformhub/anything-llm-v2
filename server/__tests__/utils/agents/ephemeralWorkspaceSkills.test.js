process.env.STORAGE_DIR = __dirname;
process.env.NODE_ENV = "test";

jest.mock("../../../models/systemPromptVariables");
jest.mock("../../../models/systemSettings");
jest.mock("../../../models/workspaceAgentSettings");
jest.mock("../../../models/workspaceChats", () => ({
  WorkspaceChats: { where: jest.fn().mockResolvedValue([]) },
}));
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

const { SystemSettings } = require("../../../models/systemSettings");
const {
  WorkspaceAgentSettings,
} = require("../../../models/workspaceAgentSettings");
const {
  EphemeralAgentHandler,
} = require("../../../utils/agents/ephemeral");

const wsA = { id: 1, slug: "a", name: "A" };
const wsB = { id: 2, slug: "b", name: "B" };

it("loads built-in skills for the ephemeral agent's workspace", async () => {
  SystemSettings.isMultiUserMode.mockResolvedValue(false);
  SystemSettings.getValueOrFallback.mockResolvedValue("false");
  WorkspaceAgentSettings.enabledSkills.mockImplementation(async (id) =>
    id === wsA.id ? ["rag-memory"] : []
  );

  const createHandler = async (workspace) => {
    const agent = new EphemeralAgentHandler({
      uuid: `workspace-${workspace.id}`,
      workspace,
      prompt: "@agent test",
    });
    await agent.createAIbitat({ handler: { send: jest.fn() } });
    return agent;
  };

  const agentA = await createHandler(wsA);
  const agentB = await createHandler(wsB);

  expect(agentA.aibitat.functions.has("rag-memory")).toBe(true);
  expect(agentB.aibitat.functions.has("rag-memory")).toBe(false);
  expect(WorkspaceAgentSettings.enabledSkills).toHaveBeenCalledWith(wsA.id);
  expect(WorkspaceAgentSettings.enabledSkills).toHaveBeenCalledWith(wsB.id);
});
