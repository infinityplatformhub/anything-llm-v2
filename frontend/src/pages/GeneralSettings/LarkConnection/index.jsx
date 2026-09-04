import { useCallback, useEffect, useState } from "react";
import { isMobile } from "react-device-detect";
import { Warning } from "@phosphor-icons/react";
import Modal, {
  ModalBody,
  ModalDangerButton,
  ModalFooter,
  ModalHeader,
  ModalSecondaryButton,
} from "@/components/lib/Modal";
import { FullScreenLoader } from "@/components/Preloader";
import System from "@/models/system";
import showToast from "@/utils/toast";

const LARK_ERRORS = {
  tenant:
    "This Lark account belongs to a different company. Connect with your company account.",
  denied: "Lark authorization was cancelled. Try again when you are ready.",
  suspended: "Your AnythingLLM account is suspended. Contact an administrator.",
  link_conflict:
    "This Lark account is connected to another user. Sign in to that account or contact an administrator.",
  unknown: "Something went wrong while connecting Lark. Try again.",
};

const primaryButtonClass =
  "w-fit rounded-lg bg-primary-button px-4 py-2.5 text-sm font-semibold text-white hover:bg-primary-button-hover disabled:cursor-not-allowed disabled:opacity-50";

export default function LarkConnection() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const loadStatus = useCallback(async () => {
    const response = await System.larkStatus();
    setStatus(response);
    setLoading(false);
    if (!response)
      showToast("Could not load Lark connection status.", "error", {
        clear: true,
      });
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("lark") === "connected")
      showToast("Lark account connected.", "success", { clear: true });

    const errorMessage = LARK_ERRORS[params.get("lark_error")];
    if (errorMessage) showToast(errorMessage, "error", { clear: true });

    if (params.has("lark") || params.has("lark_error"))
      window.history.replaceState({}, document.title, window.location.pathname);

    loadStatus();
  }, [loadStatus]);

  async function connect() {
    setConnecting(true);
    const url = await System.larkConnectUrl();
    if (url) {
      window.location.href = url;
      return;
    }
    setConnecting(false);
    showToast("Could not start Lark connection.", "error", { clear: true });
  }

  async function disconnect() {
    setDisconnecting(true);
    const response = await System.disconnectLark();
    if (!response?.success) {
      setDisconnecting(false);
      showToast("Could not disconnect Lark.", "error", { clear: true });
      return;
    }

    setConfirmDisconnect(false);
    showToast(response.message || "Lark account disconnected.", "success", {
      clear: true,
    });
    await loadStatus();
    setDisconnecting(false);
  }

  if (loading) return <FullScreenLoader />;

  return (
    <div className="h-screen w-screen overflow-hidden bg-theme-bg-container p-4 md:p-8">
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="mx-auto h-full w-full max-w-[960px] overflow-y-auto rounded-2xl border-2 border-theme-sidebar-border bg-theme-bg-secondary p-5 md:p-10"
      >
        <div className="border-b-2 border-white/10 pb-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-theme-text-secondary">
            Connected account
          </p>
          <h1 className="mt-1 text-2xl font-bold text-theme-text-primary">
            Lark
          </h1>
          <p className="mt-2 text-sm text-theme-text-secondary">
            Connect your company account so agent actions can run as you.
          </p>
        </div>

        <div className="max-w-[700px] py-7">
          {!status?.enabled ? (
            <Notice title="Lark is unavailable">
              An administrator must enable Lark before you can connect.
            </Notice>
          ) : status.needsReauth ? (
            <>
              <div className="mb-5 flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-theme-text-primary">
                <Warning
                  className="mt-0.5 h-5 w-5 shrink-0 text-amber-400"
                  weight="fill"
                />
                <p>
                  <strong className="block">Reconnect required</strong>
                  <span className="text-theme-text-secondary">
                    Your Lark authorization expired or was revoked. Agent tools
                    cannot run until you reconnect.
                  </span>
                </p>
              </div>
              <button
                type="button"
                onClick={connect}
                disabled={connecting}
                className={primaryButtonClass}
              >
                {connecting ? "Redirecting..." : "Reconnect Lark"}
              </button>
            </>
          ) : status.connected ? (
            <ConnectedProfile
              profile={status.profile}
              onDisconnect={() => setConfirmDisconnect(true)}
            />
          ) : (
            <>
              <Notice title="Not connected">
                Connect Lark to let agent tools find contacts, work with docs,
                and send approved messages as you.
              </Notice>
              <button
                type="button"
                onClick={connect}
                disabled={connecting}
                className={primaryButtonClass}
              >
                {connecting ? "Redirecting..." : "Connect Lark"}
              </button>
            </>
          )}
        </div>
      </div>

      <Modal
        isOpen={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        size="sm"
      >
        <div className="flex flex-col gap-y-5">
          <ModalHeader
            title="Disconnect Lark?"
            onClose={() => setConfirmDisconnect(false)}
          />
          <ModalBody>
            <p className="text-sm leading-6 text-theme-text-secondary">
              Agent actions will stop working. Disconnecting here does not
              revoke access inside Lark.
            </p>
          </ModalBody>
          <ModalFooter>
            <ModalSecondaryButton
              type="button"
              disabled={disconnecting}
              onClick={() => setConfirmDisconnect(false)}
            >
              Cancel
            </ModalSecondaryButton>
            <ModalDangerButton
              type="button"
              disabled={disconnecting}
              onClick={disconnect}
            >
              {disconnecting ? "Disconnecting..." : "Disconnect"}
            </ModalDangerButton>
          </ModalFooter>
        </div>
      </Modal>
    </div>
  );
}

