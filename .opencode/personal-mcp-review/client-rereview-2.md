# Task 4 — round2 independent scoped re-review

**Disposition: CHANGES REQUESTED on two remaining fix-specific boundaries. Not production-ready.**

Reviewed `.opencode/personal-mcp-review/round2-client-review.diff`, the latest client report (round2 at `docs/plans/personal-mcp-client-report.md:161–205`), evidence and relevant current source. All paths/line numbers below refer to this permitted worktree. A read-only comparison verified the diff's added lines match current files: **79 files, zero added-line mismatches**. No children, product edits, production operations, migration execution, dependency changes or full-suite repetition. Only this review artifact was written. Parent's authorized integration worker remains independent; this review neither starts nor controls it.

## Spec + Quality verdicts

| Prior item | Axis | Verdict | Exact boundary |
| --- | --- | --- | --- |
| F1 owner/private invocation isolation | Spec | **NOT ADDRESSED** | Durable already-marked context, authorized follow-ups, definition removal and JWT rechecks are implemented. First-use concurrent socket initiation before the durable mark remains open; invocation creation also has a marker-transition plaintext race. |
| F2 sticky private → legacy trace/introspection | Spec | **ADDRESSED** | Both actual execution methods suppress generic traces/diagnostics after sticky privacy, including subsequent legacy tools. |
| F3 first-row registration/abort | Spec | **ADDRESSED** | Listener rechecks privacy after awaited insertion and redacts even on abort before registering its ID. The EventEmitter itself remains non-awaiting; no claim that execution now awaits all storage listeners. |
| F4 provider direct catch privacy | Spec | **ADDRESSED** | 32 named direct catches across 31 wrappers receive narrow guards; actual Generic OpenAI wrapper regression and fresh probe suppress the echo. Not every provider was dynamically fault-injected. |
| F5 nested verified account label | Spec | **ADDRESSED** | Actual nested `account:{actor_id,label}` is normalized; only sanitized label retained; exchange/refresh/own-status coverage exists. Actual approved Medusa connectivity remains separate. |
| Q1 coverage of these exact fixes | Quality | **NOT ADDRESSED** | Actual-handler tests materially improve evidence, but begin with context already marked. They miss the first-discovery concurrent socket and invocation-marker transitions identified below. Trace/race/provider/label regressions are present. |
| Q2 executable separate PG migration/full local startup | Quality | **NOT ADDRESSED** | Actual full PG client + copied application startup evidence closes the original no-startup-evidence gap. New startup preflight and application can select different DB targets; equal-URL fixture does not test this. |

S1 global-vs-shadow invalidation remains addressed; the scoped exclusion code is unchanged from the accepted correction (`server/utils/MCP/hypervisor/index.js:116–148`). No new S1 finding. `NOT ADDRESSED` denotes an incomplete full boundary, not rejection of the substantial implemented corrections.

## R2-1 — P1 / F1, Q1: first-use marker is too late to exclude concurrent unauthorized initialization

**Source:** `server/endpoints/agentWebsocket.js:76–100,117–120,182–187`; `server/utils/agents/index.js:788–814,889–905,942–972`; `server/utils/MCP/index.js:20–43,75–91`; `server/models/personalMcpContext.js:22–49`.

For an already-marked owner/thread, socket validation now occurs before constructing/initing `AgentHandler`: correct. With no marker yet, failed owner validation is still deliberately allowed to proceed. The owner then performs provider setup, attachment consumption and history loading; default discovery boots personal clients through `activeMCPServers` **before** `convertServerToolsToPlugins` persists the privacy mark. Only plugin conversion (`MCP/index.js:83–91`) marks before `personalRuntime.tools`. Consequently, during a slow first personal boot/default-definition load, a second anonymous/other socket to the same open UUID sees no marker, constructs a handler, loads creator context and can execute a legacy/model answer before the owner reaches marking.

