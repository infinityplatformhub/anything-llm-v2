const { PersonalMcpRuntime } = require('../../../utils/MCP/personalRuntime');
const { createCategoryRuntime, parseCategoryResponse } = require('../../../utils/MCP/categoryTools');
const { validateWorkspaceServerConfig } = require('../../../utils/MCP/serverConfig');

const resource = 'https://medusa.example/mcp';
const revision = `sha256:${'a'.repeat(64)}`;
const definition = { name: 'medusa_catalog_products', description: 'Products', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['get'] } }, required: ['action'] } };
const envelope = { kind: 'medusa_category_load', resource, grant_id: 'grant_A', catalog_revision: revision, categories: ['catalog'], tools: [definition] };
const result = { content: [{ type: 'text', text: JSON.stringify(envelope) }] };

function fixture() {
  const runtime = new PersonalMcpRuntime({});
  const workspace = { id: 1 }, identity = {};
  const current = { userId: 1, config: { url: resource, type: 'http', anythingllm: { perUserAuth: true, categoryLoading: true } }, grant: { generation: 1, version: 1 } };
  runtime.target = jest.fn().mockImplementation(async () => current);
  runtime.call = jest.fn().mockResolvedValue(result);
  runtime.boot = jest.fn().mockResolvedValue();
  const client = { callTool: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'private result' }] }) };
  runtime.clients.set(runtime.key(workspace, 1, 'redball-store'), { version: 1, client });
  return { runtime, workspace, identity, current, client };
}

test('category opt-in is a validated boolean requiring personal authentication', () => {
  const config = fixture().current.config;
  expect(validateWorkspaceServerConfig(config)).toEqual(config);
  for (const options of [{ categoryLoading: 'true', perUserAuth: true }, { categoryLoading: true }, { categoryLoading: true, perWorkspaceAuth: true }]) {
    expect(() => validateWorkspaceServerConfig({ ...config, anythingllm: options })).toThrow();
  }
});

test('only the opaque authenticated binding dispatches loaded tools with pinned metadata', async () => {
  const { runtime, workspace, identity, client } = fixture();
  const loaded = await runtime.loadCategories(workspace, 'redball-store', { categories: ['catalog'] }, identity);
  const request = { name: definition.name, arguments: { action: 'get' }, _meta: { 'medusa/catalog_revision': 'forged' } };
  await expect(runtime.callLoadedTool(workspace, 'redball-store', request, identity, {})).rejects.toThrow(/not_allowed/);
  expect(client.callTool).not.toHaveBeenCalled();
  await runtime.callLoadedTool(workspace, 'redball-store', request, identity, loaded.binding);
  expect(client.callTool).toHaveBeenCalledWith({ name: definition.name, arguments: request.arguments, _meta: { 'medusa/catalog_revision': revision } });
});

test.each(['user', 'workspace', 'generation', 'config', 'suppression', 'revocation'])('%s changes prevent loaded execution without a replay', async change => {
  const { runtime, workspace, identity, client, current } = fixture();
  const loaded = await runtime.loadCategories(workspace, 'redball-store', { categories: ['catalog'] }, identity);
  if (change === 'user') current.userId = 2;
  if (change === 'workspace') workspace.id = 2;
  if (change === 'generation') current.grant = { ...current.grant, generation: 2 };
  if (change === 'config') current.config = { ...current.config, url: 'https://other.example/mcp' };
  if (change === 'suppression') current.config.anythingllm.suppressedTools = [definition.name];
  if (change === 'revocation') runtime.target.mockRejectedValue(new Error('MCP authentication required'));
  await expect(runtime.callLoadedTool(workspace, 'redball-store', { name: definition.name }, identity, loaded.binding)).rejects.toThrow();
  expect(client.callTool).not.toHaveBeenCalled();
});

test('a reconnect during boot cannot dispatch using an earlier category binding', async () => {
  const { runtime, workspace, identity, client, current } = fixture();
  const loaded = await runtime.loadCategories(workspace, 'redball-store', { categories: ['catalog'] }, identity);
  runtime.boot.mockImplementation(async () => { current.grant = { ...current.grant, generation: 2 }; });
  await expect(runtime.callLoadedTool(workspace, 'redball-store', { name: definition.name }, identity, loaded.binding)).rejects.toThrow();
  expect(client.callTool).not.toHaveBeenCalled();
});

test('malformed, error and untrusted content cannot register execution tools', () => {
  for (const response of [{ isError: true, structuredContent: envelope }, { content: [{ type: 'text', text: '{}' }] }, { structuredContent: { ...envelope, resource: 'https://evil.example/mcp' } }, { content: [{ type: 'image', data: 'invalid' }] }]) {
    expect(() => parseCategoryResponse(response, ['catalog'], resource)).toThrow();
  }
});

test('abort while authenticated load is awaiting prevents all registration', async () => {
  const { runtime, workspace, identity } = fixture();
  const categories = await createCategoryRuntime({ runtime, workspace, identity, name: 'redball-store' });
  const agent = { functions: new Map(), function: jest.fn(), _aborted: false };
  categories.attach(agent, { name: 'redball-store-load_tool_categories' });
  runtime.loadCategories = jest.fn(async () => { agent._aborted = true; return { result, envelope, binding: {} }; });
  await expect(categories.call(agent, { name: 'load_tool_categories' }, { categories: ['catalog'] }, null, jest.fn())).rejects.toThrow(/aborted/);
  expect(agent.function).not.toHaveBeenCalled();
  expect(agent.categoryLoadedTools.functions([])).toHaveLength(1);
});
