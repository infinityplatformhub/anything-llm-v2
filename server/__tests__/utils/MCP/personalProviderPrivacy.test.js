/* global jest */
require("../../utils/lark/_polyfill");
jest.mock("../../../utils/agents/aibitat/providers/helpers/tooled", () => ({
  tooledStream: jest.fn().mockRejectedValue(new Error("private-provider-echo")),
  tooledComplete: jest.fn(),
  maxTokensParam: () => ({}),
}));
const Generic = require("../../../utils/agents/aibitat/providers/genericOpenAi");
test("actual Generic OpenAI streaming catch does not log private echoed exception", async () => {
  process.env.GENERIC_OPEN_AI_API_KEY = "fixture";
  const provider = new Generic();
  provider.supportsNativeToolCalling = async () => true;
  provider.attachHandlerProps({ invocation: { personalMcpUsed: true } });
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  await expect(provider.stream([], [])).rejects.toThrow(
    "private-provider-echo"
  );
  expect(JSON.stringify(error.mock.calls)).not.toContain(
    "private-provider-echo"
  );
  error.mockRestore();
});
