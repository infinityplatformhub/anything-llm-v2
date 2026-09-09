/**
 * Mutation harness for the dispatch layer. Not shipped — run by hand.
 *
 * Applies one edit to a source file, runs the suite, reports whether it went
 * RED. A mutation that stays GREEN is a SURVIVOR: a change to the code that
 * routes every command past the allowlist which no test noticed.
 *
 * Modelled on mutate.mjs (task 6) and carrying its two hard-won lessons:
 *
 *   1. jest writes its "Tests:" summary to STDERR. The first version of the
 *      task 6 harness used execFileSync, saw no summary on a passing run, and
 *      reported every real survivor as an "error". So: spawnSync, both streams.
 *   2. A run with no parseable summary is an ERROR, never a pass or a kill. A
 *      mutation that crashes the module must not read as "no test noticed".
 *
 * SCOPE, stated because it is a deliberate narrowing: this runs only this
 * task's three test files. The full suite was red in this working tree from
 * another agent's in-progress edits to auditLog.js — with those included every
 * mutation would report KILLED and the run would prove nothing, which is the
 * exact failure mode the negative control exists to catch.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const DI = "src/background/dispatch.js";
const CD = "src/background/cdp.js";
const PS = "src/background/pageState.js";
const FILES = [DI, CD, PS];
const TESTS = [
  "__tests__/dispatch.test.js",
  "__tests__/cdp.test.js",
  "__tests__/pageState.test.js",
];

const originals = new Map(FILES.map((f) => [f, readFileSync(f, "utf8")]));
const restore = () => {
  for (const [file, text] of originals) writeFileSync(file, text);
};
// A crash between writing a mutation and restoring it would leave deliberately
// broken code in the working tree — the worst artefact a tool like this can
// produce, because it could be committed.
process.on("exit", restore);

/** @returns {{failed:number, passed:number, raw?:string}} parsed jest summary */
function runSuite() {
  const done = spawnSync(
    process.execPath,
    ["../node_modules/jest/bin/jest.js", ...TESTS],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_OPTIONS: "--experimental-vm-modules" },
    }
  );
  if (done.error) throw done.error;
  const output = `${done.stdout ?? ""}${done.stderr ?? ""}`;
  const summary = output.match(/^Tests:\s+(.*)$/m);
  if (!summary) return { failed: NaN, passed: NaN, raw: output };
  const failed = Number(summary[1].match(/(\d+) failed/)?.[1] ?? 0);
  const passed = Number(summary[1].match(/(\d+) passed/)?.[1] ?? 0);
  return { failed, passed };
}

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
  if (Number.isNaN(failed)) verdict = `ERROR (no summary)\n${raw?.slice(-500)}`;
  else if (failed > 0) verdict = `KILLED by ${failed}`;
  else verdict = "*** SURVIVOR ***";
  results.push({ axis, label, verdict, failed, passed });
  console.log(`${verdict.padEnd(18)} [${axis}] ${label}`);
}

// --- axis: the gate is on the path -----------------------------------------
mutate("gate-path", "gate check removed entirely", DI,
  "for (const url of urls) {\n      if (isAllowed(url, allowlist)) continue;",
  "for (const url of urls) {\n      if (true) continue;");
mutate("gate-path", "gate inverted (deny becomes allow)", DI,
  "if (isAllowed(url, allowlist)) continue;", "if (!isAllowed(url, allowlist)) continue;");
mutate("gate-path", "gate checks only the first url", DI,
  "for (const url of urls) {", "for (const url of urls.slice(0, 1)) {");
mutate("gate-path", "gate checks only the last url", DI,
  "for (const url of urls) {", "for (const url of urls.slice(-1)) {");
mutate("gate-path", "empty resolver result passes vacuously", DI,
  "if (!Array.isArray(urls) || urls.length === 0) {", "if (false) {");
// DECLARED EQUIVALENT (survives, and should). Every resolver in GATE_RESOLVERS
// returns an array today, so dropping the Array.isArray half changes nothing
// observable — the guard is defensive, for a resolver that does not exist yet.
// A test asserts the resolvers' return contract instead ("has every resolver
// return an array of urls"), which is the reachable half of the same property.
// Kept as a mutation so the day a resolver returns something else, this line
// starts being load-bearing and someone sees it named here.
mutate("gate-path", "non-array resolver result is no longer rejected [EQUIVALENT]", DI,
  "if (!Array.isArray(urls) || urls.length === 0) {", "if (urls.length === 0) {");
