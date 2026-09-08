const { validateHeaderName, validateHeaderValue } = require("http");
const { httpUrl } = require("./oauth");

// Bound workspace names because they become part of agent tool identifiers.
const MAX_SERVER_NAME_LENGTH = 64;
// Bound request metadata independently of the HTTP server's body limit.
const MAX_HEADER_KEYS = 20;
const MAX_HEADERS_BYTES = 4 * 1024;
const MASKED_SECRET = "••••••••";
const SECRET_HEADER = /token|key|secret|password|authorization|cookie/i;
const SERVER_NAME = new RegExp(
  `^[a-z0-9][a-z0-9_-]{1,${MAX_SERVER_NAME_LENGTH - 1}}$`
);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function allowFields(value, allowed, prefix = "") {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new Error(`unknown_field:${prefix}${key}`);
}

function validateWorkspaceServerName(name) {
  if (typeof name !== "string" || !SERVER_NAME.test(name))
    throw new Error("invalid_name");
  return name;
}

function validateWorkspaceServerConfig(config) {
  if (!isObject(config)) throw new Error("invalid_config");
  if (["command", "args", "env"].some((key) => Object.hasOwn(config, key)))
    throw new Error("stdio_not_supported");
  allowFields(config, ["url", "type", "headers", "anythingllm"]);
  try {
    if (typeof config.url !== "string") throw new Error();
    httpUrl(config.url);
  } catch {
    // URL parser exceptions may include credentials from the supplied URL.
    throw new Error("invalid_url");
  }
  if (
    Object.hasOwn(config, "type") &&
    !["sse", "http", "streamable"].includes(config.type)
  )
    throw new Error("invalid_type");
  if (Object.hasOwn(config, "headers")) {
    if (!isObject(config.headers)) throw new Error("invalid_headers");
    const entries = Object.entries(config.headers);
    if (entries.length > MAX_HEADER_KEYS) throw new Error("headers_too_large");
    for (const [key, value] of entries) {
      try {
        if (typeof value !== "string") throw new Error();
        validateHeaderName(key);
        validateHeaderValue(key, value);
      } catch {
        throw new Error("invalid_headers");
      }
    }
    if (
      Buffer.byteLength(JSON.stringify(config.headers), "utf8") >
      MAX_HEADERS_BYTES
    )
      throw new Error("headers_too_large");
  }
  if (Object.hasOwn(config, "anythingllm")) {
    const options = config.anythingllm;
    if (!isObject(options)) throw new Error("invalid_anythingllm");
    allowFields(
      options,
      ["perWorkspaceAuth", "suppressedTools"],
      "anythingllm."
    );
    if (
      Object.hasOwn(options, "perWorkspaceAuth") &&
      typeof options.perWorkspaceAuth !== "boolean"
    )
      throw new Error("invalid_anythingllm");
    if (
      Object.hasOwn(options, "suppressedTools") &&
      (!Array.isArray(options.suppressedTools) ||
        !options.suppressedTools.every((tool) => typeof tool === "string"))
    )
      throw new Error("invalid_anythingllm");
  }
  return config;
}

function maskConfig(config) {
  if (!config.headers) return { ...config };
  return {
    ...config,
    headers: Object.fromEntries(
      Object.entries(config.headers).map(([key, value]) => [
        key,
        SECRET_HEADER.test(key) ? MASKED_SECRET : value,
      ])
    ),
  };
}

function serverEndpointChanged(existing, incoming) {
  return existing.url !== incoming.url || existing.type !== incoming.type;
}

function mergeMaskedConfig(existing, incoming) {
  if (!isObject(incoming)) throw new Error("invalid_config");
  if (!Object.hasOwn(incoming, "headers")) return { ...incoming };
  if (!isObject(incoming.headers)) throw new Error("invalid_headers");
  return {
    ...incoming,
    headers: Object.fromEntries(
      Object.entries(incoming.headers).map(([key, value]) => {
        if (value !== MASKED_SECRET) return [key, value];
        if (
          serverEndpointChanged(existing, incoming) ||
          !existing.headers ||
          !Object.hasOwn(existing.headers, key)
        )
          throw new Error("invalid_masked_header");
        return [key, existing.headers[key]];
      })
    ),
  };
}

function parseMcpServersBlock(body) {
  if (!isObject(body)) throw new Error("invalid_mcp_servers");
  if (Object.hasOwn(body, "mcpServers")) {
    if (
      Object.keys(body).length !== 1 ||
      !isObject(body.mcpServers) ||
      !Object.keys(body.mcpServers).length
    )
      throw new Error("invalid_mcp_servers");
    // Validate each entry in the caller so a bad definition doesn't reject its siblings.
    return Object.entries(body.mcpServers).map(([name, config]) => ({
      name,
      config,
    }));
  }
  if (
    Object.keys(body).length !== 2 ||
    !Object.hasOwn(body, "name") ||
    !Object.hasOwn(body, "config")
  )
    throw new Error("invalid_mcp_servers");
  return [{ name: body.name, config: body.config }];
}

module.exports = {
  validateWorkspaceServerName,
  validateWorkspaceServerConfig,
  maskConfig,
  serverEndpointChanged,
  mergeMaskedConfig,
  parseMcpServersBlock,
  MASKED_SECRET,
};
