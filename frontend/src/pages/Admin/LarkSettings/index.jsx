import { useEffect, useState } from "react";
import { isMobile } from "react-device-detect";
import { Copy, Plus, X } from "@phosphor-icons/react";
import Sidebar from "@/components/SettingsSidebar";
import Toggle from "@/components/lib/Toggle";
import { FullScreenLoader } from "@/components/Preloader";
import Admin from "@/models/admin";
import showToast from "@/utils/toast";

const MASKED_SECRET = "********";
const DEFAULT_SCOPES =
  "offline_access contact:user.email:readonly im:message im:message.send_as_user im:chat:readonly docx:document wiki:wiki calendar:calendar contact:user.base:readonly";
const DEFAULT_ALLOWLIST = ["im", "docs", "docx", "wiki", "calendar", "contact"];
const DENIED_COMMANDS = ["auth", "config", "profile", "logout", "api"];
const inputClass =
  "w-full px-3 py-2.5 bg-theme-bg-primary border border-theme-sidebar-border rounded-lg text-theme-text-primary text-sm placeholder:text-theme-text-secondary/50 outline-none focus:border-primary-button";
const secondaryButtonClass =
  "px-4 py-2.5 rounded-lg border border-theme-sidebar-border text-sm font-medium text-theme-text-primary hover:bg-theme-action-menu-item-hover disabled:cursor-not-allowed disabled:opacity-50";

const normalizeScopes = (value) =>
  value.trim().split(/\s+/).filter(Boolean).join(" ");
const normalizeAllowlist = (entries) => [
  ...new Set(
    entries
      .filter((entry) => typeof entry === "string")
      .map((entry) => entry.trim().toLowerCase())
      .filter(
        (entry) =>
          /^[a-z0-9-]+$/.test(entry) && !DENIED_COMMANDS.includes(entry)
      )
  ),
];