**Fresh focused reproduction:** Node VM loaded the **actual endpoint, actual AgentHandler and actual websocket plugin**; DB/context/default discovery/AI/provider were fixtures, no network or writes. Paused the owner in default discovery before the marker, then connected an unauthorized socket. The latter ran actual `init/createAIbitat/startAgentCluster` and emitted `fixture-first-input fixture-owner-attachment` before the marker. A separate simpler endpoint probe also confirmed unauthorized init/output while an owner init was paused. This is a pre-marker race, not a fabricated-capability bypass.

**Confidence boundary:** this reproduces creator prompt/attachment exposure before first personal marking, not an old in-memory personal result reattached to the new handler. Once the durable marker exists, the new emission guard and handler rechecks deny the other socket; I found no deterministic post-marker route bypass in this round. Nevertheless the requested owner-private boundary must cover the first prompt/attachments intended for personal execution, not only results that happen to be emitted after the database mark. Merely checking an eventual marker per emission cannot recover output already sent.

**Scoped remedy/regression:** establish a trusted invocation/owner-context reservation before first-use personal preparation, and synchronize competing socket initialization with it **before provider/history/attachment side effects**. Do not replace this with “any personal definition exists” gating. Add a deferred personal boot/default discovery test with owner A and other/anonymous sockets to the same UUID: competitors must not initialize, consume cached attachments or emit creator content while the owner is entering personal exposure; truly legacy-only/disconnected-personal invocations must retain their tested compatibility. Verify cross-process persistence/reservation semantics, not just an in-process boolean.

### R2-1b — P2 / F1: invocation creation can persist plaintext across a concurrent mark

**Source:** `server/models/workspaceAgentInvocation.js:30–55`; `server/models/personalMcpContext.js:25–47`.

`Invocation.new` checks `Context.has` once before its insert. A concurrent `mark` can commit after that false read and before the new row is created. `mark` encrypts only its supplied UUID, not other newly created rows in the context; `new` has no post-insert recheck. The later marked-context socket gate still protects access, but the claimed encrypted follow-up persistence is not atomic with transition into private context.

**Fresh actual-source probe:** deferred fixture Prisma `create`; `has(false)` → concurrent durable marker true → finish insert. The returned persisted row contained original `fixture-followup-sensitive`, not the encrypted prefix. No actual DB write.

**Scoped remedy/regression:** coordinate marker/creation atomically, or recheck and encrypt before publishing the invocation UUID, with a clear concurrency invariant. Add a deferred-create vs first-mark test asserting no plaintext row remains. This is separate from the now-fixed generic chat pre-registration listener.

## R2-2 — P2 / Q2: PG startup preflight does not validate the application's effective datasource

**Source:** `server/scripts/personal-mcp-pg-start.cjs:6–19`; `server/utils/prisma/index.js:9–15`; `server/__tests__/e2e/mcp/personal-pg.e2e.test.js:69–83,132–159,169–185`.

The startup script constructs `new PrismaClient()` without datasource overrides, so a PG client generated with `env("DATABASE_URL")` preflights that URL. The application constructs its own client and explicitly overrides with `ANYTHINGLLM_DATABASE_URL` when set. With both variables present but different, the preflight can validate DB/schema A and then start the application against B, whose two additive tables/PG schema may not have been migrated. There is no equality/effective-target guard. The full PG fixture sets the two variables identically, so its valid PASS does not catch this new artifact defect.

**Fresh focused probe:** actual startup source with a fixture Prisma client, followed by actual application's Prisma factory. Recorded preflight construction with no options, while application construction used `{datasources:{db:{url:'postgres://fixture/app-db'}}}`. No credential values from the environment were read/logged and no real database was contacted.

**Scoped remedy/regression:** select and validate the **same effective datasource** as the application, or reject conflicting configuration with a bounded message, before requiring `server/index.js`. Test distinct DATABASE_URL/ANYTHINGLLM_DATABASE_URL and ensure a passing wrong-target preflight cannot launch the app. Do not add generation, migration-history replay or any production operation to startup.

