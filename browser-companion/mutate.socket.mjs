/**
 * Mutation harness for socket.js + index.js. Not shipped — run by hand.
 *
 * Applies one edit, runs the suite, reports whether it went RED. A mutation
 * that stays GREEN is a SURVIVOR: a change no test noticed.
 *
 * THIS BRANCH HAS HAD FOUR HARNESSES LIE, so this one carries its own controls
 * and every failure mode is loud rather than silent:
 *
 *   1. NEGATIVE CONTROL, first: the unmutated suite must PASS. A harness that
 *      reports kills against an already-red suite is measuring nothing. (One
 *      earlier harness on this branch read every real survivor as ERROR because
 *      jest writes its summary to STDERR and it used execFileSync, which
 *      returns only stdout. Hence spawnSync and the merged streams below.)
 *   2. POSITIVE CONTROL, last: a mutation that MUST be killed. If it survives,
 *      the harness is not actually running the tests it thinks it is.
 *   3. An anchor that appears zero times, or more than once, throws. A mutation
 *      that leaves the file byte-identical throws — one earlier harness scored a
 *      semantically inert edit (a duplicate object key, where the later key
 *      wins) as a kill.
 *   4. No parseable summary is an ERROR, never a pass and never a kill: a
 *      mutation that crashes jest must not read as "no test noticed".
 *   5. maxBuffer is raised: an earlier run died with ENOBUFS mid-run and read as
 *      infrastructure failure rather than as a kill.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SOCK = "src/background/socket.js";
const IDX = "src/background/index.js";
const originals = new Map(
  [SOCK, IDX].map((file) => [file, readFileSync(file, "utf8")])
);
const restore = () => {
  for (const [file, text] of originals) writeFileSync(file, text);
};
// A crash between writing a mutation and restoring it would leave deliberately
// broken code in the working tree — the worst possible artefact of a tool like
// this, because it could be committed.
process.on("exit", restore);

/** @returns {{failed:number, passed:number, raw?:string}} */
function runSuite() {
  const done = spawnSync(
    process.execPath,
    [
      "../node_modules/jest/bin/jest.js",
      "__tests__/socket.test.js",
      // index.js is measured too. Without this suite four wiring mutations
      // survived outright -- the wiring is only observable from a file that
      // imports index.js, and nothing did.
      "__tests__/background.test.js",
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: "--experimental-vm-modules" },
    }
  );
  if (done.error) throw done.error;
  // Both streams: jest writes the summary to stderr.
  const output = `${done.stdout ?? ""}${done.stderr ?? ""}`;
  const summary = output.match(/^Tests:\s+(.*)$/m);
  if (!summary) return { failed: NaN, passed: NaN, raw: output };
  const failed = Number(summary[1].match(/(\d+) failed/)?.[1] ?? 0);
  const passed = Number(summary[1].match(/(\d+) passed/)?.[1] ?? 0);

  // HARNESS LIE #5, CAUGHT BY THIS HARNESS'S OWN POSITIVE CONTROL RUN AND
  // FIXED HERE. A mutation that makes the file a SYNTAX ERROR stops jest before
  // any test runs, and jest still prints a summary line — "Tests: 0 total". The
  // regex above then reads `failed: 0` and the verdict is SURVIVOR: the loudest
  // possible failure scored as the quietest possible result. `Tests:` alone is
  // therefore NOT a sufficient instrument; the suite-level line has to be read
  // too, and a run in which nothing executed is an ERROR, never a pass.
  const suites = output.match(/^Test Suites:\s+(.*)$/m);
  const suitesFailed = Number(suites?.[1].match(/(\d+) failed/)?.[1] ?? 0);
  if (passed === 0 && failed === 0)
    return { failed: NaN, passed: NaN, raw: output };
  // A suite that failed to LOAD (rather than tests failing inside it) is also
  // not a kill by this suite's coverage — it is a mutation that broke the
  // module. Distinguished so it cannot be miscounted either way.
  if (suitesFailed > 0 && failed === 0)
    return { failed: NaN, passed: NaN, raw: output };
  return { failed, passed };
}