mutate("gate-path", "tab resolved and attached BEFORE the gate", DI,
  "    const tabId = await d.ensureAgentTab();\n    if (spec.attach) await d.cdp.attach(tabId);",
  "    const tabId = _early;\n    if (spec.attach) await d.cdp.attach(tabId);");
mutate("gate-path", "unknown command falls through to a real handler", DI,
  "  const spec = Object.prototype.hasOwnProperty.call(COMMANDS, cmd)\n    ? COMMANDS[cmd]\n    : null;",
  "  const spec = COMMANDS[cmd] ?? COMMANDS.state;");
mutate("gate-path", "prototype property accepted as a command", DI,
  "Object.prototype.hasOwnProperty.call(COMMANDS, cmd)", "COMMANDS[cmd] !== undefined");
// DECLARED EQUIVALENT (survives, and should). Every command in the real table
// IS gated, so removing the check that proves it changes nothing while the
// table is correct — the assertion exists for the table that does not exist
// yet. Its value is that it fires at LOAD for a future ungated command, which
// "an ungated command is added to the table" above does exercise: that mutation
// adds one and is KILLED. Both halves of the guarantee are therefore covered,
// by two mutations rather than one.
mutate("gate-path", "table assertion bypassed at load [EQUIVALENT]", DI,
  "const COMMANDS = assertCommandTable(COMMAND_TABLE);",
  "const COMMANDS = COMMAND_TABLE;");
mutate("gate-path", "table assertion accepts any gate string", DI,
  "if (!GATE_KINDS.includes(spec.gate)) {", "if (false) {");
mutate("gate-path", "an ungated command is added to the table", DI,
  '  close: {\n    // CONTRACT: page_close closes',
  '  peek: {\n    gate: "currentPage",\n    attach: true,\n    invalidatesMap: false,\n    async run({ tabId, deps }) {\n      return { data: await deps.pageState.capture(tabId) };\n    },\n  },\n\n  close: {\n    // CONTRACT: page_close closes');

// --- axis: which url a command is judged on --------------------------------
mutate("gate-subject", "navigate judged on the current page, not the target", DI,
  '  navigate: {\n    gate: "targetUrl",', '  navigate: {\n    gate: "currentPage",');
mutate("gate-subject", "fetch judged on the target only", DI,
  '  fetch: {\n    gate: "currentAndTargetUrl",', '  fetch: {\n    gate: "currentPage",');
mutate("gate-subject", "fetch judged on the current page only", DI,
  "async currentAndTargetUrl({ command, currentUrl }) {\n    return {\n      urls: [await currentUrl(), requireString(command.url, \"url\")],\n    };",
  "async currentAndTargetUrl({ currentUrl }) {\n    return { urls: [await currentUrl()] };");
// NOTE: this must REPLACE close's gate, not prepend a second `gate` key. An
// earlier version of this mutation did the latter and reported a survivor —
// the later key wins in an object literal, so the "mutation" was inert. A
// textual change is not a semantic one, and this harness cannot tell the
// difference on its own.
mutate("gate-subject", "close is gated on a target url it never has", DI,
  "    // page_navigate (gated on its destination) and then close.\n    gate: \"currentPage\",",
  "    // page_navigate (gated on its destination) and then close.\n    gate: \"targetUrl\",");
mutate("gate-subject", "close falls back to the current page only when convenient", DI,
  "  const spec = Object.prototype.hasOwnProperty.call(COMMANDS, cmd)",
  "  if (cmd === \"close\") return reply(command?.requestId, { ok: true, data: null });\n  const spec = Object.prototype.hasOwnProperty.call(COMMANDS, cmd)");
mutate("gate-subject", "switch judged on the current page, not the matched tab", DI,
  '  switch: {\n    gate: "matchedTab",', '  switch: {\n    gate: "currentPage",');
mutate("gate-subject", "switch acts on a tab it re-finds instead of the gated one", DI,
  "      await deps.switchToTab(target.id);",
  "      const all = await deps.listAgentTabs();\n      await deps.switchToTab(all[all.length - 1].id);");
mutate("gate-subject", "matchedTab returns a url even when nothing matched", DI,
  "return { urls: match ? [match.url] : [], target: match };",
  "return { urls: [match?.url], target: match };");
mutate("gate-subject", "tabs no longer filters the list it returns", DI,
  "const visible = tabs.filter((tab) => isAllowed(tab?.url, allowlist));",
  "const visible = tabs;");