## Accepted corrections and evidence boundaries

### F1 — substantial closed paths, despite R2-1

- `personalMcpContext.js:2–20,25–29` persists `(workspace_id,user_id,thread_key)`, null thread → `0`; no grant/definition relation deletes it. PG/SQLite context migrations are additive (`server/prisma/postgresql/personal-mcp-contexts.sql:1–11`; new SQLite context migration `:1–10`). Workspace/user deletion cascades are intentional.
- `agentWebsocket.js:76–94` rejects unauthorized already-private context before handler construction. `agents/index.js:788–814,824–825,889–905,991–1012` rechecks before provider/attachments/history/files/start and restores sticky state. `workspaceAgentInvocation.js:33–45` encrypts prompts when the marker is already visible; init decrypts after authorization.
- `agentWebsocket.js:95–115,146–150` queues send authorization and checks incoming messages; `personalCaller.js:33–39,46–62` retains socket JWT in WeakMap and verifies it again alongside active membership. Initial wrong-owner/expired and later expiry/membership denial are covered. Logout-only deletion of browser storage is not server-side JWT revocation, accurately acknowledged by report `:171`.
- `server/__tests__/endpoints/personalMcpActualHandler.test.js:107–134` proves denial before init/history/attachment consumption for already-private contexts; `:136–195` tests actual owner output and membership/expiry revocation; `:197–220` tests actual legacy anonymous compatibility. Setup pre-marks at `:47–51` and removes a definition at `:53–58`; it does **not** exercise the first-discovery transition. Definition removal/restart durability is supported by the persistent model; `personalContext.test.js:18–48` covers scope and encrypted current prompt, although its “fresh module” test does not actually reload/process-restart.
- No blanket catalog gate exists in the new socket endpoint; genuinely legacy context remains permitted even when authentication fails. Adding an invocation-specific reservation must preserve this.

### F2 — ADDRESSED

`server/utils/agents/aibitat/index.js:1080–1111,1262–1293` conditions both verbose diagnostics and generic tool result emission on **both** function-private and sticky invocation/AIbitat state. Legacy MCP diagnostics are guarded (`server/utils/MCP/index.js:255–297`); websocket introspection is guarded (`server/utils/agents/aibitat/plugins/websocket.js:143–173`).

`personalExecution.test.js:24–88` now actually chains private → legacy in both execution methods. Fresh actual-source VM probes executed those two methods and observed zero generic traces/introspection. Owner results intentionally still reach the selected model/socket; this is not zero external processing.

### F3 — ADDRESSED

`server/utils/agents/aibitat/plugins/chat-history.js:50–83` rechecks both sticky flags after awaited row creation and awaits placeholder upsert even if aborted, then registers ID. `personalPrivacy.test.js:36–67` covers delayed insertion + privacy flip + abort. Fresh actual listener probe reproduced that ordering and observed a redacted save. This fixes the exact previously demonstrated abort race. It does not change `newMessage` to await EventEmitter listeners, nor prove crash-time/database-failure behavior; normal storage-failure handling remains separate.

### F4 — ADDRESSED

The supplied diff adds **32 direct-catch guards across 31 provider wrappers**, including both Foundry catches, with no request/model/retry changes. Representative exact catch: `server/utils/agents/aibitat/providers/genericOpenAi.js:141–144`; common providerLog guard remains `ai-provider.js:148–154`; outer error sanitizer `aibitat/index.js:994–1005` and websocket error guard `plugins/websocket.js:143–158` bound private exceptions.

`personalProviderPrivacy.test.js:9–22` exercises the actual Generic wrapper with a rejected helper. Fresh actual-wrapper probe captured **no** private console echo. Remaining 30 wrappers were checked statically through the matching diff, not dynamically fault-injected. This verdict covers the exact named direct catches, not all logging everywhere in full chat/provider infrastructure.

