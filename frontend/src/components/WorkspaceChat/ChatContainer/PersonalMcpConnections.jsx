import { useEffect, useState } from "react";
import WorkspaceMcp from "@/models/workspaceMcp";
import Workspace from "@/models/workspace";
import Modal, { ModalHeader, ModalBody } from "@/components/lib/Modal";

function ApiKeyConnection({ server, busy, onSave, onDisconnect }) {
  const [apiKey, setApiKey] = useState("");
  const [editing, setEditing] = useState(!server.connected);
  async function save(event) {
    event.preventDefault();
    if (busy || !apiKey.trim()) return;
    if (await onSave(apiKey)) {
      setApiKey("");
      setEditing(false);
    }
  }
  function cancel() {
    setApiKey("");
    setEditing(false);
  }
  async function disconnect() {
    if (await onDisconnect()) cancel();
  }
  return (
    <div className="flex flex-col gap-2">
      {editing || !server.connected ? (
        <form
          onSubmit={save}
          aria-label={`${server.name} API key`}
          className="flex flex-wrap gap-2"
        >
          <label className="flex flex-col gap-1">
            Your API key for {server.name}
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
              disabled={busy}
              className="rounded px-2 py-1 bg-transparent border"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !apiKey.trim()}
            className="rounded px-3 py-1 bg-blue-600 disabled:opacity-50"
          >
            {busy
              ? "Working…"
              : server.connected
                ? "Save key"
                : "Save and connect"}
          </button>
          {server.connected && (
            <button type="button" disabled={busy} onClick={cancel}>
              Cancel
            </button>
          )}
        </form>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => setEditing(true)}
          className="rounded px-3 py-1 bg-blue-600 disabled:opacity-50"
        >
          Replace key
        </button>
      )}
      {server.connected && (
        <button
          type="button"
          disabled={busy}
          onClick={disconnect}
          className="rounded px-3 py-1 bg-blue-600 disabled:opacity-50"
        >
          Disconnect
        </button>
      )}
    </div>
  );
}

export default function PersonalMcpConnections({ workspaceSlug, onClose }) {
  const [workspaces, setWorkspaces] = useState([]);
  const [selectedSlug, setSelectedSlug] = useState("");
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(!workspaceSlug);
  useEffect(() => {
    if (workspaceSlug) return;
    let alive = true;
    setLoadingWorkspaces(true);
    Workspace.all().then((rows) => {
      if (!alive) return;
      setWorkspaces(rows);
      setSelectedSlug(rows[0]?.slug || "");
      setLoadingWorkspaces(false);
    });
    return () => {
      alive = false;
    };
  }, [workspaceSlug]);
  const activeSlug = workspaceSlug || selectedSlug;
  return (
    <Modal isOpen={true} onClose={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="My MCP connections"
        className="text-sm text-white light:text-slate-900"
      >
        <ModalHeader title="My MCP connections" onClose={onClose} />
        <ModalBody className="mt-4">
          <p className="mt-2 text-xs">
            Only your account is connected. Personal tool replies are not saved
            in shared history.
          </p>
          {!workspaceSlug &&
            (loadingWorkspaces ? (
              <p role="status">Loading workspaces…</p>
            ) : !workspaces.length ? (
              <p>No workspaces are available for your account.</p>
            ) : (
              <label className="mt-3 flex flex-col gap-1">
                Workspace
                <select
                  value={selectedSlug}
                  onChange={(event) => setSelectedSlug(event.target.value)}
                  className="rounded border border-theme-modal-border bg-theme-bg-primary px-2 py-1"
                >
                  {workspaces.map((workspace) => (
                    <option key={workspace.slug} value={workspace.slug}>
                      {workspace.name || workspace.slug}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          {activeSlug && (
            <WorkspaceConnections key={activeSlug} workspaceSlug={activeSlug} />
          )}
        </ModalBody>
      </div>
    </Modal>
  );
}

function WorkspaceConnections({ workspaceSlug }) {
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let alive = true;
    WorkspaceMcp.personal(workspaceSlug)
      .then((rows) => {
        if (alive) setServers(rows);
      })
      .catch(() => {
        if (alive) setError(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [workspaceSlug]);
  async function action(server, connect, apiKey) {
    if (busy) return false;
    setBusy(server.name);
    setMessage("");
    try {
      if (apiKey !== undefined) {
        await WorkspaceMcp.apiKey(workspaceSlug, server.name, apiKey);
        try {
          setServers(await WorkspaceMcp.personal(workspaceSlug));
        } catch {
          setServers((rows) =>
            rows.map((row) =>
              row.name === server.name
                ? { ...row, connected: true, needsReauth: false }
                : row
            )
          );
        }
        setMessage("Connected with your API key.");
      } else if (connect) {
        const url = await WorkspaceMcp.start(workspaceSlug, server.name);
        window.location.assign(url);
      } else {
        const result = await WorkspaceMcp.disconnect(
          workspaceSlug,
          server.name
        );
        setServers(await WorkspaceMcp.personal(workspaceSlug));
        if (server.authType !== "apiKey" && !result.remoteRevoked)
          setMessage(
            "Disconnected locally. Remote revocation could not be confirmed."
          );
      }
      return true;
    } catch {
      setMessage(
        "Connection unavailable. Try again or contact your workspace administrator."
      );
      return false;
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      {loading ? (
        <p role="status">Loading connections…</p>
      ) : error ? (
        <p role="alert">
          Connection unavailable. Try again or contact your workspace
          administrator.
        </p>
      ) : !servers.length ? (
        <p>No personal MCP connections are available in this workspace.</p>
      ) : (
        servers.map((server) => (
          <div
            key={`${workspaceSlug}:${server.name}`}
            className="flex gap-3 items-center justify-between mt-3"
          >
            <span>
              {server.name}:{" "}
              {server.connected
                ? "Connected"
                : server.needsReauth
                  ? "Reconnect required"
                  : "Not connected"}
              {server.connected && server.accountLabel && (
                <span className="block text-xs">{server.accountLabel}</span>
              )}
            </span>
            {server.authType === "apiKey" ? (
              <ApiKeyConnection
                server={server}
                busy={!!busy}
                onSave={(apiKey) => action(server, true, apiKey)}
                onDisconnect={() => action(server, false)}
              />
            ) : (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => action(server, !server.connected)}
                className="rounded px-3 py-1 bg-blue-600 disabled:opacity-50"
              >
                {busy === server.name
                  ? "Working…"
                  : server.connected
                    ? "Disconnect"
                    : "Connect"}
              </button>
            )}
          </div>
        ))
      )}
      {message && (
        <p role="status" className="mt-3 text-xs">
          {message}
        </p>
      )}
    </>
  );
}
