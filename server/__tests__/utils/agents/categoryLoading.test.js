jest.mock('../../../models/telemetry', () => ({ Telemetry: { sendTelemetry: jest.fn() } }));
const { createLoadedTools } = require('../../../utils/agents/aibitat/utils/loadedTools');
const AIbitat = require('../../../utils/agents/aibitat');
const { ToolReranker } = require('../../../utils/agents/aibitat/utils/toolReranker');

const owner = { workspaceId: 1, userId: 1, serverName: 'redball-store', generation: 1, resource: 'https://mcp.example/mcp' };
const revision = 'sha256:' + 'a'.repeat(64);
const definition = (category = 'catalog', suffix = 'products') => ({ name: `medusa_${category}_${suffix}`, description: 'Verified commerce action', inputSchema: { type: 'object', additionalProperties: false, properties: { action: { type: 'string', enum: ['get'] }, id: { type: 'string' } }, required: ['action', 'id'] } });
const envelope = (categories = ['catalog'], tools = [definition()]) => ({ kind: 'medusa_category_load', catalog_revision: revision, grant_id: 'grant-A', resource: owner.resource, categories, tools });
const wrapped = tool => ({ name: `${owner.serverName}-${tool.name}`, description: tool.description, parameters: tool.inputSchema, handler: jest.fn().mockResolvedValue('read result'), privateMcp: true });

afterEach(() => jest.restoreAllMocks());

test('load validates revision, category, name and resource before any state changes', () => {
  const state = createLoadedTools(owner);
  for (const patch of [{ kind: 'forged' }, { catalog_revision: 'invalid' }, { grant_id: undefined }, { grant_id: 123 }, { categories: ['inventory'] }, { resource: 'https://evil.example/mcp' }, { tools: [{ ...definition(), name: 'execute_code' }] }, { tools: [{ ...definition(), inputSchema: { type: 'string' } }] }]) {
    expect(() => state.applyLoad({ ...envelope(), ...patch }, ['catalog'], wrapped)).toThrow();
    expect(state.functions([])).toEqual([]);
  }
});

test('repeated loads are idempotent and new categories stay invocation-local', () => {
  const first = createLoadedTools(owner), second = createLoadedTools({ ...owner, userId: 2 });
  first.applyLoad(envelope(), ['catalog'], wrapped);
  first.applyLoad(envelope(), ['catalog'], wrapped);
  first.applyLoad(envelope(['inventory'], [definition('inventory', 'inventory')]), ['inventory'], wrapped);
  expect(first.functions([])).toHaveLength(2);
  expect(second.functions([])).toEqual([]);
  expect(() => first.applyLoad({ ...envelope(), grant_id: 'grant-B' }, ['catalog'], wrapped)).toThrow();
  expect(() => first.applyLoad({ ...envelope(), catalog_revision: 'sha256:' + 'b'.repeat(64) }, ['catalog'], wrapped)).toThrow();
});

test('tool and UTF-8 schema budgets fail atomically and reject collisions', () => {
  const state = createLoadedTools(owner);
  const tools = Array.from({ length: 24 }, (_, index) => definition('catalog', `products_${index}`));
  state.applyLoad(envelope(['catalog'], tools), ['catalog'], wrapped);
  expect(() => state.applyLoad(envelope(['inventory'], [definition('inventory')]), ['inventory'], wrapped)).toThrow(/limit/);
  expect(state.functions([])).toHaveLength(24);
  const large = definition(); large.inputSchema.properties.data = { type: 'string', enum: ['ก'.repeat(23000)] };
  expect(() => createLoadedTools(owner).applyLoad(envelope(['catalog'], [large]), ['catalog'], wrapped)).toThrow(/limit/);
  const collision = createLoadedTools(owner);
  expect(() => collision.applyLoad(envelope(), ['catalog'], wrapped, new Map([[`${owner.serverName}-${definition().name}`, {}]]))).toThrow(/collision/);
});

