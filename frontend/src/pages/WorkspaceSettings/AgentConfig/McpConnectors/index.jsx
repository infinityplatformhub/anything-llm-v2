import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import * as Skeleton from "react-loading-skeleton";
import Toggle from "@/components/lib/Toggle";
import MCPServers from "@/models/mcpServers";
import WorkspaceMcp from "@/models/workspaceMcp";
import paths from "@/utils/paths";
import showToast from "@/utils/toast";

const buttonClass =
  "rounded-lg border border-theme-modal-border px-4 py-2 text-sm font-semibold hover:bg-theme-bg-primary disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2";

export default function McpConnectors({ workspace, canManage }) {
  const [servers, setServers] = useState([]);
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null);
  const [oauthError, setOauthError] = useState(null);
  const [now, setNow] = useState(Date.now);
  const [searchParams, setSearchParams] = useSearchParams();
  const slug = workspace.slug;

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [catalog, status] = await Promise.all([
        MCPServers.listServers(canManage ? undefined : slug),
        WorkspaceMcp.list(slug),
      ]);
      if (!catalog.success || !Array.isArray(catalog.servers))
        throw new Error("Unable to load MCP connectors.");
      setServers(catalog.servers);
      setConnections(status);
    } catch {
      setError("Unable to load MCP connectors. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [slug, canManage]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setLoading(true);
    setServers([]);
    setConnections([]);
    setOauthError(null);
    refresh();
  }, [refresh]);

  useEffect(() => {
    const serverName = searchParams.get("mcp");
    if (!serverName) return;
    if (searchParams.has("error")) {
      setOauthError(serverName);
      showToast(
        "MCP connection failed. Reconnect and grant access to try again.",
        "error",
        { clear: true }
      );
    } else if (searchParams.get("connected") === "1") {
      showToast("MCP connector connected to this workspace.", "success", {
        clear: true,
      });
    } else return;
    refresh();
    const params = new URLSearchParams(searchParams);
    ["mcp", "connected", "error"].forEach((key) => params.delete(key));
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams, refresh]);

  const connect = async (serverName) => {
    if (!canManage || pending) return;
    setPending(serverName);
    try {
      const url = await WorkspaceMcp.start(slug, serverName);
      window.location.assign(url);
    } catch {
      setOauthError(serverName);
      showToast("Unable to start MCP connection. Please try again.", "error", {
        clear: true,
      });
      setPending(null);
    }
  };

  const update = async (serverName, enabled) => {
    if (!canManage || pending) return;
    setPending(serverName);
    try {
      if (enabled === undefined)
        await WorkspaceMcp.disconnect(slug, serverName);
      else await WorkspaceMcp.toggle(slug, serverName, enabled);
      await refresh();
    } catch {
      showToast("Unable to update MCP connection. Please try again.", "error", {
        clear: true,
      });
    } finally {
      setPending(null);
    }
  };

  return (
    <section
      className="mt-8 w-full max-w-3xl text-theme-text-primary"
      aria-label="MCP Connectors"
      aria-busy={loading}
    >
      <h2 className="text-sm font-bold uppercase tracking-widest">
        MCP Connectors
      </h2>
      <p className="mt-2 mb-4 text-sm text-theme-text-secondary">
        Choose which connectors this workspace can use. OAuth connections belong
        to this workspace only.
      </p>
      {loading ? (
        <Skeleton.default
          height={120}
          count={3}
          baseColor="var(--theme-bg-secondary)"
          highlightColor="var(--theme-bg-primary)"
          containerClassName="flex flex-col gap-4"
        />
      ) : error ? (
        <div
          role="alert"
          className="rounded-xl border border-theme-modal-border bg-theme-bg-secondary p-5"
        >
          <p>{error}</p>
          <button
            type="button"
            className={`${buttonClass} mt-3`}
            onClick={refresh}
          >
            Try again
          </button>
        </div>
      ) : servers.length === 0 ? (
        <div className="rounded-xl border border-theme-modal-border bg-theme-bg-secondary p-8 text-center">
          <h3 className="font-bold">No MCP servers configured</h3>
          <p className="mt-2 text-sm text-theme-text-secondary">
            Add MCP servers in Admin › Agents before enabling them for this
            workspace.
          </p>
          {canManage && (
            <a
              href={paths.settings.agentSkills()}
              className={`${buttonClass} mt-4 inline-block`}
            >
              Go to Admin › Agents
            </a>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {servers.map((server) => {
            const connection = connections.find(
              (item) => item.serverName === server.name
            );
            const oauth = server.config?.anythingllm?.perWorkspaceAuth === true;
            const expiry = connection?.expiresAt
              ? new Date(connection.expiresAt)
              : null;
            const needsReauth = connection?.needsReauth === true;
            const failed = oauth && (needsReauth || oauthError === server.name);
            const connected = connection?.connected === true;
            const remaining = expiry
              ? Math.max(0, Math.ceil((expiry.getTime() - now) / 1000))
              : null;
            return (
              <article
                key={server.name}
                className="rounded-xl border border-theme-modal-border bg-theme-bg-secondary p-5"
              >
                {failed && (
                  <div
                    role="alert"
                    className="mb-4 rounded-lg border border-theme-modal-border p-3 text-sm"
                  >
                    <strong>
                      {needsReauth ? "Connection expired" : "Connection failed"}
                    </strong>
                    <p className="mt-1 text-theme-text-secondary">
                      Reconnect and grant access to restore this workspace's
                      tools.
                    </p>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-bold break-all">{server.name}</h3>
                  <span className="rounded-full border border-theme-modal-border px-2 py-0.5 text-xs text-theme-text-secondary">
                    {oauth ? "OAuth · per workspace" : "Shared globally"}
                  </span>
                </div>
                {oauth ? (
                  <div className="mt-4 text-sm">
                    <p>
                      {connected ? "Connected" : "Not connected"}
                      {connected && connection.companyLabel && (
                        <>
                          {" "}
                          · <strong>{connection.companyLabel}</strong>
                        </>
                      )}
                    </p>
                    {connected &&
                      !needsReauth &&
                      Number.isFinite(remaining) && (
                        <p className="mt-1 text-xs text-theme-text-secondary">
                          {remaining > 0
                            ? `Access token expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")} — refresh is automatic.`
                            : "Waiting for automatic token refresh."}
                        </p>
                      )}
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      {connected && (
                        <button
                          type="button"
                          className={buttonClass}
                          disabled={!canManage || !!pending}
                          onClick={() => update(server.name)}
                        >
                          {pending === server.name ? "Updating…" : "Disconnect"}
                        </button>
                      )}
                      {(!connected || failed) && (
                        <button
                          type="button"
                          className={`${buttonClass} bg-primary-button text-theme-button-text`}
                          disabled={!canManage || !!pending}
                          onClick={() => connect(server.name)}
                        >
                          {failed ? "Reconnect" : "Connect"} {server.name}
                        </button>
                      )}
                      <span className="text-xs text-theme-text-secondary">
                        Workspace: {workspace.name || slug}
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-theme-text-secondary">
                    Uses this instance's shared credentials. Enabling grants
                    this workspace access to its tools.
                  </p>
                )}
                <div className="mt-4 border-t border-theme-modal-border pt-4">
                  <Toggle
                    size="lg"
                    variant="horizontal"
                    label={`Enable ${server.name} in this workspace`}
                    description={
                      oauth
                        ? "Connect first, then enable to make tools available to this workspace's agent."
                        : undefined
                    }
                    enabled={connection?.enabled === true}
                    disabled={
                      !canManage ||
                      !!pending ||
                      (oauth && (!connected || failed))
                    }
                    onChange={(enabled) => update(server.name, enabled)}
                  />
                </div>
              </article>
            );
          })}
        </div>
      )}
      {!canManage && (
        <p className="mt-4 rounded-xl border border-theme-modal-border p-4 text-sm text-theme-text-secondary">
          Read-only view. Only administrators can connect, disconnect, or enable
          MCP connectors.
        </p>
      )}
    </section>
  );
}
