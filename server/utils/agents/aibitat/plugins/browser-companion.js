const registry = require("../../../browserCompanion/registry");
const protocol = require("../../../browserCompanion/protocol");
const { SystemSettings } = require("../../../../models/systemSettings");

// page_fetch exists to read what the DOM cannot show (canvas-drawn apps like
// Google Sheets) using the user's own session. Reads only: anything that writes
// must go through page_click, where the user can see what happened.
//
// A true constant, not a setting: making the allowed method configurable would
// mean a deployment could turn the read-only guarantee off, which is the one
// property this restriction exists to hold. The extension enforces same-origin
// separately; the method restriction is this module's half.
const ALLOWED_FETCH_METHOD = "GET";

/**
 * Run one browser command for one agent run.
 *
 * Exported so tests can drive the command path without an AIbitat instance, and
 * so the eleven tool handlers share one implementation rather than eleven copies.
 *
 * Returns text in every non-programmer-error case: the agent reads the return
 * value and reasons about it, so a refusal has to say what to do instead.
 *
 * Does NOT catch: `registry.resolve` throws a TypeError when `multiUserMode` is
 * not a real boolean, and that throw must surface. Swallowing it here would turn
 * a programmer error into a "browser not connected" message and quietly restore
 * the fail-open path the boolean check exists to close — one layer out from the
 * registry, where no reviewer of the registry would ever look for it. The tool
 * handler below catches it at the agent boundary so the turn is not aborted, and
 * reports the error text rather than an offline message.
 *
 * @param {{cmd: string, payload?: object, userId: number|null|undefined, multiUserMode: boolean}} args
 * @returns {Promise<string>}
 * @throws {TypeError} propagated from `registry.resolve` for a non-boolean `multiUserMode`.
 */
async function runCommand({ cmd, payload = {}, userId, multiUserMode }) {
  if (cmd === "fetch") {
    // `?? ` not `|| `: an empty-string method is a caller mistake, and treating
    // it as "unspecified GET" would silently accept a value nobody meant. It
    // falls through to the comparison and is refused with the same message.
    const method = String(payload.method ?? ALLOWED_FETCH_METHOD).toUpperCase();
    if (method !== ALLOWED_FETCH_METHOD)
      return `page_fetch only performs ${ALLOWED_FETCH_METHOD} requests. To change something on the page, use page_click so the user can see it happen.`;
  }

  // The two refusals that are not "offline" — no user on the run, and a legacy
  // null key in multi-user mode — come back through this same `error` channel.
  // Passed through verbatim: each names a different fix for the human reading
  // the transcript, and flattening them into one message loses that.
  const { socket, error } = registry.resolve({ userId, multiUserMode });
  if (!socket) return error;

  // No timeoutMs: the deadline belongs to protocol.js, which owns
  // BROWSER_COMPANION_TIMEOUT_MS and the clamping. Passing one from here would
  // put a second, unclamped source of truth in the caller — and the value that
  // matters (how long a browser may leave an agent turn blocked) is a
  // deployment concern already expressed in that env var.
  const result = await protocol.send({ socket, cmd, payload });
  if (!result.ok) return `Browser command failed: ${result.error}`;

  const body =
    typeof result.data === "string" ? result.data : JSON.stringify(result.data);

  // The command succeeded but something about RECORDING it did not — today, the
  // extension's audit write. Appended to the returned string rather than
  // returned as a field, because this string is the whole of what the model
  // sees: aibitat hands the tool's return value back as the tool result, so a
  // structured field would be dropped one layer further out and the warning
  // would be just as lost as it was before it crossed protocol.js.
  //
  // Appended, never substituted: the agent still needs `data` to carry on, and
  // the warning is something it should tell the user, not a reason to retry. A
  // retried click is a second click.
  return result.warning ? `${body}\n\n${result.warning}` : body;
}

