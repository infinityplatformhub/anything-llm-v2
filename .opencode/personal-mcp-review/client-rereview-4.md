# Task 4 — final fix4 scoped re-review

**R3-1: ADDRESSED. Spec + Quality: PASS for this final local client review gate.**

No new concrete fix-only blocking finding established. This closes the absent-versus-UNKNOWN classification barrier identified in `client-rereview-3.md`; it is **not production-readiness or deployment approval**.

## Scope and verification

Reviewed R3-1 only: all 2,337 lines of `.opencode/personal-mcp-review/round4-client-review.diff`, latest report round4 (`docs/plans/personal-mcp-client-report.md:250–289`), current strict-reader/classifier/endpoint source and tests. Read-only comparison of supplied diff against current source: **6 files, zero added-line mismatches**. References below are current worktree file lines.

No child agents, product edits, production operations, role/permission suggestions, app/DB runs or suite reruns. Only this review artifact was written. Accepted R2-1b/R2-2/F2–F5 were not reopened. Fresh reviewer probes ran actual source in memory with fixture dependencies/keys/config/content, no live network or database writes, and explicit write traps.

| Item | Verdict | Boundary |
| --- | --- | --- |
| R3-1 absent vs UNKNOWN reservation classification | **ADDRESSED** | Unknown relevant catalog/shadow/grant classification cannot proceed into legacy initialization; healthy absence/nonpersonal/disconnected/unrelated cases retain scoped compatibility. |
| Spec axis | **PASS** | The reported malformed-catalog owner-context exposure is blocked before handler side effects. |
| Quality axis | **PASS** | Strict-format, authoritative-shadow, token/query failure, endpoint denial/restoration and compatibility regressions cover the exact fix; fresh probes independently reproduced the barrier closure. |

## Why the barrier is closed

### Strict effective definition lookup has no creation/repair fallback

`server/utils/MCP/hypervisor/index.js:178–228` adds static `findServerConfigStrict`; inherited by `MCPCompatibilityLayer` (`server/utils/MCP/index.js:6`). It does **not** instantiate the hypervisor or invoke config setup/discovery/boot. It uses persisted `workspaceId` and checks `WorkspaceMcpServer.findStrict` first (`:189–190`); only proven absent workspace override permits reading global config.

Global config at `:191–210` uses `fs.readFileSync` plus **JSON.parse**, not repair/extraction/fallback. Missing/unreadable file, empty/whitespace/malformed JSON, null/array root, missing own `mcpServers`, or null/array block throw bounded `personal_config_unavailable`. The real successfully read `{"mcpServers":{}}` is healthy absence. Target lookup is own-property at `:211`, so inherited `constructor` is not a definition. Only the relevant target is inspected (`:212–223`): object definition and valid `anythingllm` object/boolean personal flag; `true` additionally gets remote personal config validation. Explicit boolean `false` and absent personal flag remain nonpersonal, rather than being confused with string `"false"`/`"true"` or null/array shape. Unrelated malformed entries do not gate this creator.

The old instance `findServerConfig` (`:159–175`) and lenient `mcpServerConfigs` getter (`:555–564`) remain separate APIs; no conversion of legacy discovery to strict parsing is introduced. Global nonpersonal entries intentionally are not forced into the remote-only workspace validator, preserving legacy stdio/config forms. This verdict does not redefine global legacy validation.

### Authoritative workspace shadow cannot become absence

`server/models/workspaceMcpServer.js:56–75` adds `findStrict`. Null row is absence; query error, present but undecryptable ciphertext, invalid JSON or invalid workspace configuration is UNKNOWN. It requires pre-existing `SIG_KEY` and `SIG_SALT` (`:64–67`) and supplies those exact values to `EncryptionManager`; missing keys reject before construction, not generate/write replacements. Manager error logging is disabled before decrypt (`:68–69`), config is validated (`:70`), and failure escapes only as `personal_config_unavailable` (`:72–73`).

The constructor with explicitly supplied keys may emit its pre-existing **generic** “pre-assigned key & salt” log (`server/utils/EncryptionManager/index.js:28–35`), not key values, ciphertext or configuration. Strict crypto errors are suppressed; this is not a claim of absolutely zero logs for every successful lookup. No secret/config/error payload is emitted by the strict wrapper. Existing lenient `find` and `listDecrypted` remain present with their prior behavior (`workspaceMcpServer.js:49–54,77–84`).

A healthy workspace override returns without consulting malformed irrelevant global JSON; a corrupt workspace shadow throws instead of using a global same-name fallback. This closes the secondary shadow ambiguity named in R3-1.

### UNKNOWN closes silently before initialization