// --- NEGATIVE CONTROL -------------------------------------------------------
const control = runSuite();
if (Number.isNaN(control.failed)) {
  console.error("NEGATIVE CONTROL: no jest summary — the harness cannot measure anything.");
  console.error(control.raw?.slice(-2000));
  process.exit(2);
}
if (control.failed !== 0) {
  console.error(
    `NEGATIVE CONTROL FAILED: the unmutated suite is already red (${control.failed} failed). Every "kill" below would be meaningless.`
  );
  process.exit(2);
}
console.log(`NEGATIVE CONTROL ok: unmutated suite passes ${control.passed} tests.\n`);

const results = [];
function mutate(axis, label, file, from, to) {
  const source = originals.get(file);
  const count = source.split(from).length - 1;
  if (count !== 1)
    throw new Error(
      `mutation "${label}" anchors ${count} times in ${file}; must be exactly 1`
    );
  const mutated = source.replace(from, to);
  if (mutated === source) throw new Error(`mutation "${label}" is a no-op`);
  writeFileSync(file, mutated);

  const { failed, passed, raw } = runSuite();
  restore();

  let verdict;
  if (Number.isNaN(failed)) verdict = `ERROR (no summary)\n${raw?.slice(-600)}`;
  else if (failed > 0) verdict = `KILLED by ${failed}`;
  else verdict = "*** SURVIVOR ***";
  results.push({ axis, label, verdict, failed, passed });
  console.log(`${verdict.padEnd(18)} [${axis}] ${label}`);
}

// --- axis: the credential transport ----------------------------------------
mutate("handshake", "key first, marker second (echoes the key back)", SOCK,
  "ws = new WebSocket(url, [COMPANION_SUBPROTOCOL, apiKey]);",
  "ws = new WebSocket(url, [apiKey, COMPANION_SUBPROTOCOL]);");
mutate("handshake", "offer no subprotocol at all", SOCK,
  "ws = new WebSocket(url, [COMPANION_SUBPROTOCOL, apiKey]);",
  "ws = new WebSocket(url);");
mutate("handshake", "put the key back in the query string", SOCK,
  "url = socketUrlFor(apiBase);",
  "url = wsUrlFor(apiBase, apiKey);");
mutate("handshake", "marker string drifts from the server's", SOCK,
  'const COMPANION_SUBPROTOCOL = "anythingllm-browser-companion";',
  'const COMPANION_SUBPROTOCOL = "anythingllm-companion";');
mutate("handshake", "socket path drifts from the server's route", SOCK,
  'const SOCKET_PATH = "browser-companion/agent-socket";',
  'const SOCKET_PATH = "browser-companion/socket";');
mutate("handshake", "stop rejecting a key that is not a token", SOCK,
  "if (!HTTP_TOKEN.test(apiKey)) {", "if (false) {");

// --- axis: url building -----------------------------------------------------
mutate("url", "https no longer upgrades to wss", SOCK,
  'base.protocol = base.protocol === "https:" ? "wss:" : "ws:";',
  'base.protocol = "ws:";');
mutate("url", "drop the trailing-slash re-add (loses the /api prefix)", SOCK,
  'const base = new URL(String(apiBase).replace(/\\/+$/, "") + "/");',
  "const base = new URL(String(apiBase));");
mutate("url", "concatenate the key instead of encoding it", SOCK,
  'url.searchParams.set("key", apiKey);',
  'url.search = `?key=${apiKey}`;');

// --- axis: close-code handling ---------------------------------------------
mutate("close", "4409 becomes retryable (the two-client fight)", SOCK,
  "  [\n    CLOSE_EVICTED,\n    {\n      status: \"evicted\",",
  "  [\n    9999,\n    {\n      status: \"evicted\",");
mutate("close", "4401 becomes retryable", SOCK,
  "  [\n    CLOSE_UNAUTHORIZED,\n    {\n      status: \"unauthorized\",",
  "  [\n    9998,\n    {\n      status: \"unauthorized\",");