// --- axis: same-origin ------------------------------------------------------
mutate("same-origin", "same-origin check removed", DI,
  "if (spec.sameOrigin && !isSameOrigin(command.url, await currentUrl())) {",
  "if (false) {");
mutate("same-origin", "fetch stops declaring sameOrigin", DI,
  '    gate: "currentAndTargetUrl",\n    sameOrigin: true,',
  '    gate: "currentAndTargetUrl",');
mutate("same-origin", "same-origin compares the target with itself", DI,
  "!isSameOrigin(command.url, await currentUrl())",
  "!isSameOrigin(command.url, command.url)");

// --- axis: untrusted fields -------------------------------------------------
mutate("untrusted", "a non-string url is coerced instead of refused", DI,
  'if (typeof value !== "string" || value.length === 0)',
  "if (false)");
mutate("untrusted", "requireString accepts an empty string", DI,
  'if (typeof value !== "string" || value.length === 0)',
  'if (typeof value !== "string")');
mutate("untrusted", "scroll direction enum no longer enforced", DI,
  "if (!allowed.includes(value))", "if (false)");
mutate("untrusted", "fetch forwards the whole frame to the cdp layer", DI,
  "const body = await deps.cdp.fetch(tabId, command.url);",
  "const body = await deps.cdp.fetch(tabId, command.url, command);");
mutate("untrusted", "cdp.fetchInPage honours a caller-supplied init", CD,
  "export async function fetchInPage(tabId, url) {\n  return await evaluate(\n    tabId,\n    `fetch(${JSON.stringify(String(url))}, { credentials: \"include\", method: \"GET\" })",
  "export async function fetchInPage(tabId, url, init = {}) {\n  return await evaluate(\n    tabId,\n    `fetch(${JSON.stringify(String(url))}, { credentials: \"include\", method: \"GET\", ...${JSON.stringify(init)} })");
mutate("untrusted", "the url is interpolated raw, not as a JSON literal", CD,
  '`fetch(${JSON.stringify(String(url))}, { credentials: "include", method: "GET" })',
  '`fetch("${String(url)}", { credentials: "include", method: "GET" })');
mutate("untrusted", "the typed text is written into the audit log", DI,
  "detail: `id ${command.id}, ${text.length} chars`,",
  "detail: `id ${command.id}, ${text}`,");

// --- axis: audit recording --------------------------------------------------
mutate("audit", "a denial is not recorded", DI,
  "      await d.record({\n        cmd,\n        // Recorded as given, including a non-string: the audit log is where the\n        // user finds out what a misbehaving server tried.\n        url: typeof url === \"string\" ? url : null,\n        outcome: \"denied\",\n        detail: `not in allowlist: ${String(url)}`,\n      });",
  "      void 0;");
mutate("audit", "a success is not recorded", DI,
  'await d.record({ cmd, url: urls[0], outcome: "ok", detail });', "void 0;");
mutate("audit", "an error is not recorded", DI,
  'await d.record({ cmd, url: null, outcome: "error", detail });', "void 0;");
mutate("audit", "a denial is recorded as ok", DI,
  'outcome: "denied",\n        detail: `not in allowlist',
  'outcome: "ok",\n        detail: `not in allowlist');
mutate("audit", "an unknown command is not recorded", DI,
  '    await d.record({\n      cmd: String(cmd),\n      url: null,\n      outcome: "denied",\n      detail: "unknown command",\n    });',
  "    void 0;");

// --- axis: element map / staleness -----------------------------------------
mutate("map", "the map is never invalidated", DI,
  "if (spec.invalidatesMap) d.pageState.invalidate(tabId);", "void 0;");
mutate("map", "click no longer invalidates the map", DI,
  "  click: {\n    gate: \"currentPage\",\n    attach: true,\n    invalidatesMap: true,",
  "  click: {\n    gate: \"currentPage\",\n    attach: true,\n    invalidatesMap: false,");
mutate("map", "a missing element resolves to a default point", DI,
  "  const point = await deps.lookup(tabId, id);\n  if (!point) {", "  const point = (await deps.lookup(tabId, id)) ?? { x: 0, y: 0 };\n  if (false) {");
mutate("map", "the stale-map error stops naming page_state", DI,
  "`No element [${id}] on this page. Call page_state again", "`No element [${id}] not found. Try again");
mutate("map", "lookup coerces its id, so a non-number resolves", PS,
  'if (typeof id !== "number" || !Number.isInteger(id)) return null;\n  return maps.get(tabId)?.get(id) ?? null;',
  "return maps.get(tabId)?.get(Number(id)) ?? null;");