`server/models/personalMcpContext.js:29–42` wraps classification failure in bounded `personal_context_unavailable`. `prepareStrict` (`:44–78`) consults only persisted creator/workspace **enabled grant names**, passes persisted workspace ID to static lookup, and calls actual `Grant.find` for current personal definitions. Matching enabled grant with missing/non-string/empty access token throws (`:67–75`); thrown list/config/decrypt/token queries do not become absence. A changed fingerprint returns null through the existing grant contract (`server/models/personalMcpGrant.js:102–108`) and is intentionally not considered an active current capability. Existing durable marker short-circuit remains protective independently of definitions.

`server/endpoints/agentWebsocket.js:73–92` sets `classifyingContext=true` before prepare and the marker read. Catch at `:194–207` closes silently for classification in progress, private context or the bounded classification error: no generic frame or raw error log. Handler construction/init occurs only afterward (`:124–127`). No close listener has been installed at this denial point, so this path does not close the owner invocation. Independent `AgentHandler.init` still prepares before provider/attachments (`server/utils/agents/index.js:788–815`); bounded errors from that path are also caught silently. Identity/send/message guards were not weakened.

## Exact-fix evidence

### Fresh reviewer actual-source probes

Loaded actual strict hypervisor, workspace `findStrict`, EncryptionManager, remote config validator, prepare and endpoint with fixture FS/Prisma/provider dependencies. Checked:

- 12 malformed-format/definition/auth-shape variants rejected; healthy empty catalog and own-property absence returned null; boolean `perUserAuth:false` accepted as nonpersonal.
- FS read failure and DB lookup failure rejected; corrupt authoritative shadow did not fall back to healthy global; valid encrypted shadow skipped unhealthy global entirely.
- Missing stable key rejected without replacement or writes. FS/environment-write traps stayed at zero; no fixture secret in diagnostics.
- Original malformed-enabled-creator reproduction now yielded **zero handler constructions/init, zero frames, one socket close and zero console calls**. Thrown token lookup became bounded error; restored current personal config reserved; disabled/unrelated creator with no enabled names skipped malformed catalog without reservation.

The first probe fixture omitted Buffer from the VM and failed during fixture encryption; corrected fixture included Buffer and reproduced all intended assertions. This was a harness setup error, not a product test failure. Probes neither modified product files nor exercised live model/network stress.

### Retained worker tests inspected, not repeated

`server/__tests__/endpoints/personalMcpActualHandler.test.js:366–547` exercises anonymous/other first across malformed global, empty file, missing block, null/array catalogs, read failure, corrupt shadow/tokens, missing tokens and thrown shadow/grant-list/grant-find/config lookups. It uses actual endpoint, classifier, crypto, Prisma and handler with fixture default definitions/model start. Assertions at `:481–511` cover no frames/init/provider/history/files/default-definition/start, unchanged open invocation, and independent init rejection; restoring data/config permits owner input and original attachment at `:512–535`. Healthy deleted/disabled/nonpersonal/unrelated-user cases at `:549–611` retain legacy anonymous access.

`server/__tests__/utils/MCP/personalStrictConfig.test.js:44–84` covers strict current-format/root shapes, empty own-property lookup and invalid relevant entries; `:85–114` covers unrelated invalid entries, unchanged lenient repair behavior, authoritative shadow and **missing file without creation**. `:115–159` covers stable key/salt requirements/no writes and decryptable invalid shadows. `:160–212` covers healthy absence/disabled/nonpersonal/fingerprint-change/unrelated-user and persisted workspace provenance. Missing-file behavior is directly tested at the reader layer; endpoint read-failure tests establish the same thrown-classification denial path. No requirement for new broad browser tests to close this malformed barrier remains.

Retained PASS counts:

- `server/storage/personal-mcp-test-evidence/round4-covering.log:1311–1312`: **3 suites / 72 tests**.
- `round4-server.log:3906–3907`: **112 suites / 1,589 tests**.
- `round4-e2e.log:41–42`: **3 suites / 22 tests**.
- Changed-product lint/diff check PASS reported at `docs/plans/personal-mcp-client-report.md:276–285`. No frontend edit/build this round. Historical/worker root result's seven known collector load failures remain outside this review; no repeat or dependency work.

Parent-supplied healthy actual full-chat/browser read/update PASS with local deterministic model fixture remains separate integration evidence. It did not prove malformed-catalog denial; the strict-classifier/endpoint evidence above supplies that proof within this scope. No generic-log proof or concurrent stress claim is inferred from parent full-chat results.

## Final local disposition

**R3-1 is closed; final local client review gate PASS within the reviewed scope.** No remaining concrete fix-only blocker or additional required regression found. Prior accepted items retain their earlier stated boundaries; they were not re-reviewed here. Production artifact/entrypoint selection, live backend/proxy/environment approval, human activation gates and rollout remain separately owned. No new roles/default permissions, shared keys or production operations are proposed or authorized.