mutate("close", "4403 becomes retryable", SOCK,
  "  [\n    CLOSE_FORBIDDEN,\n    {\n      status: \"unauthorized\",",
  "  [\n    9997,\n    {\n      status: \"unauthorized\",");
mutate("close", "every close is terminal, so 1011 never retries", SOCK,
  "const terminal = TERMINAL_CLOSES.get(event?.code);",
  "const terminal = TERMINAL_CLOSES.get(event?.code) ?? TERMINAL_CLOSES.get(CLOSE_EVICTED);");
mutate("close", "terminal close still schedules a reconnect", SOCK,
  "      config = null;",
  "      scheduleReconnect();");
mutate("close", "the evicted frame no longer sets the state", SOCK,
  'if (message?.event === "evicted") {', "if (false) {");
mutate("close", "keepalive resurrects an evicted connection", SOCK,
  'if (status === "evicted" || status === "unauthorized") {\n    // Terminal.',
  'if (false) {\n    // Terminal.');

// --- axis: backoff ----------------------------------------------------------
mutate("backoff", "no backoff — retry immediately, forever", SOCK,
  "  const delay = ceiling / 2 + Math.random() * (ceiling / 2);",
  "  const delay = 0;");
mutate("backoff", "no exponent — a fixed retry interval", SOCK,
  "reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);",
  "reconnectDelay = RECONNECT_BASE_MS;");
mutate("backoff", "no jitter — every client retries in lockstep", SOCK,
  "  const delay = ceiling / 2 + Math.random() * (ceiling / 2);",
  "  const delay = ceiling;");
mutate("backoff", "a successful open no longer resets the delay", SOCK,
  "    reconnectDelay = RECONNECT_BASE_MS;\n  };",
  "  };");

// --- axis: the keepalive alarm ---------------------------------------------
mutate("alarm", "period rises to the packed-extension floor", SOCK,
  "const KEEPALIVE_MINUTES = MV3_IDLE_TEARDOWN_SECONDS / 60 / 2;",
  "const KEEPALIVE_MINUTES = 1;");
mutate("alarm", "period is exactly the teardown window, too slow to help", SOCK,
  "const KEEPALIVE_MINUTES = MV3_IDLE_TEARDOWN_SECONDS / 60 / 2;",
  "const KEEPALIVE_MINUTES = MV3_IDLE_TEARDOWN_SECONDS / 60;");
mutate("alarm", "alarm armed only after the socket opens", SOCK,
  "  status = \"connecting\";\n  armKeepalive();",
  "  status = \"connecting\";");
mutate("alarm", "keepalive only pings and never reconnects", SOCK,
  "  if (ping()) return true;\n  if (!config) return false;\n  void connect(config);\n  return true;",
  "  return ping();");
mutate("alarm", "keepalive claims success on a cold wake", SOCK,
  "  if (!config) return false;", "  if (!config) return true;");

// --- axis: the send guard ---------------------------------------------------
mutate("send", "send without checking readyState (browser drops it silently)", SOCK,
  "  if (!ws || ws.readyState !== WS_OPEN) return false;",
  "  if (!ws) return false;");
mutate("send", "OPEN is the wrong readyState value", SOCK,
  "const WS_OPEN = 1;", "const WS_OPEN = 0;");
mutate("send", "reply on the current socket, not the one it arrived on", SOCK,
  "      if (!sendOn(ws, result)) {", "      if (!sendOn(socket, result)) {");
mutate("send", "sendOn reports success even when it wrote nothing", SOCK,
  "  if (!ws || ws.readyState !== WS_OPEN) return false;",
  "  if (!ws || ws.readyState !== WS_OPEN) return true;");

// --- axis: the tab binding (the task-7 coupling) ---------------------------
mutate("tabbind", "ensureAgentTab stops checking the gated tab", SOCK,
  "  if (boundTabId !== null && boundTabId !== tab.id) {",
  "  if (false) {");