### F5 — ADDRESSED

`server/utils/MCP/oauth.js:253–280` validates nested object/nonempty string actor ID/string label, sanitizes the label through `PersonalMcpGrant.publicLabel`, with legacy top-level compatibility fallback. Raw actor/account/JWT fields are not persisted (`personalMcpGrant.js:110–119`). Report `:44,181–183` is corrected.

`server/__tests__/e2e/mcp/helpers/mockMcp.js:33–41` emits nested account; `personal.e2e.test.js:147–179` checks exchange and rotating refresh → own status label, alongside A/B runtime isolation. Fresh actual-parser probe normalized `Verified\n<Shop>` to `Verified Shop` and discarded the identity object. Backend role enforcement/live deployment/browser flow are not implied by this fixture contract result.

### Q2 — original missing full-PG evidence closed; new target issue R2-2 remains

`server/scripts/personal-mcp-pg-migrate.cjs:9–38` requires explicit approval and private DATABASE_URL, executes only the two fixed standalone PG files in one transaction, rolls back errors, and logs bounded success/failure at `:40–45`. No URL/credential/provider error body is printed by its explicit output. `personal-mcp-pg-start.cjs:7–24` preflights tables, disconnects and starts actual app without generation or migrate deploy. The stock Docker entrypoint is **not** changed or approved; deployment must select an operator-reviewed override. The scripts do not select an operator's destination/schema automatically; approval and privately confirmed environment remain required.

`personal-pg.e2e.test.js:8–14` guards the authorized localhost disposable DB; `:28–111` builds a full empty PG schema/generated client in copied source; `:112–131` replaces **fixture-only** new tables via the actual additive job; `:132–185` writes users/membership/context with PG Prisma, boots actual app through the new startup artifact and gets authenticated HTTP 200 `{servers:[]}`. Cleanup `:189–198` removes its fixture namespace. Dependencies are shared read-only via local symlinks except isolated copied Prisma/generation output; main client is not replaced. This is full local **application startup/personal-status smoke**, not real LLM/full-chat/browser/production-schema migration evidence. It does not run the context `mark` helper or a real personal tool on PG; it writes the marker model directly.

Retained evidence: `server/storage/personal-mcp-test-evidence/round2-pg-startup.log:1–8` reports 1 startup test PASS; `round2-e2e.log:1–3,12–16` reports **3 suites / 22 tests PASS**, including that fixture. Review did not repeat PG runs, migrations, SDK suites or application boot. Fix R2-2 and test effective-target selection without replaying SQLite history.

## Verification accounting / remaining gates

Fresh reviewer evidence consists only of bounded source/VM probes and diff/source comparison; those used synthetic fixture data/dependencies, no external HTTP/DB, no product edits. Worker-retained results were read, **not rerun**:

- Server **110 suites / 1,525 PASS**: `server/storage/personal-mcp-test-evidence/round2-server.log:2752–2753`.
- MCP + full local PG startup **3 suites / 22 PASS**: `round2-e2e.log:12–13`.
- Build/lint PASS reported at `docs/plans/personal-mcp-client-report.md:198–200`; command summary `docs/plans/personal-mcp-evidence.md:67–74`. No browser claim.
- Known absent collector dependencies remain historical; root suite was neither requested nor repeated (`report:201`).

Required **fix-only** additions: (1) owner first-discovery vs anonymous/other socket concurrency before init/context/attachment side effects; (2) invocation create vs mark transition persistence; (3) divergent PG datasource preflight/start selection. Do not infer production approval from existing green counts.

Browser A/B UX, proxy handshake, full-chat integration, real approved backend/provider integration, production artifact/override selection and human RBAC assignment/activation remain separate gates. No new permissions, default/synthetic roles, shared keys, production activation, or delegation is authorized by this review.
