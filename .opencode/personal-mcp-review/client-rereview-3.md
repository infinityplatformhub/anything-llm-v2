# Task 4 — fix3 independent scoped re-review

**Final scoped gate: CHANGES REQUESTED. One blocking R2-1 fail-closed classification edge remains. Not production-ready.**

Scope is **only R2-1, R2-1b and R2-2**. F2–F5 and previously accepted global shadow exclusion were not reopened. Read all 2,291 lines of `.opencode/personal-mcp-review/round3-client-review.diff`, latest report round3 (`docs/plans/personal-mcp-client-report.md:207–248`), focused source/tests and retained local evidence. Read-only diff comparison: **8 files, zero added-line mismatches** with current worktree. All implementation references below are current file lines, not diff offsets.

No children, product edits, roles/permissions work, production operations, app/DB reruns or full-suite repeats. Only this review artifact was written. Fresh probes used synthetic in-memory dependencies/data and actual source, with no network, real credentials or database writes.

## Spec + Quality verdicts

| Item | Axis | Verdict | Boundary |
| --- | --- | --- | --- |
| R2-1 first-use reservation/socket race | Spec | **NOT ADDRESSED** | Normal connected-grant classification now reserves before handler side effects and deferred boot. An unreadable/malformed catalog can still be classified as absent rather than unknown, bypassing reservation and permitting unauthorized initialization. |
| R2-1b invocation insert vs mark | Spec | **ADDRESSED** | Shared database write-ordering lock, transactional marker + all-context encryption, postinsert protection before UUID publication close the demonstrated race. Failures do not publish an invocation. |
| R2-2 effective PG datasource | Quality | **ADDRESSED** | Preflight passes the exact application-precedence override URL; distinct-target positive/negative real PG startup tests and retained evidence exist. No migration-history replay or generation added to startup. |

**Quality gate:** requested normal concurrency and effective-PG tests are materially improved; the missing malformed-definition classification regression keeps the scoped gate open. This gap is a blocking security boundary, not a concern deferred to browser testing.

## Blocking finding — R3-1 / P1 / R2-1: failed catalog lookup becomes “legacy”

**Exact paths:**

- `server/models/personalMcpContext.js:29–60`: finds the creator's enabled grant names, resolves effective definitions, and silently continues on missing/non-personal config at `:45–47`. No distinction between truly absent definition and failed definition decoding exists.
- `server/utils/MCP/hypervisor/index.js:503–511`: global config getter uses `safeJsonParse(..., {mcpServers:{}})`, turning unparseable JSON into an empty catalog.
- `server/utils/http/index.js:78–97`: tries JSON parse/repair/extraction and ultimately returns the fallback.
- `server/endpoints/agentWebsocket.js:76–95,118–121,183–188`: calls `prepare`, then permits failed owner authentication when the marker is false and proceeds into the handler.
- `server/utils/agents/index.js:788–815`: independently calls the same `prepare` classifier; it cannot correct a repeated false-negative classification.

**Concrete barrier reproduction:** creator A has an enabled global personal grant with its actual token, and no prior marker in this first-use owner/thread. The global catalog is temporarily malformed/unparseable. `mcpServerConfigs` yields `[]`, `findServerConfig` yields null, `prepare` returns without reservation. An anonymous socket to A's open UUID fails owner validation but is treated as legacy and initializes creator context. This is exactly the new reservation's fail-closed lookup boundary; it does not require a forged identity or an authorized socket.

**Fresh evidence:**

1. Loaded actual `prepare`, the actual global catalog getter and actual `safeJsonParse` in a VM with a malformed catalog and enabled creator grant fixture. Observed `lookupReturnedEmptyInsteadOfError:true`, `reservationCreated:false`.
2. Loaded actual `prepare` plus actual endpoint with the classifier's unresolved-config outcome; fixture handler/provider/database only. Observed `unauthorizedHandlerInit:1` and emitted `fixture-personal-first-input`. This establishes endpoint reachability for the false classification; it is not a live-network/full-chat reproduction. Earlier reviews already established what actual initialization loads; no need to rerun app/DB here.

**Important precision:** with the malformed catalog still present, no new personal tool attaches. The demonstrated leak is the creator's first-use prompt/context loaded without a reservation, not a newly returned personal-tool result. The requirement explicitly protects that first-use context and requires fail-closed lookup. Legitimate definition deletion/disconnection may preserve legacy compatibility where no prior marker exists; an unreadable catalog is **not** evidence of legitimate deletion. Existing durable markers remain protective regardless of catalog failure.