test('unadvertised execution tools cannot pass the agent boundary', () => {
  const state = createLoadedTools(owner);
  state.applyLoad(envelope(), ['catalog'], wrapped);
  expect(() => state.assertCallable(`${owner.serverName}-${definition().name}`, [])).toThrow(/advertised/);
  expect(() => state.assertCallable(`${owner.serverName}-${definition().name}`, state.functions([]))).not.toThrow();
});

for (const streaming of [false, true]) {
  test(`actual ${streaming ? 'streaming' : 'non-streaming'} loop receives loaded schemas in the next completion, including with reranking`, async () => {
    const agent = new AIbitat({ maxToolCalls: 4 });
    const state = createLoadedTools(owner); agent.categoryLoadedTools = state;
    const name = 'redball-store-load_tool_categories', executionName = `redball-store-${definition().name}`;
    const calls = [ { functionCall: { name, arguments: { categories: ['catalog'] } } }, { functionCall: { name: executionName, arguments: { action: 'get', id: 'prod_a' } } }, { textResponse: 'done' } ];
    const advertised = [];
    const providerCall = jest.fn(async (_, functions) => { advertised.push(functions.map(tool => tool.name)); return calls.shift(); });
    const provider = { complete: providerCall, stream: providerCall, supportsAgentStreaming: streaming, attachHandlerProps: jest.fn(), resetCumulativeUsage: jest.fn(), getCumulativeUsage: jest.fn(() => ({})) };
    Object.defineProperty(agent, 'providerInstance', { value: provider, writable: true });
    agent.handlerProps = { log: jest.fn(), invocation: {} };
    const loader = { name, handler: async args => { state.applyLoad(envelope(), args.categories, tool => { const fn = wrapped(tool); agent.function(fn); return fn; }); return 'loaded'; }, privateMcp: true };
    agent.function(loader); state.pinDiscovery([loader]);
    agent.getAgentConfig = jest.fn(() => ({ role: 'assistant', functions: [name] }));
    agent.getOrFormatNodeChatHistory = jest.fn(() => [{ role: 'user', content: 'ดูสินค้า' }]);
    agent.getProviderForConfig = jest.fn(() => provider); agent.newMessage = jest.fn();
    jest.spyOn(ToolReranker, 'isEnabled').mockReturnValue(true);
    jest.spyOn(ToolReranker.prototype, 'rerank').mockResolvedValue([]);
    expect(await agent.reply({ from: 'assistant', content: 'ดูสินค้า' })).toBe('done');
    expect(advertised[0]).toEqual([name]);
    expect(advertised[1]).toContain(executionName);
    expect(advertised[1]).toContain(name);
  });

  test(`actual ${streaming ? 'streaming' : 'non-streaming'} loop rejects unloaded calls and respects the consumed load turn`, async () => {
    const agent = new AIbitat({ maxToolCalls: 1 });
    const state = createLoadedTools(owner); agent.categoryLoadedTools = state;
    const execution = wrapped(definition()); agent.function(execution);
    const name = 'redball-store-load_tool_categories';
    const loader = { name, handler: jest.fn(async () => { state.applyLoad(envelope(), ['catalog'], wrapped); return 'loaded'; }), privateMcp: true };
    agent.function(loader); state.pinDiscovery([loader]);
    const calls = [ { functionCall: { name, arguments: { categories: ['catalog'] } } }, { functionCall: { name: execution.name, arguments: {} } } ];
    const providerCall = jest.fn(async () => calls.shift());
    Object.defineProperty(agent, 'providerInstance', { value: { complete: providerCall, stream: providerCall, resetCumulativeUsage: jest.fn() } });
    agent.handlerProps = { log: jest.fn(), invocation: {} };
    const run = streaming ? agent.handleAsyncExecution.bind(agent) : agent.handleExecution.bind(agent);
    await run([], [loader]);
    expect(loader.handler).toHaveBeenCalledTimes(1);
    expect(execution.handler).not.toHaveBeenCalled();
  });
}