// The eleven tools the model sees. `cmd` is the wire verb the extension
// switches on; `name` is what the model calls.
//
// PROTOCOL ENVELOPE: protocol.send writes `{...payload, requestId, cmd}`, so a
// property named `requestId` or `cmd` here would be silently dropped instead of
// forging the envelope. None is declared, and a test asserts that across every
// tool rather than trusting this comment.
//
// The descriptions are the interface the model reasons over, not documentation:
// a model that has only these strings must be able to work out the ordering.
// page_state assigns the [id]s that page_click and page_type consume, so all
// three name each other and say what a stale map costs.
const TOOLS = [
  {
    name: "page_state",
    cmd: "state",
    description:
      "List the interactive elements on the agent's browser tab, each with an [id] to act on. Call this immediately before every page_click or page_type: the [id]s are only valid for the page as it is right now, and acting on a stale map clicks the wrong thing.",
    properties: {},
  },
  {
    name: "page_click",
    cmd: "click",
    description:
      "Click an element by the [id] from page_state. Call page_state first, in the same turn — an [id] from an earlier page state may now point at a different element.",
    properties: {
      id: {
        type: "number",
        description: "The element [id] from the most recent page_state.",
      },
    },
    required: ["id"],
  },
  {
    name: "page_type",
    cmd: "type",
    description:
      "Type text into an element by the [id] from page_state. Call page_state first, in the same turn — an [id] from an earlier page state may now point at a different element.",
    properties: {
      id: {
        type: "number",
        description: "The element [id] from the most recent page_state.",
      },
      text: { type: "string", description: "Text to type." },
    },
    required: ["id", "text"],
  },
  {
    name: "page_read",
    cmd: "read",
    description:
      "Read the visible text of the agent's browser tab as markdown. Use this to understand the page; use page_state when you need [id]s to act on.",
    properties: {},
  },
  {
    name: "page_scroll",
    cmd: "scroll",
    description:
      "Scroll the agent's browser tab. Scrolling changes which elements are present, so call page_state again before acting on anything.",
    properties: {
      direction: {
        type: "string",
        enum: ["up", "down"],
        description: "Which way to scroll.",
      },
    },
    required: ["direction"],
  },
  {
    name: "page_key",
    cmd: "key",
    description:
      "Press a key such as Enter, Tab or Escape. A key press can navigate or submit, so call page_state again before acting on anything afterwards.",
    properties: {
      key: { type: "string", description: "Key name, e.g. Enter." },
    },
    required: ["key"],
  },
  {
    name: "page_tabs",
    cmd: "tabs",
    description: "List the tabs the agent has open.",
    properties: {},
  },
  {
    name: "page_switch",
    cmd: "switch",
    description:
      "Switch the agent to one of its own open tabs by URL substring. The new tab has its own elements, so call page_state after switching.",
    properties: {
      url: {
        type: "string",
        description: "Substring of the target tab's URL.",
      },
    },
    required: ["url"],
  },
  {
    name: "page_navigate",
    cmd: "navigate",
    description:
      "Open a URL in the agent's own browser tab. The domain must be one the user allowed in the extension. The page is new after navigating, so call page_state before acting on it.",
    properties: {
      url: {
        type: "string",
        format: "uri",
        description: "Full URL including protocol.",
      },
    },
    required: ["url"],
  },
  {
    name: "page_close",
    cmd: "close",
    description: "Close one of the agent's own tabs.",
    properties: {},
  },
  // CONTRACT NOTE FOR THE EXTENSION (task 8): the schema below is ADVISORY.
  // aibitat calls `fn.handler(args)` with no validation layer — no ajv, nothing
  // that reads `required` or `additionalProperties` — so those keywords only
  // ever reach the model provider. `runCommand` spreads the model's args
  // straight into the frame, which means a model that emits `headers`, `body`
  // or `credentials` alongside `url` puts them on the wire:
  //
  //   {"url":"…","headers":{"Authorization":"Bearer …"},"credentials":"include",
  //    "method":"GET","requestId":"r_…","cmd":"fetch"}
  //
  // This plugin is therefore NOT a payload whitelist. It guarantees exactly one
  // thing about page_fetch — the method is GET — and nothing else. The
  // extension is the only component that can refuse the rest, so it must read
  // ONLY the fields declared here and ignore every other key on the frame.
  // Same-origin is likewise the extension's to enforce.
  {
    name: "page_fetch",
    cmd: "fetch",
    description:
      "GET a URL from inside the agent's tab, using the user's logged-in session, and return the body. Use for export endpoints and APIs behind a login — for example a Google Sheets CSV export, which page_read cannot see because the grid is drawn on canvas. Reads only: this performs a GET and nothing else, so to change anything use page_click, where the user can see it happen. Same-origin with the current tab only.",
    properties: {
      url: {
        type: "string",
        format: "uri",
        description:
          "Full URL to GET. Must be same-origin as the agent's current tab.",
      },
    },
    required: ["url"],
  },
];

const browserCompanion = {
  name: "browser-companion",
  // Exposed so the skill list and tests can enumerate the tools without
  // constructing an AIbitat.
  toolNames: TOOLS.map((tool) => tool.name),
  startupConfig: { params: {} },
  plugin: function () {
    return {
      name: this.name,
      setup(aibitat) {
        for (const tool of TOOLS) {
          aibitat.function({
            super: aibitat,
            name: tool.name,
            description: tool.description,
            parameters: {
              $schema: "http://json-schema.org/draft-07/schema#",
              type: "object",
              properties: tool.properties,
              ...(tool.required ? { required: tool.required } : {}),
              additionalProperties: false,
            },
            handler: async function (args = {}) {
              try {
                // Read per call, not once at setup: multi-user mode can be
                // switched on while a session is alive, and a value captured at
                // setup would keep resolving the legacy null key afterwards.
                const multiUserMode = await SystemSettings.isMultiUserMode();
                return await runCommand({
                  cmd: tool.cmd,
                  payload: args,
                  // `undefined` when the run has no user (a scheduled job).
                  // registry.resolve refuses that outright rather than falling
                  // back to whoever happens to be connected.
                  userId: aibitat?.handlerProps?.invocation?.user_id,
                  multiUserMode,
                });
              } catch (error) {
                // The agent boundary: a throw here would abort the turn. This
                // is where the registry's TypeError stops — reported as the
                // error it is, never as "the browser is not connected".
                const message = error?.message ?? JSON.stringify(error);
                this.super.handlerProps.log(`${tool.name} error: ${message}`);
                this.super.introspect(
                  `${this.caller}: ${tool.name} error: ${message}`
                );
                return `The browser command could not run. Tell the user this error: ${message}`;
              }
            },
          });
        }
      },
    };
  },
};

module.exports = { browserCompanion, runCommand };