function Notice({ title, children }) {
  return (
    <div className="mb-5 rounded-lg border border-theme-sidebar-border bg-theme-bg-primary p-4 text-sm">
      <strong className="block text-theme-text-primary">{title}</strong>
      <span className="text-theme-text-secondary">{children}</span>
    </div>
  );
}

function ConnectedProfile({ profile, onDisconnect }) {
  const scopes = Array.isArray(profile?.scopes) ? profile.scopes : [];
  const connectedDate = profile?.connectedAt
    ? new Date(profile.connectedAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "Unknown";
  const initials =
    profile?.displayName
      ?.split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "L";

  return (
    <>
      <div className="mb-6 flex items-center gap-4">
        {profile?.avatarUrl ? (
          <img
            src={profile.avatarUrl}
            alt="Lark profile"
            className="h-12 w-12 rounded-full object-cover"
          />
        ) : (
          <div className="grid h-12 w-12 place-items-center rounded-full bg-sky-900 font-bold text-white">
            {initials}
          </div>
        )}
        <div className="min-w-0">
          <strong className="block truncate text-theme-text-primary">
            {profile?.displayName || "Lark user"}
          </strong>
          <span className="block truncate text-xs text-theme-text-secondary">
            {profile?.email || "No email provided"}
          </span>
        </div>
        <span className="ml-auto rounded-full border border-emerald-500/30 px-3 py-1 text-xs font-medium text-emerald-400">
          Connected
        </span>
      </div>

      <dl className="grid grid-cols-[minmax(100px,140px)_1fr] gap-x-4 gap-y-4 border-y border-theme-sidebar-border py-5 text-sm">
        <dt className="text-theme-text-secondary">Tenant</dt>
        <dd className="break-all text-theme-text-primary">
          {profile?.tenantKey || "Unknown"}
        </dd>
        <dt className="text-theme-text-secondary">Granted scopes</dt>
        <dd className="flex flex-wrap gap-2 text-theme-text-primary">
          {scopes.length
            ? scopes.map((scope) => (
                <span
                  key={scope}
                  className="rounded-md bg-theme-bg-primary px-2 py-1 text-xs"
                >
                  {scope}
                </span>
              ))
            : "None"}
        </dd>
        <dt className="text-theme-text-secondary">Connected</dt>
        <dd className="text-theme-text-primary">{connectedDate}</dd>
      </dl>

      <button
        type="button"
        onClick={onDisconnect}
        className="mt-6 rounded-lg border border-red-500/50 px-4 py-2.5 text-sm font-semibold text-red-400 hover:bg-red-500/10"
      >
        Disconnect
      </button>
      <p className="mt-3 text-xs text-theme-text-secondary">
        Disconnecting here does not revoke access inside Lark.
      </p>
    </>
  );
}
