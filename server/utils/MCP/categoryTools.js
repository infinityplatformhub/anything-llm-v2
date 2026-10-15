const {
  createLoadedTools,
  validateLoadEnvelope,
} = require("../agents/aibitat/utils/loadedTools");

function parseCategoryResponse(result, requestedCategories, resource) {
  if (result?.isError === true) throw new Error("category_load_failed");
  let value = result?.structuredContent;
  if (!value) {
    if (
      !Array.isArray(result?.content) ||
      result.content.length !== 1 ||
      result.content[0].type !== "text" ||
      typeof result.content[0].text !== "string" ||
      Buffer.byteLength(result.content[0].text, "utf8") > 131072
    )
      throw new Error("invalid_category_load_response");
    value = JSON.parse(result.content[0].text);
  }
  if (value?.kind === "medusa_category_load_limit") return null;
  return validateLoadEnvelope(value, requestedCategories, resource);
}

async function createCategoryRuntime({ runtime, workspace, name, identity }) {
  const target = await runtime.target(workspace, name, identity);
  if (
    name !== "redball-store" ||
    target.config.anythingllm.categoryLoading !== true
  )
    throw new Error("invalid_category_target");
  const owner = {
    workspaceId: workspace.id,
    userId: target.userId,
    serverName: name,
    generation: target.grant.generation,
    resource: target.config.url,
  };
  const agents = new WeakMap();
  return {
    attach(agent, fn) {
      if (!agents.has(agent)) {
        if (agent.categoryLoadedTools)
          throw new Error("category_owner_changed");
        const state = createLoadedTools(owner);
        agents.set(agent, state);
        agent.categoryLoadedTools = state;
      }
      agents.get(agent).pinDiscovery([fn]);
    },
    async call(agent, tool, args, binding, factory) {
      if (agent._aborted) throw new Error("category_load_aborted");
      const state = agents.get(agent);
      if (!state) throw new Error("category_owner_unavailable");
      if (binding)
        return runtime.callLoadedTool(
          workspace,
          name,
          { name: tool.name, arguments: args },
          identity,
          binding
        );
      if (tool.name !== "load_tool_categories")
        return runtime.call(
          workspace,
          name,
          { name: tool.name, arguments: args },
          identity
        );
      const loaded = await runtime.loadCategories(
        workspace,
        name,
        args,
        identity
      );
      if (agent._aborted) throw new Error("category_load_aborted");
      if (loaded.envelope) {
        const functions = state.applyLoad(
          loaded.envelope,
          args.categories,
          (definition) => factory(agent, definition, loaded.binding),
          agent.functions
        );
        for (const fn of functions) agent.function(fn);
      }
      return loaded.result;
    },
  };
}

module.exports = { createCategoryRuntime, parseCategoryResponse };