**Required narrowly scoped correction:** make reservation classification distinguish a successfully absent/disabled/non-personal effective definition from failure to read/parse/decrypt it. When classification for the creator's enabled personal grant is unknown, reject before owner-context/handler side effects (or conservatively reserve that specific owner context). Do not convert an unknown classification into anonymous legacy access, and do not introduce blanket gating based on any catalog entry. Add a regression with an enabled creator grant, malformed global catalog, anonymous/other socket first: no handler init, provider/history/files/attachment consumption or private frames. Restore valid config and assert owner operation; preserve disconnected, unrelated-user and truly legacy compatibility. Also exercise thrown grant/config lookup failure to ensure no fail-open catch is introduced.

**Related lookup semantics inspected for this named reason:** `server/models/workspaceMcpServer.js:23–35,49–54` returns null on failed decryption; `hypervisor/index.js:159–175` can then fall back to global config. Strict classification must not mistake an undecryptable workspace shadow for a nonexistent shadow. No separate dynamic exploit is claimed for this secondary path; it is the same absent-vs-unknown distinction to cover in the fix.

## R2-1: normal first-use race is closed, not a catalog-existence gate

`personalMcpContext.js:34–57` scopes enabled grants to persisted `(workspace_id,user_id)`, validates current remote `perUserAuth` config and obtains decrypted tokens with matching definition fingerprint via `PersonalMcpGrant.find` (`server/models/personalMcpGrant.js:102–108`). It does not call provider/discovery/remote boot. `prepare` awaits `mark` at `:58` before socket owner validation and handler construction (`agentWebsocket.js:85–95,118–121`). Independent handler preparation is at `agents/index.js:792–815`, before provider setup and attachments. The durable database context, not a local mutex, is the reservation.

An unauthorized socket arriving **first** also executes `prepare` and marks the same creator scope before it is rejected. A second socket during an in-flight mark likewise must finish its own mark or fail before handler construction. Deferred personal boot therefore no longer creates the original healthy-definition window. Existing marker short-circuit at `personalMcpContext.js:30` preserves protection after disconnect/delete/restart; prior JWT/membership send/message guards are retained unchanged.

`server/__tests__/endpoints/personalMcpActualHandler.test.js:227–323` executes actual route/handler, pauses `activeMCPServers`/boot, rejects anonymous/other competitors without additional init/history/frames, and reads reservation from a **separate Node process** (`:293–306`). That child-process fixture is worker test evidence; this reviewer spawned no child agents or application processes. Definition-free legacy context at `:203–226` and disconnected personal at `:324–359` remain exercised. The deferred test mocks remote boot/default definition and AI start, so it is not itself actual model inference or network websocket evidence. It does not test malformed catalog, which is why R3-1 remains.

## R2-1b: shared transaction ordering closes the reported persistence race

**Source:** `personalMcpContext.js:2–5,62–81,90–116`; `server/models/workspaceAgentInvocation.js:30–60`.

- Both `mark` and `protectCreated` first execute parameterized tagged `$executeRaw` UPDATE on the workspace row **inside** Prisma's interactive transaction, before reading marker state. SQLite obtains its write lock; PostgreSQL obtains a workspace row lock under the normal client transaction isolation. No SQL string interpolation of user input, no remote/network work, and no nested transaction-client API misuse.
- `mark` atomically writes the context and encrypts **all persisted same workspace/user/thread rows** (`:100–113`), not only the supplied UUID. Null thread is `thread_key:0` for context and `thread_id:null` for invocation filtering. Other users/threads are not scanned into that context.
- Invocation creation awaits `protectCreated` after insert and before returning UUID (`workspaceAgentInvocation.js:47–60`). If mark wins, protection sees marker and encrypts the late row. If protection wins, mark's subsequent scan encrypts the already-inserted row. A row inserted while mark's scan is running is caught by postinsert protection before publication. Both transactions cannot read private state concurrently ahead of the common ordering write.
- On lock/query/crypto failure the transaction rejects, and `Invocation.new` returns `{invocation:null,...}` rather than an unprotected UUID (`:62–65`). It may leave an unpublished inserted row on a failed postinsert transaction; no guaranteed crash-time atomic insertion is claimed. The demonstrated successful insert/mark transition and published-row invariant are addressed.

