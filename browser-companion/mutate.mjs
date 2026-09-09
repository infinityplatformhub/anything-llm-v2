/**
 * Mutation harness. Not shipped — a verification tool, run by hand.
 *
 * Applies one edit to a source file, runs the suite, and reports whether the
 * suite went RED. A mutation that stays GREEN is a SURVIVOR: a change to the
 * security gate that no test noticed.
 *
 * Written in node rather than bash on purpose. The bash version of this had the
 * exact failure it exists to catch: the replacement text was interpolated into
 * `perl -pe`, so it needed hand-escaping and would have silently corrupted some
 * mutations. Here `from`/`to` are plain strings and nothing re-parses them.
 *
 * Every way this can fail to do its job is loud:
 *   - a `from` that does not appear, or appears more than once, throws
 *   - a mutation that leaves the file byte-identical throws
 *   - a jest run with no parseable summary is reported as an ERROR, never as a
 *     pass or a kill; a crashing mutation must not read as "no test noticed"
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const AL = "src/background/allowlist.js";
const AU = "src/background/auditLog.js";
const originals = new Map([AL, AU].map((f) => [f, readFileSync(f, "utf8")]));
const restore = () => {
  for (const [file, text] of originals) writeFileSync(file, text);
};
// A crash between writing a mutation and restoring it would leave deliberately
// broken code in the working tree, which is the worst possible artefact of a
// tool like this -- it could be committed. `exit` fires for a thrown error and
// for a signal-free termination alike.
process.on("exit", restore);

/** @returns {{failed:number, passed:number}} parsed jest summary */
function runSuite() {
  // spawnSync, not execFileSync: jest prints its "Tests:" summary to STDERR, and
  // execFileSync returns only stdout on success. The first version of this
  // harness used it and so found no summary on a PASSING run -- reporting every
  // real survivor as an "error". That is the same class of lying gate this file
  // exists to detect, caught by its own negative control.
  // Scoped to this task's four suites. Task 7's tests land in the same package
  // while in flight, and a mutation to allowlist.js can turn THOSE red for
  // reasons that say nothing about this suite's coverage -- which would count as
  // a kill here and hide a real survivor.
  const done = spawnSync(
    process.execPath,
    [
      "../node_modules/jest/bin/jest.js",
      "__tests__/allowlist.test.js",
      "__tests__/allowlistStorage.test.js",
      "__tests__/auditLog.test.js",
      "__tests__/manifest.test.js",
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // A mutation can make a suite fail loudly enough to overflow the default
      // 1MB pipe buffer, which surfaces as ENOBUFS and kills the whole run
      // rather than reporting that mutation. Only the "Tests:" line is read, but
      // the buffer has to hold everything printed before it.
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: "--experimental-vm-modules" },
    }
  );
  if (done.error) throw done.error;
  const output = `${done.stdout ?? ""}${done.stderr ?? ""}`;
  const summary = output.match(/^Tests:\s+(.*)$/m);
  // No summary at all means jest never ran the tests (a syntax error in the
  // mutated file, say). Silence is not evidence of anything, so it is an error.
  if (!summary) return { failed: NaN, passed: NaN, raw: output };
  const failed = Number(summary[1].match(/(\d+) failed/)?.[1] ?? 0);
  const passed = Number(summary[1].match(/(\d+) passed/)?.[1] ?? 0);
  return { failed, passed };
}

