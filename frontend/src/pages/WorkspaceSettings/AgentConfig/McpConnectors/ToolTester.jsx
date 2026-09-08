import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Modal, {
  ModalHeader,
  ModalBody,
  ModalLabel,
  ModalPrimaryButton,
  ModalSecondaryButton,
} from "@/components/lib/Modal";
import WorkspaceMcp, { mcpErrorMessage } from "@/models/workspaceMcp";
import showToast from "@/utils/toast";
import { fieldClass } from "./ServerModal";

export default function ToolTester({ slug, server, onClose }) {
  const { t } = useTranslation();
  const [tools, setTools] = useState([]);
  const [selected, setSelected] = useState("");
  const [values, setValues] = useState({});
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const controller = useRef(null);
  const tool = tools.find((entry) => entry.name === selected);
  const properties = Object.entries(tool?.inputSchema?.properties || {});
  const required = tool?.inputSchema?.required || [];

  async function loadTools() {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    setError(null);
    try {
      const response = await WorkspaceMcp.test(
        slug,
        { name: server.name },
        abort.signal
      );
      if (abort.signal.aborted) return;
      setTools(response.tools);
      setSelected(response.tools[0]?.name || "");
      setValues({});
    } catch (err) {
      if (!abort.signal.aborted) setError(mcpErrorMessage(t, err));
    } finally {
      if (!abort.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    loadTools();
    return () => controller.current?.abort();
  }, [slug, server.name]);

  function argumentsFromForm() {
    const args = {};
    for (const [name, schema] of properties) {
      const value = Object.hasOwn(values, name) ? values[name] : undefined;
      if (value === undefined || value === "") {
        if (schema.type === "boolean" && !schema.enum) {
          Object.defineProperty(args, name, { value: false, enumerable: true });
          continue;
        }
        if (required.includes(name))
          throw new Error(t("agent.mcp.argument-required", { name }));
        continue;
      }
      let parsed = value;
      if (schema.enum) parsed = schema.enum[Number(value)];
      else if (["number", "integer"].includes(schema.type)) {
        parsed = Number(value);
        if (
          !Number.isFinite(parsed) ||
          (schema.type === "integer" && !Number.isInteger(parsed))
        )
          throw new Error(t("agent.mcp.argument-number", { name }));
      } else if (
        ["object", "array"].includes(schema.type) ||
        !["string", "boolean"].includes(schema.type)
      ) {
        try {
          parsed = JSON.parse(value);
        } catch {
          throw new Error(t("agent.mcp.argument-json", { name }));
        }
        if (
          (schema.type === "object" &&
            (parsed === null ||
              typeof parsed !== "object" ||
              Array.isArray(parsed))) ||
          (schema.type === "array" && !Array.isArray(parsed))
        )
          throw new Error(
            t("agent.mcp.argument-type", { name, type: schema.type })
          );
      }
      Object.defineProperty(args, name, { value: parsed, enumerable: true });
    }
    return args;
  }
  async function run(event) {
    event.preventDefault();
    if (!tool || running) return;
    setError(null);
    setResult(null);
    let args;
    try {
      args = argumentsFromForm();
    } catch (err) {
      setError(err.message);
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    try {
      const response = await WorkspaceMcp.call(
        slug,
        server.name,
        tool.name,
        args,
        abort.signal
      );
      if (!abort.signal.aborted) setResult(response);
    } catch (err) {
      if (!abort.signal.aborted) setError(mcpErrorMessage(t, err));
    } finally {
      if (!abort.signal.aborted) setRunning(false);
    }
  }
  async function copyResult() {
    try {
      await navigator.clipboard.writeText(result.result);
      showToast(t("agent.mcp.copied"), "success");
    } catch {
      showToast(t("agent.mcp.copy-failed"), "error");
    }
  }
  const title = t("agent.mcp.test-tools-title", { name: server.name });
  return (
    <Modal isOpen onClose={onClose} size="lg">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex min-w-0 flex-col gap-4 text-theme-text-primary"
      >
        <ModalHeader title={title} onClose={onClose} />
        <p className="rounded-lg border border-amber-400/40 p-3 text-sm text-amber-400">
          {t("agent.mcp.real-data-warning")}
        </p>
        {!server.enabled && (
          <p className="text-sm text-amber-400">
            {t("agent.mcp.enable-before-run")}
          </p>
        )}
        {loading ? (
          <p role="status">{t("agent.mcp.loading-tools")}</p>
        ) : (
          <form onSubmit={run} className="min-w-0">
            <ModalBody>
              <fieldset disabled={running} className="min-w-0 space-y-4">
                <div>
                  <ModalLabel htmlFor="mcp-tool">
                    {t("agent.mcp.choose-tool")}
                  </ModalLabel>
                  <select
                    id="mcp-tool"
                    className={`${fieldClass} mt-1.5 font-mono`}
                    value={selected}
                    onChange={(event) => {
                      setSelected(event.target.value);
                      setValues({});
                      setResult(null);
                      setError(null);
                    }}
                  >
                    {tools.map((entry) => (
                      <option key={entry.name} value={entry.name}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-theme-text-secondary">
                    {tool?.description}
                  </p>
                </div>
                {tools.length === 0 && <p>{t("agent.mcp.no-tools")}</p>}
                {tool && properties.length === 0 && (
                  <p className="text-sm text-theme-text-secondary">
                    {t("agent.mcp.no-arguments")}
                  </p>
                )}
                {properties.map(([name, schema], index) => {
                  const id = `mcp-argument-${index}`;
                  const isRequired = required.includes(name);
                  const update = (value) =>
                    setValues((previous) => ({ ...previous, [name]: value }));
                  return (
                    <div key={name}>
                      <ModalLabel htmlFor={id}>
                        {name}
                        {isRequired ? " *" : ""}
                      </ModalLabel>
                      {schema.enum ? (
                        <select
                          id={id}
                          className={fieldClass}
                          required={isRequired}
                          value={
                            Object.hasOwn(values, name) ? values[name] : ""
                          }
                          onChange={(event) => update(event.target.value)}
                        >
                          <option value="">
                            {t("agent.mcp.choose-value")}
                          </option>
                          {schema.enum.map((value, i) => (
                            <option key={i} value={i}>
                              {typeof value === "string"
                                ? value
                                : JSON.stringify(value)}
                            </option>
                          ))}
                        </select>
                      ) : schema.type === "boolean" ? (
                        <input
                          id={id}
                          type="checkbox"
                          className="ml-3"
                          checked={values[name] === true}
                          onChange={(event) => update(event.target.checked)}
                        />
                      ) : ["string", "number", "integer"].includes(
                          schema.type
                        ) ? (
                        <input
                          id={id}
                          className={fieldClass}
                          type={schema.type === "string" ? "text" : "number"}
                          step={schema.type === "integer" ? 1 : "any"}
                          required={isRequired}
                          value={
                            Object.hasOwn(values, name) ? values[name] : ""
                          }
                          onChange={(event) => update(event.target.value)}
                        />
                      ) : (
                        <textarea
                          id={id}
                          className={`${fieldClass} font-mono`}
                          rows={4}
                          required={isRequired}
                          value={
                            Object.hasOwn(values, name) ? values[name] : ""
                          }
                          placeholder={schema.type === "array" ? "[]" : "{}"}
                          onChange={(event) => update(event.target.value)}
                        />
                      )}
                      {schema.description && (
                        <p className="mt-1 text-xs text-theme-text-secondary">
                          {schema.description}
                        </p>
                      )}
                    </div>
                  );
                })}
              </fieldset>
              <div className="flex items-center gap-3">
                <ModalPrimaryButton
                  type="submit"
                  disabled={!tool || running || !server.enabled}
                >
                  {t("agent.mcp.run")}
                </ModalPrimaryButton>
                {running && (
                  <p role="status" className="text-sm">
                    {t("agent.mcp.running")}
                  </p>
                )}
              </div>
            </ModalBody>
          </form>
        )}
        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-400/40 p-3 text-sm"
          >
            <p>{error}</p>
            {!tools.length && !loading && (
              <ModalSecondaryButton type="button" onClick={loadTools}>
                {t("agent.mcp.retry")}
              </ModalSecondaryButton>
            )}
          </div>
        )}
        {result && (
          <section aria-label={t("agent.mcp.raw-result")} className="min-w-0">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span>
                {t("agent.mcp.result-latency", { latency: result.latencyMs })}
              </span>
              <ModalSecondaryButton type="button" onClick={copyResult}>
                {t("agent.mcp.copy")}
              </ModalSecondaryButton>
            </div>
            {result.truncated && (
              <p className="mt-2 text-xs text-amber-400">
                {t("agent.mcp.truncated")}
              </p>
            )}
            <pre className="mt-2 max-h-80 max-w-full overflow-auto rounded-lg border border-theme-modal-border bg-theme-bg-primary p-3 text-xs">
              {result.result}
            </pre>
          </section>
        )}
      </div>
    </Modal>
  );
}