Fresh actual-helper VM probes modeled both mark-first and protect-first ordering: both null-thread rows encrypted, other thread preserved, ordering write before state read. This is semantic source evidence, not a real lock stress run. Worker SQLite regression `server/__tests__/utils/MCP/personalContext.test.js:52–86` defers actual Prisma create, commits mark, releases insert and asserts stored/returned encryption. PG fixture `server/__tests__/e2e/mcp/personal-pg.e2e.test.js:157–217` uses the copied generated PG client and actual `mark/protectCreated`, concurrent transactions, null-thread follow-up and persisted encryption. Thus transaction APIs execute on both SQLite and PG in retained worker evidence.

Bounds: workspace lock is conservative; mark scans historical rows and performs synchronous encryption, so contention/large-history transaction timeout can fail closed. There is no multi-replica/load stress claim and no request to expand this fix into a database redesign. The tests' arbitrary nonnull thread IDs have no thread FK enforcement in these models; production invocation provenance still comes from persisted server context.

## R2-2: application-effective datasource preflight is now correct

`server/scripts/personal-mcp-pg-start.cjs:8–14` selects `ANYTHINGLLM_DATABASE_URL || DATABASE_URL`, requires a PostgreSQL URL, and passes that exact URL as Prisma's `datasources.db.url`. This matches application's explicit override at `server/utils/prisma/index.js:9–15` with a PG-generated default datasource. It checks both new tables, disconnects, then requires app (`pg-start.cjs:15–25`). Failure logs only `PERSONAL_MCP_PG_START_PREFLIGHT_FAILED` and exits 1 (`:27–30`); it does not print URL/credentials. No generate/migrate-deploy call was introduced. The standalone approved additive job remains unchanged, separate from SQLite history.

`server/__tests__/utils/MCP/personalPgTarget.test.js:4–48` checks exact constructor URL with divergent default/override. Fresh reviewer VM probes confirm override selection and failed table preflight exit 1. No real DB contacted by this review.

The isolated real PG startup fixture now tests both directions (`personal-pg.e2e.test.js:222–284`): unmigrated default + migrated override serves authenticated status; migrated default + unmigrated override exits 1 without server startup. The fixture generates copied PG output (`:64–119`), executes the fixed additive job only in its own fixture namespace (`:120–139`), uses random namespaces/dynamic port (`:28–33`) and cleans only those namespaces (`:288–299`). It neither controls the parent's independent integration worker nor replaces the main SQLite client. This is actual application startup/status smoke, not actual full-chat/provider integration proof by itself. Stock Docker entrypoint remains unapproved unless an operator selects the reviewed migration-free artifact.

## Evidence accounting and scope limits

Retained results read here, **not fresh suite reruns**:

- `server/storage/personal-mcp-test-evidence/round3-server.log:2893–2894`: **111 suites / 1,530 PASS**.
- `round3-e2e.log:41–42`: **3 suites / 22 PASS**, including distinct-target PG startup and context-helper execution.
- `round3-covering.log:274–275`: **3 suites / 13 PASS** focused iteration.
- Lint/build/diff-check PASS reported in `docs/plans/personal-mcp-client-report.md:240–246`. Frontend unchanged this round; no browser claim derived from build. Known collector load failures were not repeated.

Parent's fresh message additionally reports real browser A/B/C native connect → Medusa approval → actual AnythingLLM callback/labels, actual AgentHandler/network WebSocket + deterministic local tool model read/update exactly once, real SDK/adapter/Medusa OAuth/role denial, A revoke/B cache isolation, and C first-use other-signed/anonymous socket rejection with zero frames before owner, durable marker/two encrypted prompts and no unauthorized invocation closure. Parent identifies `/private/var/folders/17/xt4yqxps7y74x2_89xt3b2hm0000gn/T/opencode/redball-full-chat/full-chat-report.md`; this worktree-scoped review did **not** read it externally or repeat the app/DB. Record as **parent-supplied actual integration evidence**, not reviewer verification. Parent explicitly says negatives were sequential, not stress, and raw logs discarded: no generic-log proof. It supports healthy-definition behavior and does not test the malformed-catalog barrier above.

**Required next action:** fix and test R3-1 before this scoped security gate can pass. R2-1b and R2-2 are accepted within stated boundaries. F2–F5 remain accepted and untouched by this review. No roles/default permissions, shared keys, production deployments or activation are proposed. Broader browser/proxy/backend/release/activation approvals remain independently owned; no production-readiness claim.
