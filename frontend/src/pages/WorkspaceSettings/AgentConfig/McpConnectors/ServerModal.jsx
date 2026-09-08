import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Modal, {
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalInput,
  ModalTextarea,
  ModalLabel,
  ModalPrimaryButton,
  ModalSecondaryButton,
} from "@/components/lib/Modal";
import PasswordInput from "@/components/lib/PasswordInput";
import Toggle from "@/components/lib/Toggle";
import WorkspaceMcp, {
  MCP_NAME,
  MCP_SECRET_KEY,
  MCP_SECRET_MASK,
  validateMcpConfig,
  parseMcpJson,
  mcpErrorMessage,
} from "@/models/workspaceMcp";
import showToast from "@/utils/toast";

export const fieldClass =
  "w-full min-w-0 rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-sm text-theme-text-primary focus-visible:outline focus-visible:outline-2 disabled:opacity-50";

export default function ServerModal({ slug, server, onClose, onSaved }) {
  const { t } = useTranslation();
  const initial = server?.config || {};
  const [name, setName] = useState(server?.name || "");
  const [url, setUrl] = useState(initial.url || "");
  const [transport, setTransport] = useState(
    initial.type === "streamable" ? "http" : initial.type || "sse"
  );
  const nextHeaderId = useRef(0);
  const [headers, setHeaders] = useState(() =>
    Object.entries(initial.headers || {}).map(([key, value]) => ({
      id: nextHeaderId.current++,
      key,
      value,
    }))
  );
  const [oauth, setOauth] = useState(
    initial.anythingllm?.perWorkspaceAuth === true
  );
  const [suppressed, setSuppressed] = useState(
    initial.anythingllm?.suppressedTools || []
  );
  const [tab, setTab] = useState("form");
  const [json, setJson] = useState("");
  const [extraEntries, setExtraEntries] = useState([]);
  const [test, setTest] = useState({ state: "idle" });
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState([]);
  const [created, setCreated] = useState([]);
  const controller = useRef(null);
  const dirty = useRef(false);
  useEffect(() => () => controller.current?.abort(), []);

  const config = {
    url: url.trim(),
    type: transport,
    headers: Object.fromEntries(
      headers
        .filter((row) => row.key.trim())
        .map((row) => [row.key.trim(), row.value])
    ),
    anythingllm: { perWorkspaceAuth: oauth, suppressedTools: suppressed },
  };
  const duplicateHeader =
    new Set(headers.map((row) => row.key.trim().toLowerCase())).size !==
    headers.length;
  const formError = !MCP_NAME.test(name.trim())
    ? "invalid_name"
    : headers.some((row) => !row.key.trim()) || duplicateHeader
      ? "invalid_headers"
      : extraEntries.some(([entryName]) => entryName === name.trim())
        ? "name_conflict"
        : validateMcpConfig(config);
  const parsed =
    tab === "json"
      ? parseMcpJson(json, name.trim(), !!server)
      : { entries: [[name.trim(), config], ...extraEntries], error: formError };
  const valid = !parsed.error;
  const selectedConfig = parsed.entries?.[0]?.[1];

  function resetTest() {
    controller.current?.abort();
    controller.current = null;
    setTest({ state: "idle" });
    setErrors([]);
  }
  function change(setter, value) {
    dirty.current = true;
    resetTest();
    setter(value);
  }
  function updateHeader(id, patch) {
    change(
      setHeaders,
      headers.map((row) => (row.id === id ? { ...row, ...patch } : row))
    );
  }
  function switchTab(next) {
    if (next === tab) return;
    if (next === "form") {
      applyJsonToForm();
      return;
    }
    if (next === "json")
      setJson(
        JSON.stringify(
          {
            mcpServers: Object.fromEntries([
              [name.trim(), config],
              ...extraEntries,
            ]),
          },
          null,
          2
        )
      );
    setTab(next);
  }
  function applyJsonToForm() {
    if (!valid) return;
    const [[entryName, definition], ...extra] = parsed.entries;
    resetTest();
    setName(entryName);
    setUrl(definition.url);
    setTransport(
      definition.type === "streamable" ? "http" : definition.type || "sse"
    );
    setHeaders(
      Object.entries(definition.headers || {}).map(([key, value]) => ({
        id: nextHeaderId.current++,
        key,
        value,
      }))
    );
    setOauth(definition.anythingllm?.perWorkspaceAuth === true);
    setSuppressed(definition.anythingllm?.suppressedTools || []);
    setExtraEntries(extra);
    setTab("form");
  }
  async function testConnection() {
    if (!valid || saving) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setTest({ state: "testing" });
    const hasMask = Object.values(selectedConfig.headers || {}).includes(
      MCP_SECRET_MASK
    );
    // Draft tests cannot resolve stored secret sentinels. Never send them as credentials.
    if (hasMask && (!server || dirty.current)) {
      controller.current = null;
      setTest({ state: "error", error: "save_masked_first" });
      return;
    }
    try {
      const result = await WorkspaceMcp.test(
        slug,
        server && !dirty.current
          ? { name: server.name }
          : { config: selectedConfig },
        abort.signal
      );
      if (!abort.signal.aborted) setTest({ state: "ok", ...result });
    } catch (error) {
      if (!abort.signal.aborted)
        setTest({ state: "error", error: error.message });
    } finally {
      if (controller.current === abort) controller.current = null;
    }
  }
  async function save() {
    if (!valid || saving) return;
    setSaving(true);
    setErrors([]);
    try {
      if (server) await WorkspaceMcp.update(slug, server.name, selectedConfig);
      else {
        const result = await WorkspaceMcp.create(slug, {
          mcpServers: Object.fromEntries(parsed.entries),
        });
        if (result.errors?.length) {
          setCreated(result.created || []);
          setErrors(result.errors);
          const failedNames = new Set(result.errors.map((entry) => entry.name));
          setJson(
            JSON.stringify(
              {
                mcpServers: Object.fromEntries(
                  parsed.entries.filter(([entryName]) =>
                    failedNames.has(entryName)
                  )
                ),
              },
              null,
              2
            )
          );
          setTab("json");
          setExtraEntries([]);
          await onSaved();
          return;
        }
      }
      showToast(t("agent.mcp.saved"), "success");
      await onSaved();
      onClose();
    } catch (error) {
      setErrors(
        error.errors?.length ? error.errors : [{ error: error.message }]
      );
    } finally {
      setSaving(false);
    }
  }
  const close = () => {
    if (!saving) {
      controller.current?.abort();
      onClose();
    }
  };
  const title = server
    ? t("agent.mcp.edit-title", { name: server.name })
    : t("agent.mcp.add");

  return (
    <Modal isOpen onClose={close} size="lg">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex min-w-0 flex-col gap-5 text-theme-text-primary"
      >
        <ModalHeader
          title={title}
          subtitle={t("agent.mcp.modal-description", { workspace: slug })}
          onClose={close}
        />
        <div
          role="tablist"
          aria-label={t("agent.mcp.config-tabs")}
          className="flex gap-5 border-b border-theme-modal-border"
        >
          {["form", "json"].map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={tab === item}
              aria-controls={`mcp-${item}-panel`}
              id={`mcp-${item}-tab`}
              disabled={saving}
              className={`border-b-2 px-1 py-2 text-sm font-semibold ${tab === item ? "border-primary-button" : "border-transparent text-theme-text-secondary"}`}
              onClick={() => switchTab(item)}
            >
              {t(`agent.mcp.${item}`)}
            </button>
          ))}
        </div>
        <fieldset disabled={saving} className="min-w-0">
          {tab === "form" ? (
            <div
              role="tabpanel"
              id="mcp-form-panel"
              aria-labelledby="mcp-form-tab"
            >
              <ModalBody>
                <div className="grid gap-4 sm:grid-cols-2">
                  <ModalInput
                    id="mcp-name"
                    label={t("agent.mcp.name")}
                    required
                    autoFocus
                    disabled={!!server}
                    autoComplete="off"
                    value={name}
                    onChange={(event) => change(setName, event.target.value)}
                    hint={t("agent.mcp.name-hint")}
                  />
                  <div>
                    <ModalLabel htmlFor="mcp-transport">
                      {t("agent.mcp.transport")}
                    </ModalLabel>
                    <select
                      id="mcp-transport"
                      className={`${fieldClass} mt-1.5`}
                      value={transport}
                      onChange={(event) =>
                        change(setTransport, event.target.value)
                      }
                    >
                      <option value="sse">SSE</option>
                      <option value="http">Streamable HTTP</option>
                    </select>
                  </div>
                </div>
                <ModalInput
                  id="mcp-url"
                  label={t("agent.mcp.url")}
                  required
                  autoComplete="off"
                  value={url}
                  onChange={(event) => change(setUrl, event.target.value)}
                  hint={t("agent.mcp.url-hint")}
                />
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <h4 className="text-sm font-semibold">
                      {t("agent.mcp.headers")}
                    </h4>
                    <ModalSecondaryButton
                      type="button"
                      onClick={() =>
                        change(setHeaders, [
                          ...headers,
                          { id: nextHeaderId.current++, key: "", value: "" },
                        ])
                      }
                    >
                      {t("agent.mcp.add-header")}
                    </ModalSecondaryButton>
                  </div>
                  <div className="space-y-3">
                    {headers.map((row, index) => {
                      const ValueInput = MCP_SECRET_KEY.test(row.key)
                        ? PasswordInput
                        : "input";
                      return (
                        <div
                          key={row.id}
                          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] items-start gap-2"
                        >
                          <div>
                            <ModalLabel htmlFor={`header-key-${row.id}`}>
                              {t("agent.mcp.header-key", { index: index + 1 })}
                            </ModalLabel>
                            <input
                              id={`header-key-${row.id}`}
                              className={fieldClass}
                              value={row.key}
                              autoComplete="off"
                              onChange={(event) =>
                                updateHeader(row.id, {
                                  key: event.target.value,
                                })
                              }
                            />
                          </div>
                          <div>
                            <ModalLabel htmlFor={`header-value-${row.id}`}>
                              {t("agent.mcp.header-value", {
                                index: index + 1,
                              })}
                            </ModalLabel>
                            <ValueInput
                              id={`header-value-${row.id}`}
                              className={fieldClass}
                              autoComplete="off"
                              value={row.value}
                              onChange={(event) =>
                                updateHeader(row.id, {
                                  value: event.target.value,
                                })
                              }
                            />
                            {row.value === MCP_SECRET_MASK && (
                              <button
                                type="button"
                                className="mt-1 text-xs underline"
                                aria-label={t("agent.mcp.clear-header", {
                                  index: index + 1,
                                })}
                                onClick={() =>
                                  updateHeader(row.id, { value: "" })
                                }
                              >
                                {t("agent.mcp.clear")}
                              </button>
                            )}
                          </div>
                          <button
                            type="button"
                            className="mt-6 rounded-lg border border-theme-modal-border p-2"
                            aria-label={t("agent.mcp.remove-header", {
                              index: index + 1,
                            })}
                            onClick={() =>
                              change(
                                setHeaders,
                                headers.filter((entry) => entry.id !== row.id)
                              )
                            }
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-xs text-theme-text-secondary">
                    {t("agent.mcp.secret-hint")}
                  </p>
                </div>
                <Toggle
                  label={t("agent.mcp.oauth-required")}
                  description={t("agent.mcp.oauth-hint")}
                  size="md"
                  variant="horizontal"
                  enabled={oauth}
                  onChange={(enabled) => change(setOauth, enabled)}
                />
                {test.state === "ok" && (
                  <fieldset>
                    <legend className="mb-2 text-sm font-semibold">
                      {t("agent.mcp.allowed-tools")}
                    </legend>
                    {test.tools.map((tool) => (
                      <label
                        key={tool.name}
                        className="mb-2 flex items-start gap-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={!suppressed.includes(tool.name)}
                          onChange={(event) => {
                            dirty.current = true;
                            setSuppressed(
                              event.target.checked
                                ? suppressed.filter(
                                    (item) => item !== tool.name
                                  )
                                : [...suppressed, tool.name]
                            );
                          }}
                        />
                        <span className="min-w-0 break-words">
                          <span className="font-mono">{tool.name}</span>
                          <span className="ml-2 text-xs text-theme-text-secondary">
                            {tool.description}
                          </span>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                )}
                {formError && (name || url || headers.length > 0) && (
                  <p role="alert" className="text-sm text-red-400">
                    {mcpErrorMessage(t, formError)}
                  </p>
                )}
                {extraEntries.length > 0 && (
                  <p className="text-sm text-theme-text-secondary">
                    {t("agent.mcp.extra-servers", {
                      count: extraEntries.length,
                    })}
                  </p>
                )}
              </ModalBody>
            </div>
          ) : (
            <div
              role="tabpanel"
              id="mcp-json-panel"
              aria-labelledby="mcp-json-tab"
            >
              <ModalBody>
                <p className="text-xs text-theme-text-secondary">
                  {t("agent.mcp.json-hint")}
                </p>
                {!server && (
                  <ModalInput
                    id="mcp-json-name"
                    label={t("agent.mcp.name")}
                    value={name}
                    onChange={(event) => change(setName, event.target.value)}
                    hint={t("agent.mcp.single-name-hint")}
                  />
                )}
                <ModalTextarea
                  id="mcp-json"
                  label={t("agent.mcp.json-config")}
                  rows={12}
                  spellCheck={false}
                  className="font-mono"
                  value={json}
                  onChange={(event) => change(setJson, event.target.value)}
                />
                <p
                  role={parsed.error ? "alert" : "status"}
                  className={`text-sm ${parsed.error ? "text-red-400" : "text-green-400"}`}
                >
                  {parsed.error
                    ? mcpErrorMessage(t, parsed.error)
                    : t("agent.mcp.json-valid", {
                        count: parsed.entries.length,
                      })}
                </p>
                <ModalSecondaryButton
                  type="button"
                  disabled={!valid}
                  onClick={applyJsonToForm}
                >
                  {t("agent.mcp.use-form")}
                </ModalSecondaryButton>
              </ModalBody>
            </div>
          )}
        </fieldset>
        <div
          className="space-y-3 border-t border-theme-modal-border pt-4"
          aria-live="polite"
          aria-busy={test.state === "testing"}
        >
          <div className="flex flex-wrap items-center gap-2">
            <ModalSecondaryButton
              type="button"
              disabled={!valid || saving || test.state === "testing"}
              onClick={testConnection}
            >
              {t("agent.mcp.test-connection")}
            </ModalSecondaryButton>
            {test.state === "testing" && (
              <ModalSecondaryButton type="button" onClick={resetTest}>
                {t("agent.mcp.cancel-test")}
              </ModalSecondaryButton>
            )}
            <span
              role="status"
              className="flex items-center gap-2 text-xs text-theme-text-secondary"
            >
              {test.state === "testing" && (
                <span
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin rounded-full border-2 border-theme-modal-border border-t-primary-button motion-reduce:animate-none"
                />
              )}
              {t(`agent.mcp.test-${test.state}`)}
            </span>
          </div>
          {test.state === "error" && (
            <div
              role="alert"
              className="rounded-lg border border-red-400/40 p-3 text-sm"
            >
              <p>{mcpErrorMessage(t, test.error)}</p>
              <details className="mt-2 text-xs">
                <summary>{t("agent.mcp.details")}</summary>
                <p>{t("agent.mcp.test-error-details")}</p>
              </details>
            </div>
          )}
          {test.state === "ok" && (
            <div className="rounded-lg border border-green-400/40 p-3 text-sm">
              <p>
                {t("agent.mcp.test-success", {
                  count: test.tools.length,
                  latency: test.latencyMs,
                })}
              </p>
              <details className="mt-2">
                <summary>{t("agent.mcp.tool-list")}</summary>
                <ul>
                  {test.tools.map((tool) => (
                    <li key={tool.name} className="mt-1 break-words">
                      <span className="font-mono">{tool.name}</span>{" "}
                      {tool.description}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )}
          {valid && test.state !== "ok" && (
            <p className="text-xs text-amber-400">
              {t("agent.mcp.untested-warning")}
            </p>
          )}
          {tab === "json" && parsed.entries?.length > 1 && (
            <p className="text-xs text-theme-text-secondary">
              {t("agent.mcp.test-first")}
            </p>
          )}
          {created.length > 0 && (
            <p role="status" className="text-sm">
              {t("agent.mcp.created-names", { names: created.join(", ") })}
            </p>
          )}
          {errors.length > 0 && (
            <ul role="alert" className="text-sm text-red-400">
              {errors.map((error, index) => (
                <li key={index}>
                  {error.name && `${error.name}: `}
                  {mcpErrorMessage(t, error.error)}
                </li>
              ))}
            </ul>
          )}
        </div>
        <ModalFooter>
          <ModalSecondaryButton type="button" disabled={saving} onClick={close}>
            {t("agent.mcp.cancel")}
          </ModalSecondaryButton>
          <ModalPrimaryButton
            type="button"
            disabled={!valid || saving || test.state === "testing"}
            onClick={save}
          >
            {t(saving ? "agent.mcp.saving" : "agent.mcp.save")}
          </ModalPrimaryButton>
        </ModalFooter>
      </div>
    </Modal>
  );
}
