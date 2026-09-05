# Plan — Lark agent reads Drive files and Base tables (issue #20)

Spec: `docs/superpowers/specs/2026-09-05-lark-drive-and-base-read.md`. Recon: `.infi/recon-lark-drive-base.md`.
Branch `feat/lark-drive-base` (worktree `.claude/worktrees/lark-drive-base`), base `d2036a13`. Never push.

## 1. Global constraints

- Jest: `cd server && node ../node_modules/jest/bin/jest.js <path>` (never `npx jest`). Unit suites need
  the existing `_polyfill.js`; E2E uses `helpers/preload.js`. Node 22 at `/opt/homebrew/opt/node@22/bin`.
- Never put the hyphenated CLI name in a Bash command (shell hook). The installed CLI is on PATH as
  `LARK_CLI_BIN` (`cli.js:15`); scripts may invoke it via `process.env.LARK_CLI_PATH || ["lark","cli"].join("-")`.
- Security invariants from #2 stay: argv only, first-token allowlist + `PERMANENT_DENYLIST`, every token
  validated, `FILESYSTEM_FLAGS` rejected for model args, isolated env/HOME, 60 s / 64 KB caps, audit with
  redaction, approval before spawn for writes.
- Existing suites stay green: `__tests__/utils/lark` (152) and `__tests__/e2e/lark` (21).
- A local server on :3001 (human's) is running from the sibling worktree — do not touch it.
- Evidence contract (issue #20):
  `cd server && node ../node_modules/jest/bin/jest.js __tests__/utils/lark __tests__/e2e/lark --runInBand` → `Tests:` all passed, 0 skipped.

## 2. Tasks (sequential — both touch `server/utils/lark/cli.js`)

### Task A — Policy: pin drive/base read pairs, default allowlist, scopes, docs — Sonnet

Files: `server/utils/lark/cli.js` (`READ_COMMANDS`), `server/utils/lark/settings.js`
(`DEFAULT_LARK_CLI_ALLOWLIST`), `server/utils/lark/constants.js` (`DEFAULT_SCOPES`),
`server/utils/lark/scripts/pin-read-commands.js` (new, dev-only), `server/__tests__/utils/lark/cli.test.js`,
`server/__tests__/utils/lark/settings.test.js`, `docs/lark-setup.md`.

1. Write `scripts/pin-read-commands.js`: for each group in `["drive","base"]`, run `<cli> <group> --help`,
   parse `+sub` lines, run `<cli> <group> +sub --help` for each, keep those whose output contains
   `Risk: read`. Print a sorted JSON array of `"<group> +<sub>"`. Uses `child_process.execFileSync`
   with the binary from `LARK_CLI_PATH` or the joined default; 10 s timeout per call. Not required in prod.
2. Run it once against the installed 1.0.93; paste the result into `READ_COMMANDS` (keep the existing
   31 pairs, keep sorted by group then sub). Expect roughly `drive +download, +export, +inspect,
   +list-comments, +list-replies, +member-list, +permission-get-setting, +preview, +search, +status,
   +version-get, +version-history` and ~45 `base +…` (`+app-get, +base-get, +data-query, +field-list,
   +record-get, +record-list, +record-search, +table-list, +view-list, …`). Any pair whose sub matches
   the mutating regex in the spec (`create|update|delete|upsert|submit|upload|move|copy|rename|set-|
   enable|disable|revert|restore|remove|add|bind|unbind|arrange|share-update|resolve`) must NOT be
   included even if the CLI says read — record a `Ruling:` if that happens.
3. `DEFAULT_LARK_CLI_ALLOWLIST` += `"drive", "base"`. `DEFAULT_SCOPES` += the 12 scopes in spec §D.
4. TDD: `cli.test.js` — extend "classifies only allowlisted read pairs": `drive +download`, `base
   +record-list`, `base +data-query` → read; `drive +upload`, `drive +delete`, `base +record-batch-create`,
   `base +form-submit`, `base +view-set-filter` → write. Extend "READ_COMMANDS is a frozen pinned pair
   allowlist" with the mutating-verb regex assertion over every pair. `settings.test.js`: default
   allowlist contains drive and base; `DEFAULT_SCOPES` contains `drive:drive:readonly` and `base:record:retrieve`.
5. `docs/lark-setup.md`: allowlist default list, scope list, note that existing instances must add
   `drive`/`base` in Admin → Lark and import scopes + publish, then Reconnect.

Acceptance: `__tests__/utils/lark` green (count grows), `cd server && node node_modules/eslint/bin/eslint.js
utils/lark` 0 errors (use `../node_modules/eslint/...` if needed).
Commit: `feat(lark): allow drive and base read commands with pinned read pairs (#20)`.

### Task B — Runner: drive +download/+preview return parsed file text — Sonnet (after A)

Files: `server/utils/lark/cli.js` (runAsUser/execute seam), `server/utils/lark/fileText.js` (new: extension
→ text), `server/utils/agents/aibitat/plugins/lark-cli.js` (description/examples),
`server/__tests__/utils/lark/cli.test.js`, `server/__tests__/utils/lark/fileText.test.js` (new),
`server/__tests__/e2e/lark/helpers/fakeCli.js`, `server/__tests__/e2e/lark/lark.e2e.test.js`.

1. In `runAsUser`, after policy passes and `tmp` exists: if `classify(args)==="read"` and the pair is
   `drive +download` or `drive +preview`, set `outputPath = path.join(tmp, "download", <safe basename>)`
   (mkdir) and spawn with `[...args, "--output", outputPath]`. The audit `args` stay the model's args.
2. On success, parse the CLI JSON for the saved path (implementer checks the real field name on 1.0.93
   with `--dry-run`/a real call is NOT allowed — read the CLI `--help` and the `lark-doc` skill text in
   the package instead; record a `Ruling:` naming the field and fallback to `outputPath` if absent).
   Verify `fs.realpath(saved)` starts with `fs.realpath(tmp) + path.sep`, else `{ok:false,error:"unsafe_path"}`.
   `stat.size > 8*1024*1024` → `{ok:false,error:"file_too_large"}`.
3. `fileText.js` `extractText({ filePath, extension })`: text set → `fs.readFile(utf8)`; office/pdf set →
   `new CollectorApi().parseDocument(basename, { absolutePath: filePath })` and join
   `documents.map(d=>d.pageContent)`; else `{ok:false,error:"unsupported_file_type",extension}`.
   Cap text at `MAX_OUTPUT_BYTES` bytes, `truncated:true` when cut. Result `{ok:true,filename,extension,bytes,text,truncated}`
   is passed through `redactData` before return. Collector unreachable → `{ok:false,error:"parser_unavailable"}`.
4. Plugin description/examples per spec §C.
5. TDD: unit — injected `--output` present in spawn argv only for the two pairs and only under tmp;
   model-supplied `--output` still rejected before spawn; unsafe_path when CLI reports a path outside tmp;
   file_too_large; text/office/unsupported branches (mock `CollectorApi.parseDocument`). E2E — fake CLI
   gains modes `download-md` (writes a `.md` at the `--output` path it received and prints
   `{"file_path":..., "name":...}`), `download-bin` (`.bin`), `download-escape` (writes to and reports a
   path outside `--output`'s dir); scenarios per spec evidence contract. PDF via collector is unit-only
   (E2E has no collector) — record `Ruling:`.

Acceptance: both suites green, 0 skipped; `eslint` clean on `utils/lark`, `utils/agents/aibitat/plugins/lark-cli.js`.
Commit: `feat(lark): return parsed Drive file text from drive +download/+preview (#20)`.

### Task C — Final: run evidence contract, `task.sh check --issue 20 --base d2036a13`, QA review, human test on :3001 (rebuild + restart from this worktree), close.

## 3. Rulings
- Sequential A→B (same file). Parallel dispatch would race on `cli.js`.
- `drive +export` stays plain read (returns ticket JSON); chaining `+export-download` is a follow-up.
- Existing instances do not get `drive`/`base` auto-added to a saved allowlist — admin opt-in, documented.
