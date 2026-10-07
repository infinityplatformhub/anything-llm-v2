jest.mock("../../../utils/helpers", () => ({
  resolveProviderConnector: jest.fn(async () => ({ connector: {} })),
  getVectorDbClass: jest.fn(),
}));

const { memory } = require("../../../utils/agents/aibitat/plugins/memory");
const { getVectorDbClass } = require("../../../utils/helpers");

it.each([[0, 0], [0.75, 0.75], [null, 0.25], [undefined, 0.25]])(
  "agent document search forwards threshold %s as %s", async (similarityThreshold, expected) => {
    const search = jest.fn(async () => ({ contextTexts: ["context"], sources: [] }));
    getVectorDbClass.mockReturnValue({ performSimilaritySearch: search });
    let definition;
    memory.plugin.call(memory).setup({
      function: (value) => { definition = value; },
      handlerProps: { invocation: { workspace: { slug: "ws", similarityThreshold, topN: 6, vectorSearchMode: "rerank" } } },
      introspect: jest.fn(),
    });
    expect(await definition.search("question")).toContain("context");
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      namespace: "ws", input: "question", similarityThreshold: expected, topN: 6, rerank: true,
    }));
  }
);