mutate("tabbind", "agentTabUrl no longer records which tab it judged", SOCK,
  "  boundTabId = tab.id;\n  return tab.url;",
  "  return tab.url;");
mutate("tabbind", "the binding is never cleared between commands", SOCK,
  "function beginCommandScope() {\n  boundTabId = null;\n}",
  "function beginCommandScope() {\n}");
mutate("tabbind", "binding compares loosely, so null matches any tab", SOCK,
  "  if (boundTabId !== null && boundTabId !== tab.id) {",
  "  if (boundTabId != null && boundTabId == tab.id) {");

// --- axis: the agent tab ----------------------------------------------------
mutate("tab", "concurrent callers each open a tab", SOCK,
  "  if (!resolving) {\n    resolving = doResolveAgentTab().finally(() => {\n      resolving = null;\n    });\n  }\n  return resolving;",
  "  return doResolveAgentTab();");
mutate("tab", "the agent takes over the user's active tab", SOCK,
  "chrome.tabs.create({ url: BLANK_URL, active: false })",
  "chrome.tabs.create({ url: BLANK_URL, active: true })");
mutate("tab", "switchToTab focuses without adopting", SOCK,
  "  await chrome.tabs.update(tabId, { active: true });\n  agentTabId = tabId;",
  "  await chrome.tabs.update(tabId, { active: true });");
// NOT MUTATED after F1-R, and recorded rather than quietly dropped. Chrome
// fires onRemoved for extension-initiated removals too, so `handleTabRemoved`
// has already cleared `agentTabId` and `createdTabIds` by the time `closeTab`
// returns — removing either line changes nothing observable. Equivalent
// mutants, not coverage gaps; scoring them as survivors would be noise.
// `closeTab`'s own comment says why the lines stay anyway, and its `boundTabId`
// line is NOT redundant (the listener deliberately does not touch it) and is
// covered by the gate-binding cases.
mutate("tab", "a tab with no url reports the empty string", SOCK,
  'return typeof tab?.url === "string" && tab.url ? tab.url : BLANK_URL;',
  "return tab?.url;");
// Replaced after F1. This axis used to assert the OPPOSITE — that listAgentTabs
// must not filter at all — which was the contract before ownership became a
// capability boundary. The narrowing it now performs is required, so the
// mutation worth running is one that narrows it to the WRONG set: current-tab
// only, which would silently break page_switch and page_tabs while still
// looking like "the agent's tabs".
mutate("tab", "listAgentTabs reports only the current tab, not every owned tab", SOCK,
  "    .filter((tab) => typeof tab?.id === \"number\" && createdTabIds.has(tab.id))",
  "    .filter((tab) => typeof tab?.id === \"number\" && tab.id === agentTabId)");

// --- axis: command serialisation -------------------------------------------
mutate("queue", "commands run concurrently", SOCK,
  "  commandQueue = commandQueue\n    .then(run)",
  "  commandQueue = Promise.resolve()\n    .then(run)");
mutate("queue", "a thrown handler poisons the queue forever", SOCK,
  "    .catch((error) => {",
  "    .finally((error) => {");
mutate("queue", "the per-command scope reset moves out of the queue", SOCK,
  "    enqueueCommand(async () => {\n      // One command at a time, so this reset cannot land between another\n      // command's gate check and its action.\n      beginCommandScope();",
  "    beginCommandScope();\n    enqueueCommand(async () => {");

// --- axis: connect idempotency ---------------------------------------------
mutate("connect", "every call opens another socket", SOCK,
  "  if (sameConfig && alive) return;", "  if (false) return;");
mutate("connect", "a changed config reuses the old socket", SOCK,
  "  const sameConfig =\n    config?.apiBase === apiBase && config?.apiKey === apiKey;",
  "  const sameConfig = true;");
mutate("connect", "stale socket events still mutate live state", SOCK,
  "  ws.onclose = (event) => {\n    if (socket !== ws) return;",
  "  ws.onclose = (event) => {");