mutate("map", "capture merges into the previous map instead of replacing it", PS,
  "  maps.set(tabId, points);",
  "  for (const [k, v] of maps.get(tabId) ?? []) if (!points.has(k)) points.set(k, v);\n  maps.set(tabId, points);");
mutate("map", "invalidate is a no-op", PS, "  maps.delete(tabId);", "  void tabId;");

// --- axis: cdp attach bookkeeping ------------------------------------------
mutate("cdp", "a failed attach is recorded as attached", CD,
  "  attached.add(tabId);\n}", "}\nfunction _unused(tabId) {\n  attached.add(tabId);\n}");
mutate("cdp", "attach every time, ignoring the existing attachment", CD,
  "  if (attached.has(tabId)) return;\n  try {", "  if (false) return;\n  try {");
mutate("cdp", "onDetach no longer clears the stale attachment", CD,
  "  if (typeof source?.tabId === \"number\") attached.delete(source.tabId);",
  "  void source;");
mutate("cdp", "onDetach listener never registered", CD,
  "globalThis.chrome?.debugger?.onDetach?.addListener?.(handleDetach);", "void handleDetach;");
mutate("cdp", "a rejecting detach leaves the tab in the set", CD,
  "  attached.delete(tabId);\n  try {\n    await chrome.debugger.detach({ tabId });\n  } catch {",
  "  try {\n    await chrome.debugger.detach({ tabId });\n    attached.delete(tabId);\n  } catch {");
mutate("cdp", "the taken-slot error loses its instruction", CD,
  "`Cannot control this tab: something else is already debugging it. Close DevTools on that tab, then try again. (${reason})`",
  "`attach failed`");
mutate("cdp", "a page-side exception is returned as undefined, not thrown", CD,
  "  if (result?.exceptionDetails) {", "  if (false) {");
mutate("cdp", "click skips the mouseMoved that reveals hover targets", CD,
  '  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });\n  await send(tabId, "Input.dispatchMouseEvent", {\n    type: "mousePressed",',
  '  await send(tabId, "Input.dispatchMouseEvent", {\n    type: "mousePressed",');
mutate("cdp", "scroll ignores the direction", CD,
  'const deltaY = direction === "up" ? -SCROLL_DELTA_PX : SCROLL_DELTA_PX;',
  "const deltaY = SCROLL_DELTA_PX;");

// --- axis: dependency defaulting -------------------------------------------
mutate("deps", "a missing cdp method silently becomes a no-op", DI,
  "    cdp: { ...realCdp, ...(deps.cdp ?? {}) },",
  "    cdp: new Proxy({ ...realCdp, ...(deps.cdp ?? {}) }, { get: (t, k) => t[k] ?? (async () => {}) }),");
mutate("deps", "type does not click to focus before typing", DI,
  "      await deps.cdp.click(tabId, point.x, point.y);\n      await deps.cdp.type(tabId, text);",
  "      await deps.cdp.type(tabId, text);");
mutate("deps", "close does not detach before closing the tab", DI,
  "      await deps.cdp.detach(tabId);\n      await deps.closeTab(tabId);",
  "      await deps.closeTab(tabId);");
mutate("deps", "handle rethrows instead of replying", DI,
  "  } catch (error) {\n    const detail = String(error?.message ?? error);",
  "  } catch (error) {\n    if (error) throw error;\n    const detail = String(error?.message ?? error);");

// --- negative control -------------------------------------------------------
// Without this the whole run is worthless: a suite failing for an unrelated
// reason would report every mutation KILLED and prove nothing. Task 6's harness
// bug was caught by exactly this line.
restore();
const control = runSuite();
console.log(
  `\nNEGATIVE CONTROL (unmutated): ${control.failed} failed, ${control.passed} passed` +
    ` -> ${control.failed === 0 ? "PASS as required" : "*** HARNESS INVALID ***"}`
);

const survivors = results.filter((r) => r.verdict.startsWith("***"));
const errors = results.filter((r) => r.verdict.startsWith("ERROR"));
console.log(
  `\n${results.length} mutations: ${
    results.length - survivors.length - errors.length
  } killed, ${survivors.length} survivors, ${errors.length} errors`
);
for (const s of [...survivors, ...errors]) console.log(`  - [${s.axis}] ${s.label}`);
process.exitCode = survivors.length + errors.length + control.failed > 0 ? 1 : 0;
