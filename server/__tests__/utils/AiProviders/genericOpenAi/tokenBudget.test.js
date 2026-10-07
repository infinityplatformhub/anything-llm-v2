const {
  GenericOpenAiLLM,
} = require("../../../../utils/AiProviders/genericOpenAi");
const GenericOpenAiProvider = require("../../../../utils/agents/aibitat/providers/genericOpenAi");
const {
  tooledComplete,
  tooledStream,
} = require("../../../../utils/agents/aibitat/providers/helpers/tooled");
const originalEnv = process.env;
beforeEach(() => {
  process.env = {
    ...originalEnv,
    GENERIC_OPEN_AI_BASE_PATH: "http://localhost:8080/v1",
    GENERIC_OPEN_AI_MODEL_PREF: "test-model",
  };
  delete process.env.GENERIC_OPEN_AI_MODEL_MAX_TOKEN_KEY;
});
afterEach(() => {
  process.env = originalEnv;
});
function client(streaming) {
  const bodies = [];
  return {
    bodies,
    chat: {
      completions: {
        create: async (body) => {
          bodies.push(body);
          if (streaming)
            return (async function* () {
              yield { choices: [{ delta: { content: "ok" } }] };
            })();
          return {
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        },
      },
    },
  };
}
describe("Generic OpenAI agent output budgets", () => {
  it.each(
    [true, false].flatMap((native) =>
      [true, false].flatMap((streaming) =>
        [0, 256].map((budget) => [native, streaming, budget])
      )
    )
  )("native=%s streaming=%s budget=%s", async (native, streaming, budget) => {
    process.env.GENERIC_OPEN_AI_MAX_TOKENS = String(budget);
    const provider = new GenericOpenAiProvider({ model: "test-model" });
    provider.supportsNativeToolCalling = async () => native;
    const backend = client(streaming);
    provider._client = backend;
    await provider[streaming ? "stream" : "complete"](
      [{ role: "user", content: "hi" }],
      []
    );
    expect(backend.bodies).toHaveLength(1);
    if (budget === 0)
      expect(backend.bodies[0]).not.toHaveProperty("max_tokens");
    else expect(backend.bodies[0].max_tokens).toBe(256);
  });
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])(
    "uses the configured token key on native=%s streaming=%s agent requests",
    async (native, streaming) => {
      process.env.GENERIC_OPEN_AI_MAX_TOKENS = "128";
      process.env.GENERIC_OPEN_AI_MODEL_MAX_TOKEN_KEY = "max_completion_tokens";
      const provider = new GenericOpenAiProvider({ model: "test-model" });
      provider.supportsNativeToolCalling = async () => native;
      const backend = client(streaming);
      provider._client = backend;
      await provider[streaming ? "stream" : "complete"](
        [{ role: "user", content: "hi" }],
        []
      );
      expect(backend.bodies[0]).not.toHaveProperty("max_tokens");
      expect(backend.bodies[0].max_completion_tokens).toBe(128);
    }
  );
});
it.each([0, 512])("chat completion honors budget=%s", async (budget) => {
  process.env.GENERIC_OPEN_AI_MAX_TOKENS = String(budget);
  const provider = new GenericOpenAiLLM();
  const backend = client(false);
  provider.openai = backend;
  await provider.getChatCompletion([], {});
  if (!budget) expect(backend.bodies[0]).not.toHaveProperty("max_tokens");
  else expect(backend.bodies[0].max_tokens).toBe(512);
});
it("chat completion honors the configured token field", async () => {
  process.env.GENERIC_OPEN_AI_MAX_TOKENS = "64";
  process.env.GENERIC_OPEN_AI_MODEL_MAX_TOKEN_KEY = "max_completion_tokens";
  const provider = new GenericOpenAiLLM();
  const backend = client(false);
  provider.openai = backend;
  await provider.getChatCompletion([], {});
  expect(backend.bodies[0]).not.toHaveProperty("max_tokens");
  expect(backend.bodies[0].max_completion_tokens).toBe(64);
});
it.each([0, 512])("streaming chat honors budget=%s", async (budget) => {
  process.env.GENERIC_OPEN_AI_MAX_TOKENS = String(budget);
  const provider = new GenericOpenAiLLM({});
  const backend = client(true);
  provider.openai = backend;
  const stream = await provider.streamGetChatCompletion(
    [{ role: "user", content: "hi" }],
    {}
  );
  for await (const chunk of stream)
    expect(chunk.choices[0].delta.content).toBe("ok");
  if (!budget) expect(backend.bodies[0]).not.toHaveProperty("max_tokens");
  else expect(backend.bodies[0].max_tokens).toBe(512);
});
it("streaming chat honors the configured token field", async () => {
  process.env.GENERIC_OPEN_AI_MAX_TOKENS = "64";
  process.env.GENERIC_OPEN_AI_MODEL_MAX_TOKEN_KEY = "max_completion_tokens";
  const provider = new GenericOpenAiLLM({});
  const backend = client(true);
  provider.openai = backend;
  const stream = await provider.streamGetChatCompletion(
    [{ role: "user", content: "hi" }],
    {}
  );
  for await (const chunk of stream)
    expect(chunk.choices[0].delta.content).toBe("ok");
  expect(backend.bodies[0]).not.toHaveProperty("max_tokens");
  expect(backend.bodies[0].max_completion_tokens).toBe(64);
});
it.each([undefined, null, -1, NaN, Infinity, "256", true])(
  "tooled helpers omit invalid or absent budgets: %s",
  async (budget) => {
    for (const streaming of [true, false]) {
      const backend = client(streaming);
      await (streaming
        ? tooledStream(backend, "test", [], [], null, { maxTokens: budget })
        : tooledComplete(backend, "test", [], [], () => 0, {
            maxTokens: budget,
          }));
      expect(backend.bodies[0]).not.toHaveProperty("max_tokens");
    }
  }
);