mutate("connect", "a malformed apiBase leaves the worker in connecting", SOCK,
  "  } catch {\n    return setIdle(\n      `\"${apiBase}\" is not a valid AnythingLLM server address. Check it in the extension's settings.`\n    );\n  }",
  "  } catch {\n    url = String(apiBase);\n  }");

// --- axis: index.js wiring --------------------------------------------------
mutate("wiring", "drop listAgentTabs from deps", IDX,
  "  listAgentTabs: socket.listAgentTabs,\n", "");
mutate("wiring", "drop closeTab from deps", IDX,
  "  closeTab: socket.closeTab,\n", "");
mutate("wiring", "pass isAllowed through deps (defeats the boundary)", IDX,
  "const deps = {\n  loadAllowlist,",
  "const deps = {\n  isAllowed: () => true,\n  loadAllowlist,");
mutate("wiring", "agentTabUrl and ensureAgentTab come from different sources", IDX,
  "  ensureAgentTab: socket.ensureAgentTab,",
  "  ensureAgentTab: async () => (await chrome.tabs.create({ url: \"about:blank\" })).id,");

// --- axis: a rejecting command handler (defect 2) --------------------------
mutate("reject", "a rejecting handler kills the socket again", SOCK,
  "      } catch (error) {\n        result = replyForFailedCommand(message, error);",
  "      } catch (error) {\n        throw error;\n        result = replyForFailedCommand(message, error);");
mutate("reject", "a rejection is answered as a success", SOCK,
  "    requestId,\n    ok: false,\n    error: `The browser extension could not complete",
  "    requestId,\n    ok: true,\n    error: `The browser extension could not complete");
mutate("reject", "a rejection is answered with no requestId", SOCK,
  "  return {\n    requestId,\n    ok: false,",
  "  return {\n    requestId: undefined,\n    ok: false,");
mutate("reject", "an id-less frame is answered anyway", SOCK,
  "  if (requestId === undefined || requestId === null) {",
  "  if (false) {");
mutate("reject", "the reply drops the unknown-outcome warning", SOCK,
  "The action may or may not have taken effect",
  "The action failed");
mutate("reject", "an untrusted throw message is echoed unbounded", SOCK,
  "String(error?.message ?? error).slice(0, MAX_ECHOED_CHARS)",
  "String(error?.message ?? error)");

// --- axis: the derived accessor contract (defect 1) ------------------------
mutate("contract", "listAgentTabs dropped, as the brief specified", IDX,
  "  listAgentTabs: socket.listAgentTabs,\n", "");
mutate("contract", "switchToTab dropped, as the brief specified", IDX,
  "  switchToTab: socket.switchToTab,\n", "");

// --- axis: durable terminal verdict (M1) -----------------------------------
mutate("durable", "the terminal verdict is never written", SOCK,
  "      void rememberTerminal(apiKey, terminal.status, terminal.error);", "");
mutate("durable", "the stored verdict is never consulted on a cold wake", SOCK,
  "  if (!config) {\n    const verdict = await terminalVerdictFor(apiKey);",
  "  if (false) {\n    const verdict = await terminalVerdictFor(apiKey);");
mutate("durable", "a verdict for ANY key blocks this one", SOCK,
  "  if (stored.key !== key) {", "  if (false) {");
mutate("durable", "the raw key is stored instead of a fingerprint", SOCK,
  "  const key = await fingerprint(apiKey);\n  if (!key) return;\n  try {",
  "  const key = apiKey;\n  if (!key) return;\n  try {");
mutate("durable", "a terminal close leaves config set, so keepalive rebuilds it", SOCK,
  "      config = null;\n      // Durable, so the next worker honours this verdict too.",
  "      // Durable, so the next worker honours this verdict too.");
mutate("durable", "a storage read failure blocks the connection instead of failing open", SOCK,
  "  } catch {\n    // A read failure must not block a connection: failing OPEN is right here,",
  "  } catch {\n    return { status: \"evicted\", error: \"blocked\" };\n    // A read failure must not block a connection: failing OPEN is right here,");
