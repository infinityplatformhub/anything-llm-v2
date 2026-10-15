import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

// Protocol constants shared with the workspace server-config API.
export const MCP_SECRET_MASK = "••••••••";
export const MCP_SECRET_KEY = /token|key|secret|password|authorization|cookie/i;
export const MCP_NAME = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const CONFIG_KEYS = ["url", "type", "headers", "anythingllm"];
const STDIO_KEYS = ["command", "args", "env"];
const MAX_HEADERS = 20;
const MAX_HEADER_BYTES = 4096;
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function validateMcpConfig(config) {
  if (!isObject(config)) return "invalid_config";
  for (const key of Object.keys(config)) {
    if (STDIO_KEYS.includes(key)) return `stdio_not_supported:${key}`;
    if (!CONFIG_KEYS.includes(key)) return `unknown_field:${key}`;
  }
  try {
    if (typeof config.url !== "string") return "invalid_url";
    const url = new URL(config.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return "invalid_url";
  } catch {
    return "invalid_url";
  }
  if (
    config.type !== undefined &&
    !["sse", "http", "streamable"].includes(config.type)
  )
    return "invalid_type";
  if (config.headers !== undefined) {
    if (
      !isObject(config.headers) ||
      Object.entries(config.headers).some(
        ([key, value]) =>
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
          typeof value !== "string" ||
          // Update resolves sentinels before native HTTP header validation.
          (value !== MCP_SECRET_MASK && /[^\t\x20-\x7e\x80-\xff]/.test(value))
      )
    )
      return "invalid_headers";
    if (
      Object.keys(config.headers).length > MAX_HEADERS ||
      new TextEncoder().encode(JSON.stringify(config.headers)).length >
        MAX_HEADER_BYTES
    )
      return "headers_too_large";
  }
  if (config.anythingllm !== undefined) {
    if (!isObject(config.anythingllm)) return "invalid_anythingllm";
    for (const key of Object.keys(config.anythingllm))
      if (
        ![
          "perWorkspaceAuth",
          "perUserAuth",
          "personalAuth",
          "suppressedTools",
          "categoryLoading",
        ].includes(key)
      )
        return `unknown_field:anythingllm.${key}`;
    if (
      config.anythingllm.perWorkspaceAuth !== undefined &&
      typeof config.anythingllm.perWorkspaceAuth !== "boolean"
    )
      return "invalid_per_workspace_auth";
    if (
      (config.anythingllm.perUserAuth !== undefined &&
        typeof config.anythingllm.perUserAuth !== "boolean") ||
      (config.anythingllm.perUserAuth === true &&
        config.anythingllm.perWorkspaceAuth === true)
    )
      return "invalid_anythingllm";
    const descriptor = config.anythingllm.personalAuth;
    if (descriptor !== undefined) {
      if (
        config.anythingllm.perUserAuth !== true ||
        !isObject(descriptor) ||
        !["oauth", "apiKey"].includes(descriptor.type) ||
        Object.keys(descriptor).some(
          (key) =>
            ![
              "type",
              ...(descriptor.type === "apiKey" ? ["header"] : []),
            ].includes(key)
        ) ||
        (descriptor.type === "apiKey" &&
          (typeof descriptor.header !== "string" ||
            descriptor.header.toLowerCase() !== "x-api-key" ||
            Object.keys(config.headers || {}).some((key) =>
              MCP_SECRET_KEY.test(key)
            )))
      )
        return "invalid_personal_auth";
    }
    if (
      config.anythingllm.categoryLoading !== undefined &&
      (typeof config.anythingllm.categoryLoading !== "boolean" ||
        (config.anythingllm.categoryLoading === true &&
          config.anythingllm.perUserAuth !== true))
    )
      return "invalid_anythingllm";
    if (
      config.anythingllm.suppressedTools !== undefined &&
      (!Array.isArray(config.anythingllm.suppressedTools) ||
        config.anythingllm.suppressedTools.some(
          (tool) => typeof tool !== "string"
        ))
    )
      return "invalid_suppressed_tools";
  }
  return null;
}

export function parseMcpJson(text, name, editing = false) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: "invalid_json" };
  }
  if (!isObject(body)) return { error: "invalid_config" };
  let entries;
  if (Object.hasOwn(body, "mcpServers")) {
    const unknown = Object.keys(body).find((key) => key !== "mcpServers");
    if (unknown) return { error: `unknown_field:${unknown}` };
    if (!isObject(body.mcpServers) || !Object.keys(body.mcpServers).length)
      return { error: "invalid_body" };
    entries = Object.entries(body.mcpServers);
  } else entries = [[name, body]];
  if (editing && (entries.length !== 1 || entries[0][0] !== name))
    return { error: "edit_single_server" };
  for (const [entryName, config] of entries) {
    const error =
      validateMcpConfig(config) ||
      (!MCP_NAME.test(entryName) ? "invalid_name" : null);
    if (error) return { error, name: entryName };
  }
  return { entries };
}