const results = [];
function mutate(axis, label, file, from, to) {
  const source = originals.get(file);
  const count = source.split(from).length - 1;
  if (count !== 1) {
    throw new Error(
      `mutation "${label}" anchors ${count} times in ${file}; must be exactly 1`
    );
  }
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

// --- axis: scheme -----------------------------------------------------------
mutate("scheme", "accept every scheme", AL,
  "if (!ALLOWED_SCHEMES.has(parsed.protocol)) return false;\n    // `hostname`",
  "if (false) return false;\n    // `hostname`");
mutate("scheme", "add file: to the allowed schemes", AL,
  'new Set(["http:", "https:"]);', 'new Set(["http:", "https:", "file:"]);');
mutate("scheme", "isSameOrigin stops refusing opaque origins", AL,
  "if (!schemesOk) return false;", "if (false) return false;");
mutate("scheme", "isSameOrigin checks only the left operand", AL,
  "const schemesOk = [left, right].every((u) =>\n      ALLOWED_SCHEMES.has(u.protocol)\n    );",
  "const schemesOk = ALLOWED_SCHEMES.has(left.protocol);");
mutate("scheme", "isSameOrigin checks only the right operand", AL,
  "const schemesOk = [left, right].every((u) =>\n      ALLOWED_SCHEMES.has(u.protocol)\n    );",
  "const schemesOk = ALLOWED_SCHEMES.has(right.protocol);");
mutate("scheme", "isSameOrigin compares host instead of origin", AL,
  "return left.origin === right.origin;", "return left.hostname === right.hostname;");

// --- axis: host form --------------------------------------------------------
mutate("host", "match on host (incl. port) instead of hostname", AL,
  "host = canonicalHost(parsed.hostname);\n  } catch",
  "host = canonicalHost(parsed.host);\n  } catch");
mutate("host", "match the raw url as a substring, not the parsed host", AL,
  "return host === entry.host;\n  });",
  "return url.toLowerCase().includes(entry.host);\n  });");
mutate("host", "wildcard drops the separating dot (suffix match)", AL,
  "host.endsWith(`.${entry.host}`)", "host.endsWith(entry.host)");
mutate("host", "wildcard becomes a substring match", AL,
  "return host === entry.host || host.endsWith(`.${entry.host}`);",
  "return host.includes(entry.host);");
mutate("host", "plain entry becomes a suffix match", AL,
  "return host === entry.host;\n  });", "return host.endsWith(entry.host);\n  });");
mutate("host", "wildcard no longer covers the bare base", AL,
  "return host === entry.host || host.endsWith(`.${entry.host}`);",
  "return host.endsWith(`.${entry.host}`);");

// --- axis: case / unicode ---------------------------------------------------
mutate("case", "drop trim(), so a padded entry is silently discarded", AL,
  "let candidate = raw.trim();", "let candidate = raw;");
mutate("unicode", "stop trimming the DNS root dot", AL,
  'return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;',
  "return hostname;");
mutate("unicode", "trim every trailing dot, collapsing linkedin.com.. to a match", AL,
  'return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;',
  'return hostname.replace(/\\.+$/, "");');
mutate("unicode", "reject the DNS root form outright instead of folding it", AL,
  'return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;',
  'return hostname.endsWith(".") ? "" : hostname;');
mutate("unicode", "compare entries as raw strings, skipping IDNA", AL,
  "parsed = new URL(`https://${candidate}`);",
  "parsed = { href: `https://${candidate}/`, host: candidate, hostname: candidate };");

// --- axis: port -------------------------------------------------------------
mutate("port", "entry keeps its port instead of being rejected", AL,
  "if (parsed.host !== parsed.hostname) return null;", "if (false) return null;");

// --- axis: empty / missing / malformed list ---------------------------------
mutate("list", "empty list means allow everything", AL,
  "if (!Array.isArray(allowlist) || allowlist.length === 0) return false;",
  "if (!Array.isArray(allowlist)) return false;\n  if (allowlist.length === 0) return true;");
mutate("list", "non-array list is no longer rejected", AL,
  "if (!Array.isArray(allowlist) || allowlist.length === 0) return false;",
  "if (allowlist && allowlist.length === 0) return false;");
mutate("list", "coerce non-string entries instead of rejecting", AL,
  'if (typeof raw !== "string") return null;', "raw = String(raw);");
mutate("list", "allow a bare star as allow-everything", AL,
  'if (!candidate || candidate.includes("*")) return null;',
  'if (!candidate) return null;');
mutate("list", "entry dot-shape guard dropped entirely", AL,
  'if (!host || host.startsWith(".") || host.endsWith(".")) return null;',
  "if (false) return null;");
mutate("list", "entry guard stops rejecting an empty host", AL,
  'if (!host || host.startsWith(".")', 'if (host.startsWith(".")');
mutate("list", "entry guard stops rejecting a leading dot", AL,
  'host.startsWith(".") || host.endsWith(".")', 'host.endsWith(".")');
mutate("list", "entry guard stops rejecting a trailing dot", AL,
  ' || host.endsWith(".")) return null;', ") return null;");
mutate("list", "drop the round-trip check on entries", AL,
  "if (parsed.href !== `https://${parsed.host}/`) return null;", "if (false) return null;");
mutate("list", "non-string url is no longer rejected", AL,
  'if (typeof url !== "string") return false;', "");
mutate("list", "malformed url throws instead of denying", AL,
  "  } catch {\n    return false;\n  }\n  // No empty-host guard here on purpose.",
  "  } catch (e) { throw e; }\n  // No empty-host guard here on purpose.");
mutate("list", "loadAllowlist returns the raw stored value", AL,
  "return Array.isArray(list) ? list : [];", "return list;");

// --- axis: auditLog ---------------------------------------------------------
mutate("audit", "drop the write chain (concurrent writes race)", AU,
  "const append = writeChain.then(async () => {", "const append = (async () => {");
mutate("audit", "chain poisoned by a failed write", AU,
  "writeChain = append.catch(() => {});", "writeChain = append;");
mutate("audit", "no entry cap", AU, "entries.slice(-MAX_ENTRIES)", "entries");
mutate("audit", "cap keeps the oldest instead of the newest", AU,
  "entries.slice(-MAX_ENTRIES)", "entries.slice(0, MAX_ENTRIES)");
mutate("audit", "every field is always truncated", AU,
  "  if (serialisedBytes(text) <= limitBytes) return text;",
  "  if (false) return text;");

// --- axis: uncapped fields (the reviewed MEDIUM finding) --------------------
mutate("cap", "url is left uncapped", AU,
  "url: cap(url, MAX_URL_BYTES),", "url,");
mutate("cap", "cmd is left uncapped", AU,
  "cmd: cap(cmd, MAX_LABEL_BYTES),", "cmd,");
mutate("cap", "outcome is left uncapped", AU,
  "outcome: cap(outcome, MAX_LABEL_BYTES),", "outcome,");
mutate("cap", "url cap raised to a useless size", AU,
  "const MAX_URL_BYTES = 2048;", "const MAX_URL_BYTES = 50_000_000;");
mutate("cap", "label cap raised to a useless size", AU,
  "const MAX_LABEL_BYTES = 128;", "const MAX_LABEL_BYTES = 50_000_000;");

// --- axis: byte budgeting vs character counting (F-M2a) ---------------------
mutate("bytes", "budget counts UTF-16 units, not serialised bytes", AU,
  "  return encoder.encode(JSON.stringify(text)).length - 2;",
  "  return text.length;");
mutate("bytes", "measures raw UTF-8, ignoring JSON escaping", AU,
  "  return encoder.encode(JSON.stringify(text)).length - 2;",
  "  return encoder.encode(text).length;");
mutate("bytes", "truncates by UTF-16 slice, splitting astral chars", AU,
  "  let kept = \"\";\n  let used = 0;\n  for (const char of text) {\n    const cost = serialisedBytes(char);\n    if (used + cost > limitBytes) break;\n    kept += char;\n    used += cost;\n  }\n  return `${kept}…[truncated]`;",
  "  return `${text.slice(0, limitBytes)}…[truncated]`;");
mutate("bytes", "over-budget check inverted, nothing is ever capped", AU,
  "  if (serialisedBytes(text) <= limitBytes) return text;",
  "  return text;");

// --- axis: saveAllowlist failure visibility (F-M2b) -------------------------
mutate("save", "swallows a rejected write, as before the fix", AL,
  "  try {\n    await chrome.storage.local.set({ [STORAGE_KEY]: list });\n  } catch (error) {",
  "  try {\n    await chrome.storage.local.set({ [STORAGE_KEY]: list });\n  } catch (ignored) {\n    return;\n  }\n  if (false) {\n    const error = null;");
mutate("save", "no console signal on a failed save", AL,
  "    console.error(\n      \"[AnythingLLM Companion] failed to save the allowlist; the previous \" +",
  "    String(\n      \"[AnythingLLM Companion] failed to save the allowlist; the previous \" +");
mutate("save", "does not read back, so a lost write looks saved", AL,
  "  const stored = await loadAllowlist();\n  const matches =\n    stored.length === list.length && stored.every((v, i) => v === list[i]);\n  if (!matches) {",
  "  const stored = await loadAllowlist();\n  const matches = true;\n  if (!matches) {");
mutate("save", "read-back compares length only", AL,
  "    stored.length === list.length && stored.every((v, i) => v === list[i]);",
  "    stored.length === list.length;");
mutate("save", "accepts a non-array, emptying the gate", AL,
  "  if (!Array.isArray(list)) {\n    throw new TypeError(\"saveAllowlist expects an array of host entries\");\n  }",
  "");

// --- axis: quota failure observability --------------------------------------
mutate("quota", "quota failure swallowed, never surfaced", AU,
  "      await handleWriteFailure(error, trimmed);\n      throw error;",
  "      throw error;");
mutate("quota", "failure flag never set", AU,
  "    writeFailure = { at: new Date().toISOString(), message, recovered: false };",
  "    writeFailure = null;");
mutate("quota", "failure flag overwritten by each later failure", AU,
  "  if (!writeFailure) {", "  if (true) {");
mutate("quota", "no console signal on write failure", AU,
  "  console.error(\n    \"[AnythingLLM Companion] audit log write failed; \" +",
  "  String(\n    \"[AnythingLLM Companion] audit log write failed; \" +");
// Shrinks by one instead of halving, rather than not shrinking at all: a mutant
// that truly never shrinks spins forever and OOMs the runner, which the harness
// reports as ERROR (correctly -- a crash is not evidence of coverage) but which
// costs a minute per run. This still models "recovery does not shrink fast
// enough to escape a full store".
mutate("quota", "recovery shrinks too slowly to escape a full store", AU,
  "      keep = Math.floor(keep / 2);", "      keep = keep - 1;");
mutate("quota", "recovery drops all history, not just the excess", AU,
  "[...entries.slice(entries.length - keep), marker]", "[marker]");
mutate("quota", "recovery writes no durable marker", AU,
  "[...entries.slice(entries.length - keep), marker]",
  "[...entries.slice(entries.length - keep)]");
mutate("quota", "recovery gives up before writing anything", AU,
  "  let keep = Math.min(RECOVERY_ENTRIES, entries.length);", "  let keep = 0;\n  return;");
mutate("audit", "non-string detail coerced with String()", AU,
  'typeof value === "string" ? value : JSON.stringify(value)', "String(value)");
mutate("audit", "clear is not queued behind pending writes", AU,
  "const wipe = writeChain.then(() =>\n    chrome.storage.local.remove([STORAGE_KEY])\n  );",
  "const wipe = chrome.storage.local.remove([STORAGE_KEY]);");
mutate("audit", "readAll returns the raw stored value", AU,
  "return Array.isArray(stored?.[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];\n}\n\n/** @returns {Promise<void>} */",
  "return stored?.[STORAGE_KEY];\n}\n\n/** @returns {Promise<void>} */");
mutate("audit", "timestamp is a fixed string, not a date", AU,
  "      at: new Date().toISOString(),\n      // Capped here rather than at the call sites",
  '      at: "later",\n      // Capped here rather than at the call sites');

// --- negative control -------------------------------------------------------
// Without this the whole run is worthless: a suite that failed for an unrelated
// reason would report every mutation KILLED and prove nothing.
restore();
const control = runSuite();
console.log(
  `\nNEGATIVE CONTROL (unmutated): ${control.failed} failed, ${control.passed} passed` +
    ` -> ${control.failed === 0 ? "PASS as required" : "*** HARNESS INVALID ***"}`
);

const survivors = results.filter((r) => r.verdict.startsWith("***"));
const errors = results.filter((r) => r.verdict.startsWith("ERROR"));
console.log(
  `\n${results.length} mutations: ${results.length - survivors.length - errors.length} killed,` +
    ` ${survivors.length} survivors, ${errors.length} errors`
);
for (const s of [...survivors, ...errors]) console.log(`  - [${s.axis}] ${s.label}`);
process.exitCode = survivors.length + errors.length + control.failed > 0 ? 1 : 0;