mutate("durable", "clearTerminalVerdict removes nothing", SOCK,
  "    await chrome.storage.local.remove(TERMINAL_STORAGE_KEY);\n    return true;",
  "    return true;");

// --- axis: orphan tab cleanup (L1) ------------------------------------------
mutate("orphan", "the abandoned tab is left open", SOCK,
  "  if (abandoned !== null && abandoned !== tabId) await discardIfUnused(abandoned);",
  "");
// NOT MUTATED, and recorded rather than quietly dropped: the ownership check at
// the top of discardIfUnused is UNREACHABLE since F1 — switchToTab, its only
// caller, refuses an unowned tab first — so removing it is an equivalent mutant
// and would always survive. Scoring it as a survivor would be noise. Its own
// comment explains why the line stays anyway.
mutate("orphan", "cleanup ignores whether the agent used the tab", SOCK,
  "    if (tabUrl(tab) !== BLANK_URL) return; // The agent used it; leave it.",
  "    // The agent used it; leave it.");
mutate("orphan", "created tabs are never remembered", SOCK,
  "  createdTabIds.add(created.id);", "");

// --- axis: index.js listener bodies (M2/L2/L3) ------------------------------
mutate("listener", "the wrong storage keys are read", IDX,
  'export const CONFIG_KEYS = Object.freeze(["apiBase", "apiKey"]);',
  'export const CONFIG_KEYS = Object.freeze(["nope"]);');
mutate("listener", "the storage listener watches local instead of sync", IDX,
  'if (area === "sync" && (changes?.apiBase || changes?.apiKey))',
  'if (area === "local" && (changes?.apiBase || changes?.apiKey))');
mutate("listener", "the alarm-name guard is inverted", IDX,
  "if (alarm?.name !== socket.KEEPALIVE_ALARM) return;",
  "if (alarm?.name === socket.KEEPALIVE_ALARM) return;");
mutate("listener", "the top-level startCompanion() is deleted", IDX,
  "\nstartCompanion();\n", "\n");
mutate("listener", "the cold-wake fallback is dropped", IDX,
  "  if (!socket.keepalive()) startCompanion();", "  socket.keepalive();");
mutate("listener", "a storage failure escapes as an unhandled rejection", IDX,
  "  } catch (error) {\n    // A rejected `storage.sync.get`",
  "  } finally {\n    // A rejected `storage.sync.get`");

// The L4 mutation, retired for the same reason as the one above: after F1-R the
// onRemoved listener drops the id first, so closeTab's own delete is no longer
// the thing that protects a recycled id. What protects it now is the listener,
// and the `stale` axis mutates that directly. Keeping this one would score an
// equivalent mutant as a survivor and hide the real coverage question.
mutate("orphan", "a mid-navigation tab is treated as unused", SOCK,
  '    if (typeof pending === "string" && pending && pending !== BLANK_URL) return;',
  "");
mutate("orphan", "a pending navigation to about:blank spares the tab", SOCK,
  '    if (typeof pending === "string" && pending && pending !== BLANK_URL) return;',
  '    if (typeof pending === "string") return;');

// --- axis: tab ownership (F1) ----------------------------------------------
mutate("ownership", "listAgentTabs reports every tab in the browser again", SOCK,
  '    .filter((tab) => typeof tab?.id === "number" && createdTabIds.has(tab.id))',
  '    .filter((tab) => typeof tab?.id === "number")');
mutate("ownership", "switchToTab adopts any tab it is handed", SOCK,
  "  if (!createdTabIds.has(tabId)) {\n    throw new Error(",
  "  if (false) {\n    throw new Error(");
// Re-anchored for F1-R: the lazy catch no longer inlines the forget, it calls
// `handleTabRemoved`. This mutation now removes the BACKSTOP — the case where
// no listener ran at all (a teardown between the close and the next lookup).
mutate("ownership", "the lazy backstop stops forgetting a vanished tab", SOCK,
  "      handleTabRemoved(agentTabId);",
  "      agentTabId = null;");