export function mcpErrorMessage(t, error) {
  const code =
    typeof error === "string" ? error : error?.message || "request_failed";
  const [key, ...detail] = code.split(":");
  return t(`agent.mcp.errors.${key}`, {
    field: detail.join(":"),
    defaultValue: t("agent.mcp.errors.request_failed"),
  });
}

async function request(
  path,
  body,
  { method = body ? "POST" : "GET", signal } = {}
) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: baseHeaders(),
    signal,
    ...(body && { body: JSON.stringify(body) }),
  });
  if (response.status === 401 || response.status === 403)
    throw new Error("admin_required");
  const data = await response.json();
  if (!response.ok || data.success === false || data.error) {
    const error = new Error(data.error || "request_failed");
    error.errors = data.errors;
    throw error;
  }
  return data;
}

const serverPath = (slug, name) =>
  `/workspace/${encodeURIComponent(slug)}/mcp-servers${name ? `/${encodeURIComponent(name)}` : ""}`;
const WorkspaceMcp = {
  personal: async (slug) => {
    const data = await request(
      `/workspace/${encodeURIComponent(slug)}/mcp-personal`
    );
    if (!Array.isArray(data.servers)) throw new Error("request_failed");
    return data.servers;
  },
  apiKey: (slug, name, apiKey) =>
    request(
      `/workspace/${encodeURIComponent(slug)}/mcp-personal/${encodeURIComponent(name)}/api-key`,
      { apiKey }
    ),
  personalTools: (slug, name) =>
    request(
      `/workspace/${encodeURIComponent(slug)}/mcp-personal/${encodeURIComponent(name)}/tools`
    ),
  list: async (slug) => {
    const data = await request(`/workspace/${encodeURIComponent(slug)}/mcp`);
    if (!Array.isArray(data.connections)) throw new Error("request_failed");
    return data.connections;
  },
  servers: async (slug) => {
    const data = await request(serverPath(slug));
    if (!Array.isArray(data.servers)) throw new Error("request_failed");
    return data.servers;
  },
  create: (slug, body) => request(serverPath(slug), body),
  update: (slug, name, config) =>
    request(serverPath(slug, name), { config }, { method: "PUT" }),
  remove: (slug, name) =>
    request(serverPath(slug, name), undefined, { method: "DELETE" }),
  test: (slug, body, signal) =>
    request(`${serverPath(slug)}/test`, body, { signal }),
  call: (slug, name, toolName, args, signal) =>
    request(
      `${serverPath(slug, name)}/call`,
      { toolName, arguments: args },
      { signal }
    ),
  start: async (slug, serverName) => {
    const data = await request(
      `/mcp/oauth/start/${encodeURIComponent(slug)}/${encodeURIComponent(serverName)}`
    );
    const url = new URL(data.url);
    if (!["https:", "http:"].includes(url.protocol))
      throw new Error("invalid_url");
    return url.href;
  },
  toggle: (slug, serverName, enabled) =>
    request(`/workspace/${encodeURIComponent(slug)}/mcp/toggle`, {
      serverName,
      enabled,
    }),
  disconnect: (slug, serverName) =>
    request("/mcp/oauth/disconnect", { workspaceSlug: slug, serverName }),
};

export default WorkspaceMcp;
