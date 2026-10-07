jest.mock("../../../utils/helpers", () => ({
  getVectorDbClass: jest.fn(),
  resolveProviderConnector: jest.fn(),
}));
jest.mock("../../../utils/helpers/modelPricing", () => ({
  addChatCostToMetrics: jest.fn(() => ({})),
}));
jest.mock("../../../utils/helpers/abortSignals", () => ({
  abortConnectorOnClientDisconnect: jest.fn(),
}));
jest.mock("../../../utils/helpers/chat", () => ({
  fillSourceWindow: jest.fn(() => ({ contextTexts: [] })),
}));
jest.mock("../../../utils/helpers/chat/responses", () => ({
  convertToPromptHistory: jest.fn(() => []),
  writeResponseChunk: jest.fn(),
}));
jest.mock("../../../utils/chats", () => ({
  chatPrompt: jest.fn(async () => "Public prompt"),
  sourceIdentifier: jest.fn(),
}));
jest.mock("../../../utils/DocumentManager", () => ({
  DocumentManager: jest.fn(() => ({ pinnedDocs: jest.fn(async () => []) })),
}));
jest.mock("../../../models/embedChats", () => ({
  EmbedChats: {
    forEmbedByUser: jest.fn(async () => []),
    count: jest.fn(async () => 0),
    new: jest.fn(),
  },
}));

const { getVectorDbClass, resolveProviderConnector } = require("../../../utils/helpers");
const { chatPrompt } = require("../../../utils/chats");
const { streamChatWithForEmbed } = require("../../../utils/chats/embed");
const { EmbedChats } = require("../../../models/embedChats");

it("skips memories in both connector resolution and the final embed prompt", async () => {
  const connector = {
    promptWindowLimit: () => 1000,
    compressMessages: jest.fn(async (messages) => messages),
    streamingEnabled: () => false,
    getChatCompletion: jest.fn(async () => ({ textResponse: "hello", metrics: {} })),
  };
  resolveProviderConnector.mockResolvedValue({ connector });
  getVectorDbClass.mockReturnValue({
    hasNamespace: jest.fn(async () => false),
    namespaceCount: jest.fn(async () => 0),
  });
  const workspace = { id: 7, slug: "public", openAiTemp: 0.3 };
  await streamChatWithForEmbed({ locals: {} }, { id: 1, workspace }, "hello", "visitor", {
    username: "admin",
  });
  expect(resolveProviderConnector).toHaveBeenCalledWith(
    expect.objectContaining({ workspace, skipMemories: true })
  );
  expect(chatPrompt).toHaveBeenCalledWith(workspace, null, { skipMemories: true });
  expect(connector.getChatCompletion).toHaveBeenCalled();
  expect(EmbedChats.new).toHaveBeenCalledWith(
    expect.objectContaining({ connection_information: { username: "admin" } })
  );
});