// --- axis: the null-reply convention (F3) ----------------------------------
mutate("nullreply", "a null reply is stringified onto the wire", SOCK,
  "      if (result === null || result === undefined) return;",
  "");
mutate("nullreply", "only undefined is treated as no-reply", SOCK,
  "      if (result === null || result === undefined) return;",
  "      if (result === undefined) return;");

// --- axis: stale tab ids (F1-R) --------------------------------------------
mutate("stale", "no onRemoved listener at all", SOCK,
  "globalThis.chrome?.tabs?.onRemoved?.addListener?.(handleTabRemoved);",
  "// no listener");
mutate("stale", "removal drops the current handle but not the grant", SOCK,
  "  createdTabIds.delete(tabId);\n  if (agentTabId === tabId) agentTabId = null;",
  "  if (agentTabId === tabId) agentTabId = null;");
mutate("stale", "removal drops the grant but not the current handle", SOCK,
  "  createdTabIds.delete(tabId);\n  if (agentTabId === tabId) agentTabId = null;",
  "  createdTabIds.delete(tabId);");
mutate("stale", "removal clears the gate binding, erasing the mismatch evidence", SOCK,
  "  if (agentTabId === tabId) agentTabId = null;\n}",
  "  if (agentTabId === tabId) agentTabId = null;\n  if (boundTabId === tabId) boundTabId = null;\n}");
// NOT MUTATED: the `typeof tabId !== "number"` guard in handleTabRemoved is
// INERT and removing it survives. Driven and confirmed rather than assumed —
// `Set.delete` and `===` already reject every non-numeric value, and when a tab
// is held `agentTabId` is a number, so there is no null-matches-null case (my
// first justification for the guard, and it was wrong). The behaviour is still
// pinned by tests; the guard is one cheap line on a listener fed by an external
// event source, and it becomes load-bearing the moment this function grows a
// Map lookup or a `find`.

// --- POSITIVE CONTROL -------------------------------------------------------
// Must be KILLED. If this survives, the harness is not running these tests and
// every verdict above is worthless.
mutate("CONTROL", "POSITIVE CONTROL: state() always reports online", SOCK,
  "  return { status, lastError };",
  '  return { status: "online", lastError: null };');

// --- INSTRUMENT CONTROL -----------------------------------------------------
// Must read ERROR, not SURVIVOR and not KILLED. This is the control for the
// harness's OWN instrument: a mutation that makes the module unparseable stops
// jest before any test runs, and jest still prints "Tests: 0 total" — which the
// naive `failed === 0` reading scores as a survivor. This run is what proves
// the `passed === 0 && failed === 0` guard in runSuite is actually working.
mutate("CONTROL", "INSTRUMENT CONTROL: a syntax error must read ERROR", SOCK,
  "export function state() {", "export function state( {");

/* ------------------------------------------------------------------------- */
const survivors = results.filter((r) => r.verdict.includes("SURVIVOR"));
const errors = results.filter((r) => r.verdict.startsWith("ERROR"));
const positive = results.find((r) => r.label.startsWith("POSITIVE CONTROL"));
const instrument = results.find((r) => r.label.startsWith("INSTRUMENT CONTROL"));

console.log(`\n${"=".repeat(72)}`);
console.log(`total ${results.length}   killed ${results.length - survivors.length - errors.length}   survivors ${survivors.length}   errors ${errors.length}`);
console.log(
  `POSITIVE CONTROL:   ${positive?.verdict.includes("KILLED") ? "ok (killed)" : "*** BROKEN — the harness is not measuring these tests ***"}`
);
console.log(
  `INSTRUMENT CONTROL: ${instrument?.verdict.startsWith("ERROR") ? "ok (read as ERROR)" : "*** BROKEN — a syntax error is not being distinguished from a survivor ***"}`
);
if (survivors.length) {
  console.log("\nSURVIVORS:");
  for (const s of survivors) console.log(`  [${s.axis}] ${s.label}`);
}
if (errors.length) {
  console.log("\nERRORS:");
  for (const e of errors) console.log(`  [${e.axis}] ${e.label}`);
}
