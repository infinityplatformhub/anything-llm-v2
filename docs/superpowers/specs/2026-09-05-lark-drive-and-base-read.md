# Spec — Lark agent tool: read Drive files and Base tables

Approved by the user in chat on 2026-09-05 (answers to the four scoping questions recorded below).
Builds on `2026-09-05-lark-login-and-user-cli.md` (issue #2) and the #18 fixes. Branch
`feat/lark-drive-base` from `d2036a13`, stacked on `feat/lark-login`.

## Problem

Human test on 2026-09-05: "อ่านไฟล์ MIS vs RIMB ใน Lark Drive" → every read path was refused by our
own policy before the CLI ran. Root causes, all in `server/utils/lark/cli.js` / `settings.js`:

1. `drive` and `base` are not in `DEFAULT_LARK_CLI_ALLOWLIST` (`settings.js:18`) — the first-token
   check rejects them.
2. `READ_COMMANDS` (`cli.js:60`) has no `drive +*` or `base +*` pair, so even when allowed they are
   classified as writes and would require approval for what is a read.
3. `drive +download` / `+preview` write to a local path via `--output`, and `--output` is in
   `FILESYSTEM_FLAGS` (rejected). There is no way to hand the file's *content* to the model: the CLI
   returns a path, not bytes.
4. Drive files are not Lark Docs: `.md/.mdx/.pdf/.docx/.xlsx` need parsing before the model can read them.

## Decisions (user, 2026-09-05)

| Question | Answer |
|---|---|
| Drive file types | text (`.md .mdx .txt .csv .json`) **and** `.pdf .docx .xlsx` via parser |
| Base commands | **every** `base +<sub>` the CLI itself marks `Risk: read` |
| Default allowlist | add `drive` and `base` to `DEFAULT_LARK_CLI_ALLOWLIST` (existing instances add them by hand in Admin → Lark) |
| Branch | new branch stacked on `feat/lark-login`; separate PR |

## Scope

### A. Policy: pin new read pairs

- `READ_COMMANDS` gains every `drive +<sub>` and `base +<sub>` whose `<cli> <group> +<sub> --help`
  prints `Risk: read` in `@larksuite/cli@1.0.93`. The list is generated once by a dev-only script
  (`server/utils/lark/scripts/pin-read-commands.js`, reads `--help` of the locally installed CLI,
  prints the array) and committed; `cli.test.js` keeps asserting the array is frozen and that no
  mutating verb (`create|update|delete|upsert|submit|upload|move|copy|rename|set-|enable|disable|
  revert|restore|remove|add|bind|unbind|arrange|share-update`) appears in it.
- `DEFAULT_LARK_CLI_ALLOWLIST` += `drive`, `base`. `PERMANENT_DENYLIST` unchanged.
- Everything the CLI marks `write` (uploads, deletes, `record-batch-create/update/upsert`,
  `form-submit`, `workflow-*`, `view-set-*`, …) stays a write → in-chat approval.

### B. Drive file content: runner-owned download + parse

The model never passes `--output`. The plugin's canonical form is

```text
drive +download --url "<drive or wiki file url>"      (or --file-token <tok>)
```

For exactly the pairs `drive +download` and `drive +preview` the runner appends
`--output <tmp>/<basename>` itself, inside the per-invocation temp dir it already owns
(`cli.js:441`), then:

1. Reads the CLI JSON result for the saved path and original filename. Refuses (`error:"unsafe_path"`)
   if `realpath(saved)` is not under `realpath(tmp)`; refuses (`error:"file_too_large"`) above 8 MB.
2. Extracts text by extension:
   - `.md .mdx .txt .csv .json .adoc .rst .org` → UTF-8 read.
   - `.pdf .docx .xlsx .pptx` → `new CollectorApi().parseDocument(basename, { absolutePath })`
     (existing `/parse` route, `parseOnly: true`, nothing stored). Join `documents[].pageContent`.
   - anything else → `{ ok:false, error:"unsupported_file_type", extension }`.
3. Returns `{ ok:true, filename, extension, bytes, text, truncated }` with `text` cut at the existing
   `MAX_OUTPUT_BYTES` (64 KB) and passed through `redact()` with the invocation's secret list.
4. Temp dir removal in the existing `finally` disposes of the file.

`drive +export` stays a plain read returning the CLI JSON (it produces a download ticket; a follow-up
may chain `+export-download` through the same path). Implementer records a `Ruling:` after checking
`--dry-run` output on 1.0.93.

`--output` remains in `FILESYSTEM_FLAGS` for model-supplied args; tests must prove a model-supplied
`--output` is still rejected and that the injected one is not present in the audit `args`.

### C. Prompt / tool description

`server/utils/agents/aibitat/plugins/lark-cli.js` description adds canonical forms
`drive +search --query "<text>"`, `drive +download --url "<file url>"`,
`base +table-list --base-token <tok>`, `base +record-list --base-token <tok> --table-id <tbl>`,
`base +data-query --base-token <tok> --dsl '<json>'`, and one example "read a file from my Drive".
States that Drive file content comes back as text (max 64 KB).

### D. Scopes and docs

`docs/lark-setup.md` user OAuth scopes add `drive:drive:readonly`, `drive:file:readonly`,
`search:docs:read`, `base:app:read`, `base:table:read`, `base:record:retrieve`, `base:field:read`,
`base:view:read`, `base:dashboard:read`, `base:form:read`, `base:workflow:read`, `base:role:read`.
`DEFAULT_SCOPES` in `constants.js` gains the same set. Admins import them in Lark Developer Console
**and publish a version**, then users Reconnect.

## Out of scope

Any Drive/Base write; uploads; OCR of images; files > 8 MB or text > 64 KB (truncated, not paged);
per-workspace gating (sibling branch phase 2).

## Security invariants (from #2, restated for this diff)

- Model-supplied filesystem flags are still rejected; the runner injects `--output` only for the two
  pinned verbs, only to a path inside its own temp dir, and verifies the CLI honoured it before reading.
- Parsed text passes `redact()` before returning. Collector `/parse` carries the existing
  `X-Integrity` signature; `parseOnly` keeps `storage/documents` untouched.
- Audit `args` are the model's args (without the injected `--output`); outcome/exit/truncated as before.

## Evidence contract

```bash
cd server && node ../node_modules/jest/bin/jest.js __tests__/utils/lark __tests__/e2e/lark --runInBand
```

Expect all `Tests:` passed, 0 skipped, including E2E scenarios: `drive +download returns parsed text
for md and pdf`, `model-supplied --output is rejected`, `base +record-list is a read (no approval)`,
`base +record-batch-create requires approval`, `unsupported extension → unsupported_file_type`.

Human acceptance: "@agent อ่านไฟล์ MIS vs RIMB ใน Lark Drive" on localhost:3001 returns the file's
content summary without an approval prompt.
