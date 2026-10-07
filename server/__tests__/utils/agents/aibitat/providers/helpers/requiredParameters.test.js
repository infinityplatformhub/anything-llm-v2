process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();
jest.mock("../../../../../../utils/AiProviders/anthropic", () => ({
  AnthropicLLM: { fetchModelMaxTokens: jest.fn(async () => 1024) },
}));
jest.mock("@anthropic-ai/sdk", () => jest.fn(() => ({ messages: { create: jest.fn() } })));

const { tooledComplete } = require("../../../../../../utils/agents/aibitat/providers/helpers/tooled");
const { anthropicTooledComplete } = require("../../../../../../utils/agents/aibitat/providers/helpers/anthropicTooled");
const UnTooled = require("../../../../../../utils/agents/aibitat/providers/helpers/untooled");
const AnthropicProvider = require("../../../../../../utils/agents/aibitat/providers/anthropic");
const plugins = [
  [require("../../../../../../utils/agents/aibitat/plugins/rechart").rechart, ["type", "title", "dataset"]],
  [require("../../../../../../utils/agents/aibitat/plugins/generate-image").generateImage, ["prompt"]],
  [require("../../../../../../utils/agents/aibitat/plugins/sql-agent/get-table-schema").SqlAgentGetTableSchema, ["database_id", "table_name"]],
  [require("../../../../../../utils/agents/aibitat/plugins/sql-agent/list-table").SqlAgentListTables, ["database_id"]],
  [require("../../../../../../utils/agents/aibitat/plugins/sql-agent/query").SqlAgentQuery, ["database_id", "sql_query"]],
];

function register(plugin) {
  const definitions = [];
  plugin.plugin.call(plugin).setup({ function: (definition) => definitions.push(definition) });
  return definitions[0];
}

describe("bundled tool requirements on provider requests", () => {
  it.each(plugins)("forwards %s's complete required schema to OpenAI", async (plugin, required) => {
    const definition = register(plugin);
    const create = jest.fn(async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: null }));
    await tooledComplete({ chat: { completions: { create } } }, "model", [{ role: "user", content: "hello" }], [definition], () => 0, { provider: {} });
    const schema = create.mock.calls[0][0].tools[0].function.parameters;
    expect(schema.required).toEqual(required);
    for (const name of required) expect(schema.properties).toHaveProperty(name);
  });

  it("retains required fields through both Anthropic formatters and schema dereferencing", async () => {
    const definition = {
      name: "mcp-tool", description: "MCP tool",
      parameters: {
        type: "object", properties: { payload: { $ref: "#/$defs/Payload" } }, required: ["payload"],
        $defs: { Payload: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } },
      },
    };
    const response = { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: null };
    const create = jest.fn(async () => response);
    await anthropicTooledComplete({ messages: { create } }, "model", 1024, [{ role: "user", content: "hello" }], [definition]);
    const direct = new AnthropicProvider({ options: { apiKey: "test" } });
    direct.client.messages.create.mockResolvedValue(response);
    await direct.complete([{ role: "user", content: "hello" }], [definition]);
    for (const request of [create.mock.calls[0][0], direct.client.messages.create.mock.calls[0][0]]) {
      expect(request.tools[0].input_schema.required).toEqual(["payload"]);
      expect(request.tools[0].input_schema.properties.payload.required).toEqual(["value"]);
    }
  });

  it("detects a missing chart dataset on the untooled provider path", () => {
    const result = new UnTooled().validFuncCall(
      { name: "create-chart", arguments: { type: "bar", title: "Sales" } }, [register(plugins[0][0])]
    );
    expect(result).toEqual({ valid: false, reason: "Missing required argument: dataset" });
  });
});
