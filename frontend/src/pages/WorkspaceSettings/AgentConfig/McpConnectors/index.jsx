import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import * as Skeleton from "react-loading-skeleton";
import Toggle from "@/components/lib/Toggle";
import { useTranslation } from "react-i18next";
import Modal, {
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalSecondaryButton,
  ModalDangerButton,
} from "@/components/lib/Modal";
import WorkspaceMcp, { mcpErrorMessage } from "@/models/workspaceMcp";
import ServerModal from "./ServerModal";
import ToolTester from "./ToolTester";
import paths from "@/utils/paths";
import showToast from "@/utils/toast";

const buttonClass =
  "rounded-lg border border-theme-modal-border px-4 py-2 text-sm font-semibold hover:bg-theme-bg-primary disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2";

export default function McpConnectors({ workspace, canManage }) {
  const { t } = useTranslation();
  const [modal, setModal] = useState(null);
  const [menu, setMenu] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
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
    setOauthError(null);
    try {
      const [catalog, status] = await Promise.all([
        WorkspaceMcp.servers(slug),
        WorkspaceMcp.list(slug),
      ]);
      setServers(catalog);
      setConnections(status);
    } catch {
      setError("Unable to load MCP connectors. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [slug, canManage]);

  const hasExpiry = connections.some((connection) => connection.expiresAt);
  useEffect(() => {
    if (!hasExpiry) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasExpiry]);

  useEffect(() => {
    setLoading(true);
    setServers([]);
    setConnections([]);
    if (!searchParams.has("mcp")) refresh();
  }, [refresh]);

  useEffect(() => {
    if (!searchParams.has("mcp")) return;
    const serverName = searchParams.get("mcp");
    refresh();
    if (searchParams.has("error")) {
      setOauthError(serverName);
      const messages = {
        access_denied:
          "Access was denied at the provider. Reconnect and grant access.",
        authorization_failed:
          "The provider rejected the authorization. Try again.",
        oauth_callback_failed: "Token exchange failed. Reconnect to try again.",
      };
      const code = searchParams.get("error");
      showToast(
        Object.hasOwn(messages, code)
          ? messages[code]
          : "MCP connection failed. Reconnect and grant access to try again.",
        "error",
        { clear: true }
      );
    } else if (searchParams.get("connected") === "1") {
      showToast("MCP connector connected to this workspace.", "success", {
        clear: true,
      });
    }
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
    } finally {
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

  useEffect(() => {
    setModal(null);
    setMenu(null);
  }, [slug, canManage]);

  const remove = async () => {
    if (!canManage || pending || modal?.action !== "delete") return;
    setPending(modal.server.name);
    setDeleteError(null);
    try {
      await WorkspaceMcp.remove(slug, modal.server.name);
      setModal(null);
      showToast(t("agent.mcp.deleted"), "success");
      await refresh();
    } catch (error) {
      setDeleteError(mcpErrorMessage(t, error));
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-bold uppercase tracking-widest">
          MCP Connectors
        </h2>
        {canManage && (
          <button
            type="button"
            className={`${buttonClass} bg-primary-button text-theme-button-text`}
            onClick={() => setModal({ action: "add" })}
          >
            {t("agent.mcp.add")}
          </button>
        )}
      </div>
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
          <h3 className="font-bold">{t("agent.mcp.empty-title")}</h3>
          <p className="mt-2 text-sm text-theme-text-secondary">
            {t("agent.mcp.empty-description")}
          </p>
          {canManage && (
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button
                type="button"
                className={`${buttonClass} bg-primary-button text-theme-button-text`}
                onClick={() => setModal({ action: "add" })}
              >
                {t("agent.mcp.add")}
              </button>
              <a href={paths.settings.agentSkills()} className={buttonClass}>
                {t("agent.mcp.shared-catalog")}
              </a>
            </div>
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
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs ${server.owner === "workspace" ? "border-primary-button text-primary-button" : "border-theme-modal-border text-theme-text-secondary"}`}
                  >
                    {t(
                      server.owner === "workspace"
                        ? "agent.mcp.workspace-owned"
                        : "agent.mcp.shared-globally"
                    )}
                  </span>
                  {oauth && (
                    <span className="rounded-full border border-theme-modal-border px-2 py-0.5 text-xs text-theme-text-secondary">
                      OAuth · per workspace
                    </span>
                  )}
                  {canManage && server.owner === "workspace" ? (
                    <div
                      className="relative ml-auto"
                      onBlur={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget))
                          setMenu(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setMenu(null);
                      }}
                    >
                      <button
                        type="button"
                        className={buttonClass}
                        aria-label={t("agent.mcp.manage-server", {
                          name: server.name,
                        })}
                        aria-expanded={menu === server.name}
                        aria-haspopup="menu"
                        onClick={() =>
                          setMenu(menu === server.name ? null : server.name)
                        }
                      >
                        {t("agent.mcp.manage")}
                      </button>
                      {menu === server.name && (
                        <div
                          role="menu"
                          aria-label={t("agent.mcp.manage-server", {
                            name: server.name,
                          })}
                          className="absolute right-0 z-10 mt-1 min-w-40 rounded-lg border border-theme-modal-border bg-theme-bg-secondary p-1 shadow-lg"
                        >
                          {["edit", "test", "delete"].map((action) => (
                            <button
                              key={action}
                              type="button"
                              role="menuitem"
                              className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-theme-bg-primary"
                              onClick={() => {
                                setMenu(null);
                                setDeleteError(null);
                                setModal({ action, server });
                              }}
                            >
                              {t(
                                `agent.mcp.${action === "test" ? "test-tools" : action}`
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    canManage &&
                    server.enabled && (
                      <button
                        type="button"
                        className={`${buttonClass} ml-auto`}
                        onClick={() => setModal({ action: "test", server })}
                      >
                        {t("agent.mcp.test-tools")}
                      </button>
                    )
                  )}
                </div>
                {server.config?.url && (
                  <p className="mt-2 break-all font-mono text-xs text-theme-text-secondary">
                    {server.config.url} ·{" "}
                    {server.config.type === "http" ||
                    server.config.type === "streamable"
                      ? "Streamable HTTP"
                      : "SSE"}
                  </p>
                )}
                {Object.entries(server.config?.headers || {}).length > 0 && (
                  <dl className="mt-2 text-xs text-theme-text-secondary">
                    {Object.entries(server.config.headers).map(
                      ([key, value]) => (
                        <div
                          key={key}
                          className="flex flex-wrap gap-1 break-all font-mono"
                        >
                          <dt>{key}:</dt>
                          <dd>{value}</dd>
                        </div>
                      )
                    )}
                  </dl>
                )}
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
                      {canManage && connected && (
                        <button
                          type="button"
                          className={buttonClass}
                          disabled={!canManage || !!pending}
                          onClick={() => update(server.name)}
                        >
                          {pending === server.name ? "Updating…" : "Disconnect"}
                        </button>
                      )}
                      {canManage && (!connected || failed) && (
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
                    {t(
                      server.owner === "workspace"
                        ? "agent.mcp.workspace-credentials"
                        : "agent.mcp.shared-credentials"
                    )}
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
                      (oauth && !connected && connection?.enabled !== true)
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
          {t("agent.mcp.read-only")}
        </p>
      )}
      {canManage && ["add", "edit"].includes(modal?.action) && (
        <ServerModal
          key={`${slug}-${modal.server?.name || "new"}`}
          slug={slug}
          server={modal.server}
          onClose={() => setModal(null)}
          onSaved={refresh}
        />
      )}
      {canManage && modal?.action === "test" && (
        <ToolTester
          slug={slug}
          server={modal.server}
          onClose={() => setModal(null)}
        />
      )}
      {canManage && modal?.action === "delete" && (
        <Modal
          isOpen
          onClose={() => {
            if (!pending) setModal(null);
          }}
          size="sm"
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label={t("agent.mcp.delete-title", {
              name: modal.server.name,
            })}
            className="flex flex-col gap-4 text-theme-text-primary"
          >
            <ModalHeader
              title={t("agent.mcp.delete-title", { name: modal.server.name })}
            />
            <ModalBody>
              <p className="text-sm text-theme-text-secondary">
                {t("agent.mcp.delete-warning", {
                  workspace: workspace.name || slug,
                })}
              </p>
              {deleteError && (
                <p role="alert" className="text-sm text-red-400">
                  {deleteError}
                </p>
              )}
            </ModalBody>
            <ModalFooter>
              <ModalSecondaryButton
                type="button"
                disabled={!!pending}
                onClick={() => setModal(null)}
              >
                {t("agent.mcp.cancel")}
              </ModalSecondaryButton>
              <ModalDangerButton
                type="button"
                disabled={!!pending}
                onClick={remove}
              >
                {t("agent.mcp.confirm-delete")}
              </ModalDangerButton>
            </ModalFooter>
          </div>
        </Modal>
      )}
    </section>
  );
}
