jest.mock("../../../../utils/helpers", () => ({
  getEmbeddingEngineSelection: () => ({}),
}));
const { AnthropicLLM } = require("../../../../utils/AiProviders/anthropic");

const originalEnv = process.env;
beforeEach(() => {
  process.env = { ...originalEnv, ANTHROPIC_API_KEY: "test-only-key" };
  jest.spyOn(AnthropicLLM, "fetchModelMaxTokens").mockResolvedValue(4096);
});
afterEach(() => {
  process.env = originalEnv;
  jest.restoreAllMocks();
});

it.each([
  [
    [
      { type: "thinking", thinking: "private reasoning", signature: "sig" },
      { type: "text", text: "Answer" },
    ],
    "Answer",
  ],
  [
    [
      { type: "text", text: "First" },
      { type: "text", text: " second" },
    ],
    "First second",
  ],
  [[{ type: "thinking", thinking: "private reasoning", signature: "sig" }], ""],
])(
  "returns only text blocks from an Anthropic completion",
  async (content, expected) => {
    const provider = new AnthropicLLM({});
    provider.assertModelMaxTokens = async () => {};
    provider.anthropic = {
      messages: {
        stream: () => ({
          finalMessage: async () => ({
            content,
            usage: { input_tokens: 4, output_tokens: 2 },
          }),
        }),
      },
    };
    const result = await provider.getChatCompletion(
      [
        { role: "system", content: "Be helpful" },
        { role: "user", content: "Hello" },
      ],
      {}
    );
    expect(result.textResponse).toBe(expected);
  }
);