export default function LarkSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [hasExistingSecret, setHasExistingSecret] = useState(false);
  const [secretEditing, setSecretEditing] = useState(false);
  const [tenantKey, setTenantKey] = useState("");
  const [scopes, setScopes] = useState(DEFAULT_SCOPES);
  const [allowlist, setAllowlist] = useState(DEFAULT_ALLOWLIST);
  const [allowlistEntry, setAllowlistEntry] = useState("");
  const [redirectUri, setRedirectUri] = useState(
    `${window.location.origin}/api/lark/auth/callback`
  );
  const [errors, setErrors] = useState({});
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    async function loadSettings() {
      const response = await Admin.larkSettings();
      if (!response?.settings) {
        showToast("Could not load Lark settings.", "error", { clear: true });
        setLoading(false);
        return;
      }

      const settings = response.settings;
      const existingSecret = settings.lark_app_secret === MASKED_SECRET;
      setEnabled(Boolean(settings.lark_login_enabled));
      setAppId(settings.lark_app_id || "");
      setAppSecret(existingSecret ? MASKED_SECRET : "");
      setHasExistingSecret(existingSecret);
      setSecretEditing(!existingSecret);
      setTenantKey(settings.lark_tenant_key || "");
      setScopes(settings.lark_scopes || DEFAULT_SCOPES);
      setAllowlist(
        Array.isArray(settings.lark_cli_allowlist)
          ? normalizeAllowlist(settings.lark_cli_allowlist)
          : DEFAULT_ALLOWLIST
      );
      setRedirectUri(
        settings.redirect_uri ||
          `${window.location.origin}/api/lark/auth/callback`
      );
      setLoading(false);
    }
    loadSettings();
  }, []);

  const normalizedScopes = normalizeScopes(scopes);
  const enablementIncomplete =
    enabled &&
    (!appId.trim() ||
      !tenantKey.trim() ||
      (!hasExistingSecret && !appSecret.trim()) ||
      !normalizedScopes ||
      !allowlist.length);

  function replaceSecret() {
    setAppSecret("");
    setSecretEditing(true);
    setErrors((current) => ({ ...current, lark_app_secret: undefined }));
  }

  function addAllowlistEntry() {
    const entry = allowlistEntry.trim().toLowerCase();
    if (!entry) return;
    if (!/^[a-z0-9-]+$/.test(entry) || DENIED_COMMANDS.includes(entry)) {
      setErrors((current) => ({
        ...current,
        lark_cli_allowlist: "Contains an invalid or forbidden command.",
      }));
      showToast("This command cannot be added.", "error", { clear: true });
      return;
    }
    if (!allowlist.includes(entry))
      setAllowlist((current) => [...current, entry]);
    setAllowlistEntry("");
    setErrors((current) => ({ ...current, lark_cli_allowlist: undefined }));
  }

  async function copyRedirectUri() {
    try {
      await navigator.clipboard.writeText(redirectUri);
      showToast("Redirect URL copied.", "success", { clear: true });
    } catch {
      showToast("Could not copy redirect URL.", "error", { clear: true });
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    if (enablementIncomplete) return;
    setSaving(true);
    setErrors({});

    const payload = {
      lark_login_enabled: enabled,
      lark_scopes: normalizedScopes,
      lark_cli_allowlist: normalizeAllowlist(allowlist),
    };
    if (appId.trim()) payload.lark_app_id = appId.trim();
    if (tenantKey.trim()) payload.lark_tenant_key = tenantKey.trim();
    if (secretEditing && appSecret.trim())
      payload.lark_app_secret = appSecret.trim();

    const response = await Admin.updateLarkSettings(payload);
    setSaving(false);
    if (!response?.success) {
      setErrors(response?.errors || {});
      showToast(response?.error || "Could not save Lark settings.", "error", {
        clear: true,
      });
      return;
    }

    if (secretEditing && appSecret.trim()) {
      setHasExistingSecret(true);
      setSecretEditing(false);
      setAppSecret(MASKED_SECRET);
    }
    setScopes(normalizedScopes);
    showToast("Lark settings saved.", "success", { clear: true });
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    const response = await Admin.testLarkConnection({
      lark_app_id: appId,
      ...(secretEditing &&
        appSecret !== MASKED_SECRET && { lark_app_secret: appSecret }),
    });
    setTesting(false);
    if (response?.ok) {
      if (response.tenant_key)
        setTenantKey((current) =>
          current.trim() ? current : response.tenant_key
        );
      setTestResult({
        ok: true,
        message: response.tenant_key
          ? `Connection successful. Tenant: ${response.tenant_name || response.tenant_key}`
          : "Connection successful, but the tenant could not be read. Add the tenant:tenant:readonly scope in Lark Developer Console or enter the tenant_key manually.",
      });
      return;
    }
    setTestResult({
      ok: false,
      message:
        {
          missing_credentials: "Enter App ID and App Secret first.",
          rejected: "Lark rejected the App ID or App Secret.",
          unreachable: "Could not reach Lark. Check network and try again.",
        }[response?.error] ||
        "Could not reach Lark. Check network and try again.",
    });
  }

  if (loading) return <FullScreenLoader />;

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll p-4 md:p-0"
      >
        <div className="flex flex-col w-full px-1 md:pl-6 md:pr-[50px] md:py-6 py-16">
          <div className="w-full flex flex-col gap-y-1 pb-6 border-white/10 border-b-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-theme-text-secondary">
              Authentication provider
            </p>
            <h1 className="text-lg leading-6 font-bold text-theme-text-primary">
              Lark
            </h1>
            <p className="max-w-[680px] text-xs leading-[18px] text-theme-text-secondary">
              Let company members sign in and allow connected users to run
              approved Lark actions through chat.
            </p>
          </div>

          <form
            onSubmit={saveSettings}
            className="flex w-full max-w-[760px] flex-col gap-6 py-6"
          >
            <Toggle
              data-testid="lark-enabled"
              size="lg"
              enabled={enabled}
              onChange={setEnabled}
              variant="horizontal"
              label="Enable Lark"
              description="Available only in multi-user mode."
            />
            <FieldError message={errors.lark_login_enabled} />

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="App ID" error={errors.lark_app_id}>
                <input
                  id="lark-app-id"
                  data-testid="lark-app-id"
                  value={appId}
                  onChange={(event) => setAppId(event.target.value)}
                  className={inputClass}
                  autoComplete="off"
                />
              </Field>
              <Field
                label="App Secret"
                error={errors.lark_app_secret}
                help="Write-only. Existing secret cannot be revealed."
              >
                <div className="flex gap-2">
                  <input
                    id="lark-app-secret"
                    data-testid="lark-app-secret"
                    type={secretEditing ? "password" : "text"}
                    value={appSecret}
                    onChange={(event) => setAppSecret(event.target.value)}
                    readOnly={!secretEditing}
                    placeholder="Paste new App Secret"
                    className={inputClass}
                    autoComplete="new-password"
                  />
                  {!secretEditing && (
                    <button
                      type="button"
                      onClick={replaceSecret}
                      className={secondaryButtonClass}
                    >
                      Replace
                    </button>
                  )}
                </div>
              </Field>
            </div>

            <Field
              label="Allowed tenant_key"
              error={errors.lark_tenant_key}
              help="Only accounts from this company can sign in. Auto-linking by email local-part relies on this restriction."
            >
              <input
                id="lark-tenant-key"
                data-testid="lark-tenant-key"
                value={tenantKey}
                onChange={(event) => setTenantKey(event.target.value)}
                className={inputClass}
                autoComplete="off"
              />
            </Field>

            <Field
              label="Redirect URL"
              help="Add this exact URL in Lark Developer Console."
            >
              <div className="flex gap-2">
                <input
                  id="lark-redirect-uri"
                  value={redirectUri}
                  readOnly
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={copyRedirectUri}
                  className={`${secondaryButtonClass} flex items-center gap-2`}
                >
                  <Copy size={16} /> Copy
                </button>
              </div>
            </Field>

            <Field label="OAuth scopes" error={errors.lark_scopes}>
              <textarea
                id="lark-scopes"
                value={scopes}
                onChange={(event) => setScopes(event.target.value)}
                placeholder={DEFAULT_SCOPES}
                rows={5}
                className={`${inputClass} resize-y`}
              />
            </Field>

            <Field label="CLI allowlist" error={errors.lark_cli_allowlist}>
              <div className="mb-3 flex flex-wrap gap-2">
                {allowlist.map((entry) => (
                  <span
                    key={entry}
                    className="inline-flex items-center gap-1.5 rounded-full border border-theme-sidebar-border bg-theme-bg-primary px-3 py-1.5 text-xs text-theme-text-primary"
                  >
                    {entry}
                    <button
                      type="button"
                      onClick={() =>
                        setAllowlist((current) =>
                          current.filter((item) => item !== entry)
                        )
                      }
                      aria-label={`Remove ${entry}`}
                      className="text-theme-text-secondary hover:text-theme-text-primary"
                    >
                      <X size={13} />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex max-w-[350px] gap-2">
                <input
                  aria-label="Add command prefix"
                  value={allowlistEntry}
                  onChange={(event) => setAllowlistEntry(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addAllowlistEntry();
                    }
                  }}
                  placeholder="Command prefix"
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={addAllowlistEntry}
                  className={`${secondaryButtonClass} flex items-center gap-2`}
                >
                  <Plus size={16} /> Add
                </button>
              </div>
            </Field>

            <Field
              label="Always denied"
              help="These commands cannot be enabled."
            >
              <div className="flex flex-wrap gap-2 opacity-60">
                {DENIED_COMMANDS.map((entry) => (
                  <span
                    key={entry}
                    className="rounded-full border border-theme-sidebar-border bg-theme-bg-primary px-3 py-1.5 text-xs text-theme-text-primary"
                  >
                    {entry}
                  </span>
                ))}
              </div>
            </Field>

            {testResult && (
              <div
                role="status"
                data-testid="lark-test-result"
                className={`rounded-lg border px-4 py-3 text-sm ${
                  testResult.ok
                    ? "border-green-500/30 bg-green-500/10 text-green-400"
                    : "border-red-500/30 bg-red-500/10 text-red-400"
                }`}
              >
                {testResult.message}
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                data-testid="lark-test-connection"
                onClick={testConnection}
                disabled={testing}
                className={secondaryButtonClass}
              >
                {testing ? "Testing..." : "Test connection"}
              </button>
              <button
                type="submit"
                data-testid="lark-save"
                disabled={saving || enablementIncomplete}
                className="rounded-lg bg-primary-button px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-button-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save settings"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

function Field({ label, error, help, children }) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-theme-text-primary">
        {label}
      </label>
      {children}
      {help && (
        <p className="text-xs leading-[18px] text-theme-text-secondary">
          {help}
        </p>
      )}
      <FieldError message={error} />
    </div>
  );
}

function FieldError({ message }) {
  if (!message) return null;
  return <p className="text-xs text-red-400">{message}</p>;
}
