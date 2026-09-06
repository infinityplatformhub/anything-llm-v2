import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

async function request(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: baseHeaders(),
    ...(body && { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok || data.success === false || data.error)
    throw new Error(
      "Unable to update or load MCP connections. Please try again."
    );
  return data;
}

const WorkspaceMcp = {
  list: async (slug) => {
    const data = await request(`/workspace/${encodeURIComponent(slug)}/mcp`);
    if (!Array.isArray(data.connections))
      throw new Error(
        "Unable to load MCP connection status. Please try again."
      );
    return data.connections;
  },
  start: async (slug, serverName) => {
    const data = await request(
      `/mcp/oauth/start/${encodeURIComponent(slug)}/${encodeURIComponent(serverName)}`
    );
    const url = new URL(data.url);
    if (!["https:", "http:"].includes(url.protocol))
      throw new Error("Invalid MCP authorization URL.");
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
