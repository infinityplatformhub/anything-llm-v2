const categories = [
  "catalog",
  "inventory",
  "orders",
  "fulfillment",
  "customers",
  "pricing",
  "payments",
  "returns",
  "store_settings",
  "redball",
];
const validId = /^[A-Za-z0-9_-]{1,128}$/;
const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

function validateTree(value, depth = 0) {
  if (depth > 32) throw new Error("invalid_loaded_schema");
  if (Array.isArray(value)) {
    for (const child of value) validateTree(child, depth + 1);
    return;
  }
  if (plain(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (
        ["__proto__", "prototype", "constructor"].includes(key) ||
        (key === "$ref" &&
          (typeof child !== "string" || !child.startsWith("#/")))
      )
        throw new Error("invalid_loaded_schema");
      validateTree(child, depth + 1);
    }
    return;
  }
  if (value !== null && !["string", "number", "boolean"].includes(typeof value))
    throw new Error("invalid_loaded_schema");
}

function validateCategories(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 3 ||
    new Set(value).size !== value.length ||
    value.some((category) => !categories.includes(category))
  )
    throw new Error("invalid_loaded_categories");
}

function validateLoadEnvelope(input, requestedCategories, resource) {
  validateCategories(requestedCategories);
  if (
    !plain(input) ||
    input.kind !== "medusa_category_load" ||
    typeof input.catalog_revision !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(input.catalog_revision) ||
    typeof input.grant_id !== "string" ||
    !validId.test(input.grant_id) ||
    input.resource !== resource
  )
    throw new Error("invalid_category_load_envelope");
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "kind",
          "catalog_revision",
          "grant_id",
          "resource",
          "categories",
          "tools",
        ].includes(key)
    )
  )
    throw new Error("invalid_category_load_envelope");
  validateCategories(input.categories);
  if (
    [...input.categories].sort().join(",") !==
      [...requestedCategories].sort().join(",") ||
    !Array.isArray(input.tools)
  )
    throw new Error("invalid_category_load_envelope");
  if (
    input.tools.length > 24 ||
    Buffer.byteLength(JSON.stringify(input.tools), "utf8") > 65536
  )
    throw new Error("category_schema_limit");
  const names = new Set();
  for (const tool of input.tools) {
    if (
      !plain(tool) ||
      typeof tool.name !== "string" ||
      !/^[a-z][a-z0-9_]{0,127}$/.test(tool.name) ||
      !input.categories.some((category) =>
        tool.name.startsWith(`medusa_${category}_`)
      ) ||
      names.has(tool.name) ||
      typeof tool.description !== "string" ||
      tool.description.length > 4000 ||
      Object.keys(tool).some(
        (key) =>
          !["name", "description", "inputSchema", "annotations"].includes(key)
      )
    )
      throw new Error("invalid_loaded_tool");
    names.add(tool.name);
    const schema = tool.inputSchema;
    if (
      !plain(schema) ||
      schema.type !== "object" ||
      !plain(schema.properties) ||
      !Array.isArray(schema.required) ||
      schema.required.some(
        (key) =>
          typeof key !== "string" || !Object.hasOwn(schema.properties, key)
      )
    )
      throw new Error("invalid_loaded_schema");
    validateTree(schema);
  }
  return JSON.parse(JSON.stringify(input));
}

function createLoadedTools(context) {
  if (
    !Number.isInteger(context?.workspaceId) ||
    context.workspaceId < 1 ||
    !Number.isInteger(context.userId) ||
    context.userId < 1 ||
    context.serverName !== "redball-store" ||
    !Number.isInteger(context.generation) ||
    context.generation < 1 ||
    typeof context.resource !== "string"
  )
    throw new Error("invalid_category_owner");
  const serverName = context.serverName,
    resource = context.resource;
  const loaded = new Map(),
    discovery = new Map();
  let revision, grantId;
  return {
    pinDiscovery(functions) {
      for (const fn of functions) {
        if (
          ![
            `${serverName}-search_tools`,
            `${serverName}-load_tool_categories`,
          ].includes(fn.name)
        )
          throw new Error("invalid_discovery_tool");
        discovery.set(fn.name, fn);
      }
    },
    applyLoad(input, requestedCategories, factory, existing = new Map()) {
      const envelope = validateLoadEnvelope(
        input,
        requestedCategories,
        resource
      );
      if (
        (revision && revision !== envelope.catalog_revision) ||
        (grantId && grantId !== envelope.grant_id)
      )
        throw new Error("category_connection_changed");
      const next = new Map(loaded),
        additions = [];
      for (const tool of envelope.tools) {
        const name = `${serverName}-${tool.name}`,
          previous = next.get(name);
        if (
          previous &&
          JSON.stringify(previous.definition) !== JSON.stringify(tool)
        )
          throw new Error("category_definition_changed");
        if (existing.has(name) && !loaded.has(name))
          throw new Error("category_tool_collision");
        if (!previous) {
          next.set(name, { definition: tool });
          additions.push({ name, tool });
        }
      }
      if (
        next.size > 24 ||
        Buffer.byteLength(
          JSON.stringify([...next.values()].map((entry) => entry.definition)),
          "utf8"
        ) > 65536
      )
        throw new Error("category_schema_limit");
      const functions = additions.map(({ name, tool }) => ({
        name,
        fn: factory(tool),
      }));
      if (
        functions.some(
          ({ name, fn }) =>
            fn?.name !== name || typeof fn.handler !== "function"
        )
      )
        throw new Error("invalid_category_handler");
      for (const { name, fn } of functions) next.get(name).fn = fn;
      loaded.clear();
      for (const [name, entry] of next) loaded.set(name, entry);
      revision = envelope.catalog_revision;
      grantId = envelope.grant_id;
      return functions.map((entry) => entry.fn);
    },
    functions(base = []) {
      const output = new Map(
        (base || [])
          .filter((fn) => !fn.name.startsWith(`${serverName}-medusa_`))
          .map((fn) => [fn.name, fn])
      );
      for (const [name, fn] of discovery) output.set(name, fn);
      for (const [name, entry] of loaded) output.set(name, entry.fn);
      return [...output.values()];
    },
    assertCallable(name, advertised) {
      if (!(advertised || []).some((fn) => fn.name === name))
        throw new Error("category_tool_not_advertised");
    },
  };
}

module.exports = { createLoadedTools, validateLoadEnvelope };
