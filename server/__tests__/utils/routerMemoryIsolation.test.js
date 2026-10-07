jest.mock("../../models/modelRouter", () => ({ ModelRouter: {} }));
jest.mock("../../utils/agents/aibitat/plugins/router-classifier", () => ({ classifyWithLLM: jest.fn() }));
jest.mock("../../utils/chats", () => ({
  chatPrompt: jest.fn(async () => "Public prompt"),
  recentChatHistory: jest.fn(async () => ({ rawHistory: [], chatHistory: [] })),
}));
jest.mock("../../utils/DocumentManager", () => ({
  DocumentManager: jest.fn(() => ({ pinnedDocs: jest.fn(async () => []) })),
}));
jest.mock("../../models/workspaceParsedFiles", () => ({
  WorkspaceParsedFiles: { getContextFiles: jest.fn(async () => []) },
}));
jest.mock("../../utils/helpers/tiktoken", () => ({
  TokenManager: jest.fn(() => ({ countFromString: (text) => text.length })),
}));
jest.mock("../../utils/AiProviders/modelRouter", () => ({
  AnythingLLMModelRouter: jest.fn(() => ({
    resolve: jest.fn(async () => ({ connector: {}, routingMetadata: null })),
  })),
}));

const { ModelRouterService } = require("../../utils/router");
const { chatPrompt } = require("../../utils/chats");
const { resolveProviderConnector } = require("../../utils/helpers");

describe("routing memory isolation", () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([true, false])("passes skipMemories=%s through connector resolution", async (skipMemories) => {
    await resolveProviderConnector({
      workspace: { id: 7, slug: "public", router_id: 1, chatProvider: "anythingllm-router" },
      prompt: "hello",
      chatHistoryOverride: { rawHistory: [], chatHistory: [] },
      messageCountOverride: 1,
      skipMemories,
    });
    expect(chatPrompt).toHaveBeenCalledWith(
      expect.any(Object), null,
      expect.objectContaining({ skipMemories, prompt: "hello" })
    );
  });

  it("defaults authenticated routing to normal memory behavior", async () => {
    await ModelRouterService.gatherRoutingContext({
      workspace: { id: 7 }, user: { id: 3 }, message: "hello",
      chatHistoryOverride: { rawHistory: [], chatHistory: [] }, messageCountOverride: 1,
    });
    expect(chatPrompt).toHaveBeenCalledWith(
      { id: 7 }, { id: 3 }, expect.objectContaining({ skipMemories: false })
    );
  });
});
