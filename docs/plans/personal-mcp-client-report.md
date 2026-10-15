# Personal Medusa MCP client — local implementation report

Branch: `feat/personal-mcp-oauth`. Worktree: `anything-llm-v2-mcp-oauth/personal-mcp-oauth`.

## Status and boundaries

Implemented the personal client slice locally; **not approved for production rollout**. No commit, push, deployment, role creation, production edit, or child agent was performed. Parent owns final independent review and patch packaging.

The two external brief/handoff reads and the later `task-4-preflight-review.md` read were denied by sandbox permission. No bypass was attempted. Implementation uses the requirements and review findings pasted by the parent. **Parent action:** provide the exact review document within this permitted worktree if evidence beyond the pasted findings needs reconciliation.

## Auth and exact methods

An admin opts a remote server into `anythingllm.perUserAuth: true`. It cannot also set `perWorkspaceAuth: true`; stdio is rejected. URLs remain configurable. No Medusa hostname/resource URL is guessed. Existing workspace/static/global modes keep their existing paths and credentials; the new table starts empty.

* `validatedRequest` records `response.locals.browserSessionUserId` only after verifying a multi-user browser JWT and loading an active user.
* `personalCaller.fromResponse(response, workspace)` issues an opaque process-local caller after current active-user and membership checks. A request `userId` is never used.
* `personalCaller.fromSocket(request, invocation)` verifies a signed session JWT carried in `Sec-WebSocket-Protocol: anythingllm-agent, anythingllm-session.<JWT>` (or a Bearer session header), requires the invocation creator, and rechecks membership. It does not accept a query `userId`.
* `personalCaller.assert(caller, workspace)` rechecks current user status and membership on boot, discovery, and call. Caller capabilities cannot be fabricated by passing an object containing a user ID.
* `personalCaller.fromOAuthState(userId, workspace)` is used after consuming the signed, single-use OAuth state from storage. Callback rechecks it before and after token exchange.
* `PersonalMcpGrant.begin/find/save/clear/clearGeneration/invalidate/acquireRefresh/releaseRefresh` operate on `(workspace_id, user_id, server_name)`. Tokens use AES-256-GCM with owner/definition binding and persistent `SIG_KEY`/`SIG_SALT`; missing keys fail closed. No environment file is written by this model.
* `version` is a compare-and-swap token for writes. `generation` changes on connect/disconnect/config invalidation, but not refresh. The database `refresh_until` lease serializes rotating-refresh use across processes; losers fail closed, rather than replaying refresh. Runtime boot promises are deduplicated per workspace/user/server.
* `MCPHypervisor.bootPersonalServer(workspace, name, caller)` delegates to `PersonalMcpRuntime`. Personal clients never enter global/workspace `mcps` or global loading results. Each runtime cache entry holds a grant version and definition fingerprint; post-connect, post-discovery and post-call checks reject changed/revoked ownership state.
* `MCPHypervisor.callServerTool(workspace, name, request, caller)` dispatches personal tools through advertised, unsuppressed tool enforcement. Personal calls are **never retried**, including after a 401. Expiring credentials refresh before connecting; a tool 401 clears only the matching caller/version and requires reconnect.
* `MCPCompatibilityLayer.activeMCPServers(workspace, caller)` adds personal servers only for a verified caller. Agent defaults, attachment and mid-session toggles propagate `invocation.mcpCaller`. API-only/anonymous/ephemeral job paths have no such capability and cannot expose personal tools.
* The websocket endpoint does **not close ordinary chats** when personal authentication fails or merely because a personal definition exists. It sets no personal caller; legacy tools still run. Personal plugins remain unavailable to other invocation viewers.

### HTTP surface (paths relative to `/api`)

| Method/path | Contract |
| --- | --- |
| `GET /mcp/oauth/start/:workspaceSlug/:serverName` | Personal: active browser workspace member only, for own grant. Legacy: existing admin restriction remains. Returns `{url}`. |
| `GET /mcp/oauth/callback` | Signed state + encrypted verifier, single-use row. Checks workspace ID, definition fingerprint/mode/URL, user active/membership and grant version. Personal redirect goes to `/workspace/<slug>?mcp=<name>&connected=1` or bounded error, not admin settings. |
| `POST /mcp/oauth/disconnect` | Body `{workspaceSlug,serverName}`; ignores supplied `userId`. Personal: refresh/access revocation first, then local clear using authorization generation. Returns `{success:true,remoteRevoked:boolean}`. Remote failure still clears local state; a newer reconnect is preserved. |
| `GET /workspace/:slug/mcp-personal` | Member-only catalog of personal definitions with **own** `{name,connected,needsReauth,expiresAt,accountLabel}`. No tokens, headers, other users' labels or full definitions. |
| `GET /workspace/:slug/mcp-personal/:name/tools` | Current caller's advertised, unsuppressed tools only. |
| `POST /workspace/:slug/mcp-personal/:name/call` | Body `{toolName,arguments}`. Personal MCP tools only, current caller only. No arbitrary URL/method proxy. Per-caller concurrency gate. Returns bounded `{success,result,truncated}`; default output limit 64 KiB. No mutation retries. |

Definition CRUD stays on the existing admin-only management routes. Workspace changes invalidate personal grants before publishing the replacement. Global definition swap/delete invalidates only workspaces not shadowed by a same-name workspace-owned definition, preserving shadowed grants, clients and pending callbacks. Durable fingerprints and callback CAS also prevent old tokens from being used at a changed destination after process restart.

### Provider wire contract

OAuth remains discovery-driven: protected resource metadata comes from the configured MCP origin; its authorization server advertises issuer/registration/authorization/token/revocation URLs. Supports Authorization Code + S256, public client auth method `none`, and rotating refresh. Optional revocation endpoint must be on the issuer origin. Revocation form contains `client_id`, `token`, `token_type_hint`; RFC 7009 empty 200 is accepted. Redirects are not followed when sending credentials.

Parent reports issuer `https://store.teamredball.com`, discovery `/.well-known/oauth-authorization-server`, and `/mcp-auth/{authorize,token,register,revoke}`. Set `SERVER_URL=https://workspace.approof.studio` to produce the registered callback `https://workspace.approof.studio/api/mcp/oauth/callback`; actual MCP resource URL remains undecided. The verified token endpoint's `account: {actor_id,label}` is validated and normalized to the existing bounded internal `account_label`. Only public MCP access/refresh tokens and the sanitized label are retained; the actor ID, raw account object, arbitrary response fields and raw Medusa JWTs are discarded. Label is plain text, controls/angle brackets removed, whitespace normalized, max 120 characters, rendered as React text. No identity is inferred from prompts or caller input.

## Member UX and privacy

`PersonalMcpConnections.jsx` is mounted in both empty and populated workspace chat, an existing member-accessible surface. It offers own Connect/Disconnect and linked-account label. No definition editor or admin settings permission is opened to the default role. Existing admin modal has a mutually exclusive personal OAuth switch and preserves JSON/form round trips.

Personal plugins omit args/results/errors from generic MCP logging/introspection. The AIbitat execution loop omits personal `toolCallResult` trace events and private argument diagnostics. A sticky invocation privacy marker suppresses generic handler/provider diagnostics after private tool context enters the conversation. These are narrow personal-context redactions, not unrelated provider rewrites.

Shared persisted chat receives placeholders for **both prompt and response**, no citations/outputs/attachments, and `include:false` after personal use. Follow-up pre-registration also redacts private input (including abort paths). First-use pre-registered chat is redacted when a personal handler starts. Private replies remain in owner-verified session memory and are passed to the selected LLM for answering; they are intentionally not durable shared chat/history/RAG material. The browser explicitly explains the non-persistence.

## TDD and verification evidence

Raw local logs are retained in the ignored local `server/storage/personal-mcp-test-evidence/` directory (fixture-only credentials/content); the packaged evidence summary is `docs/plans/personal-mcp-evidence.md`.

* Grant/config/caller tests were written first; initial run failed on missing new modules, then 5 tests passed after implementation and local Prisma generation.
* Runtime red: 7 failures, including global personal boot, absent personal methods, empty personal discovery. Green covered A/B client/header separation, CAS refresh/disconnect/reconnect races, no mutation replay, suppressed/unadvertised tools, no private plugin logs.
* Refresh lease red: `Grant.acquireRefresh is not a function`; green checks lease uniqueness and generation-aware disconnect preserving reconnect.
* OAuth/member tests written before routes: ordinary member connect, own-only status/disconnect, callback membership/suspension/destination changes, single-use state, stale callback, remote revoke order/failure, reconnect during revocation, legacy admin restrictions.
* Privacy red demonstrated private derived response/citations/outputs in `_store`; follow-up red demonstrated pre-registration storing a private prompt. Green replaces prompts/responses and excludes retrieval. Private provider diagnostics test failed before the privacy guard.
* Review S1/S3/S4 red bundle failed for absent global-scoped invalidation, unredacted follow-up prompt, and missing sanitized label. Green tests cover global-vs-shadow grants/clients, private follow-up, and discarding raw provider identity fields.
* Real websocket endpoint callback tests (not just helper/string tests) cover owner, other member, anonymous, API-only session; ordinary cluster still starts while only owner obtains personal capability.
* Actual AIbitat streaming and non-streaming execution tests assert no private args/results in trace listeners or generic diagnostics.
* Real OAuth HTTP + Prisma + **real MCP SDK** integration test uses two accounts in one workspace; actual calls return A/B-specific company data, refresh only A, disconnect only A, and assert no issued token/result leakage in logs. Existing legacy MCP E2E is preserved.

Recorded focused gate before final formatting: **20 suites / 348 tests PASS**. MCP E2E: **2 suites / 19 tests PASS**. Root-wide Jest attempt: **109 suites / 1533 tests PASS**, but **7 collector suites fail to load** because isolated collector dependencies are absent (listed below); this is not a green full-project claim.

Root Jest invocation:

```sh
STORAGE_DIR="$PWD/server/storage" \
PERSONAL_MCP_TEST_PG_URL='postgres://medusa:local-mcp-test-only@127.0.0.1:55471/anythingllm_mcp_oauth_test' \
ANYTHINGLLM_DATABASE_URL='file:/Users/jintawattuitemwong/Documents/GitHub/anything-llm-v2-mcp-oauth/personal-mcp-oauth/server/storage/anythingllm.db' \
node node_modules/jest/bin/jest.js --runInBand \
  --setupFilesAfterEnv ./server/__tests__/utils/lark/_polyfill.js
```

The existing SlowBuffer test preload is necessary with local Node 25/jsonwebtoken. No product dependency changes were made. Collector load failures:

* `collector/__tests__/utils/extensions/WebsiteDepth/index.test.js`: missing `langchain/document_loaders/web/puppeteer`.
* `collector/__tests__/utils/extensions/RepoLoader/GithubRepo.test.js`: missing `@langchain/community/document_loaders/web/github`.
* `collector/__tests__/utils/extensions/RepoLoader/GiteaRepo.test.js`: missing `ignore`.
* `collector/__tests__/utils/extensions/Confluence/ConfluenceLoader.test.js`: missing `slugify`.
* `collector/__tests__/utils/WhisperProviders/ffmpeg/index.test.js`: missing `fix-path`.
* `collector/__tests__/processLink/helpers/htmlToMarkdown.test.js`: missing `turndown`.
* `collector/__tests__/utils/downloadURIToFile/index.test.js`: missing `dotenv`.

Collector dependencies/source were not modified to paper over unrelated failures.

## Migration route — PostgreSQL, not SQLite history

Production information supplied by parent: live schema/generated client use `postgresql` + `env("DATABASE_URL")`; entrypoint still runs `prisma generate` then `migrate deploy`; historical migration contains SQLite `AUTOINCREMENT` and SQLite lock. Direct pod env did not show database variables; dotenv may hold them. **Do not print dotenv/secrets or treat the current entrypoint as a safe PG migration strategy.**

New artifacts:

* SQLite development migration: `server/prisma/migrations/20261008000000_personal_mcp_grants/migration.sql`.
* Standalone PostgreSQL additive transaction: `server/prisma/postgresql/personal-mcp-grants.sql`.

No old migration was rewritten. No old token copy/backfill SQL exists. Development DB was migrated locally; generation stayed in this worktree. The evolving, unpublished new migration gained generation/refresh lease fields; the disposable SQLite DB was updated locally to match. Do not treat its local migration checksum as release evidence; validate the final migration on a fresh fixture.

### Tested PG procedure

`personalPostgresql.test.js` connects only to parent-authorized `anythingllm_mcp_oauth_test` on `127.0.0.1:55471`. It starts a transaction, creates an isolated fixture schema + minimal existing users/workspaces, executes the **actual standalone PG DDL**, verifies A/B unique scope, stale-write CAS, timestamps/defaults, and user/workspace FK cascades, then rolls back. It never touches `redball_mcp_oauth_test`, other worker data, production, or original client data. It does not replay SQLite history or alter `_prisma_migrations`.

### Explicit production rollout plan (operator/parent only, after gates)

1. Finish independent review and real-browser/provider integration gates below; confirm live database provider/name, backup and stable encryption keys privately.
2. Build an immutable PG-specific release artifact **outside the live pod**. Use the confirmed PG schema with this new model and inverse user/workspace relations; generate the PG client in isolated release/worktree output. Do not regenerate live schema from this SQLite default or copy this worktree's SQLite-generated `node_modules` into production.
3. Arrange a reviewed startup override/new release entrypoint that starts the server **without automatic `prisma migrate deploy`**. The current `/usr/local/bin/docker-entrypoint.sh` cannot be assumed safe. Do not restart the old entrypoint as a migration shortcut. Do not rewrite old migration SQL/lock/history.
4. Apply only `server/prisma/postgresql/personal-mcp-grants.sql` through an operator-owned PG migration job, using the privately confirmed PG connection. Example, after setting `PG_SERVICE_URL` securely (never echo it): `psql "$PG_SERVICE_URL" -v ON_ERROR_STOP=1 -f server/prisma/postgresql/personal-mcp-grants.sql`. This file uses one transaction and fails on an unexpected pre-existing table instead of silently accepting drift. Verify empty new table, columns/indexes/FKs and no legacy-table changes.
5. Record this standalone migration in the deployment's PG migration system. Do not mark/replay the SQLite history in Prisma. If Prisma migration deployment is required later, design a separately approved PG baseline/history strategy; it is not part of this patch.
6. Deploy the already-generated PG artifact with the migration-free startup override, initially no personal definition enabled. Confirm both legacy and personal smoke tests using two real member sessions. Configure the final resource URL and callback only after parent backend approval.
7. Rollback application with personal feature disabled if needed; leave the additive table intact rather than destructively dropping user grants. Any table-removal/data deletion requires separate approval.

Not executed: production job, production entrypoint override/deployment, or production smoke tests. Round 2 additionally verifies isolated full PG schema/client/application startup locally (details below); this is not a claim of production schema compatibility.

## Remaining gates / integration limits

* Parent's final independent security review remains required. Exact external review document inaccessible; only pasted findings were consumed.
* No real-browser A/B Playwright login/OAuth UI flow or browser WebSocket handshake through production proxy has been run. Endpoint callbacks and real SDK/OAuth HTTP are covered locally; verify subprotocol handling, TLS/proxy routing and member-visible UX in real browsers.
* Actual Medusa OAuth backend final review and resource deployment URL remain pending. Test protected-resource metadata, advertised scopes, nested public `account: {actor_id,label}`, client registration/callback whitelist, refresh rotation and revocation against that service. No hardcoded guessed resource.
* Local full PG generated-client/application startup is verified in round 2; production-schema compatibility and operator-approved replacement startup remain rollout gates. No SQLite history is replayed on PG.
* Refresh losers and transient failures fail closed; there is no cross-process wait/retry loop. SDK calls retain existing request deadlines; per-caller HTTP concurrency is process-local. Do not claim multi-replica stress verification.
* Privacy requires private result content to reach the selected LLM and verified owner's socket; this is not a zero-external-processing feature. Shared durable history is redacted, so private replies/follow-ups intentionally do not survive reload.
* Root-wide suite is blocked by absent collector dependencies; no collector packages or unrelated source are edited.

## File inventory

New product files: `server/models/personalMcpGrant.js`, `server/utils/MCP/personalCaller.js`, `server/utils/MCP/personalRuntime.js`, both migration SQL files, `frontend/src/components/WorkspaceChat/ChatContainer/PersonalMcpConnections.jsx`.

Modified product files: `server/prisma/schema.prisma`; `server/utils/middleware/validatedRequest.js`; `server/endpoints/{mcpOAuth,workspaceMcpServers,agentWebsocket}.js`; `server/utils/MCP/{index,oauth,serverConfig}.js`; `server/utils/MCP/hypervisor/index.js`; `server/utils/agents/{defaults,index}.js`; `server/utils/agents/aibitat/index.js`; `server/utils/agents/aibitat/plugins/chat-history.js`; `server/utils/agents/aibitat/providers/ai-provider.js` (personal-context guard only); `frontend/src/models/workspaceMcp.js`; `frontend/src/components/WorkspaceChat/ChatContainer/index.jsx`; `frontend/src/pages/WorkspaceSettings/AgentConfig/McpConnectors/ServerModal.jsx`.

New tests: `server/__tests__/utils/MCP/personal{Client,Runtime,Privacy,Execution,Frontend,Postgresql,Revocation}.test.js`; `server/__tests__/endpoints/personalMcp{OAuth,Socket}.test.js`; `server/__tests__/e2e/mcp/personal.e2e.test.js`. Existing legacy tests were not rewritten.

## Fix-loop round 1 delta

* S1: global deletion/config-sync uses `invalidateGlobalPersonalServer`; workspace-owned shadows are excluded from grant invalidation and client closure. Callback versions/fingerprints preserve shadowed pending flows.
* S2: endpoint ownership check only grants a personal caller; failed/no browser identity does not close or gate ordinary legacy agent invocation. Endpoint tests execute the real route callback with owner/other/anonymous/API-only identities.
* S3: redact persisted prompt as well as response; follow-up pre-registration and first-use tracked row also redact on private context. Privacy marker remains sticky across later turns. Tests include private follow-up input and aborted-turn pre-registration.
* S4: store sanitized public label inside encrypted grant, return only own `accountLabel`, render as React text in member chat; strip unrecognized identity fields/raw JWTs.
* Q1: actual streaming/non-streaming execution tests and actual websocket endpoint callback tests added. Real network browser/proxy handshake remains explicitly unverified.
* Q2: independent PG DDL verification and operator-only PG deployment procedure above; no SQLite history replay.

### Final local gates

* Server-wide Jest: **107 suites / 1,514 tests PASS**, exit 0, after final privacy fixes.
* Root-wide Jest: **109 suites / 1,535 collected tests PASS**; **7 collector suites fail to load**, exit 1, exclusively the missing dependencies listed above. Not a fully green root run.
* MCP E2E (legacy + personal real SDK): **2 suites / 21 tests PASS**, exit 0 (final run includes actual HTTP 401/503 after mutation; remote mutation counter remains exactly one).
* Dedicated PG migration test: PASS as part of server-wide gate; fixture schema/rows rolled back.
* Final SQLite new-table SQL: PASS against fresh in-memory fixture including generation/lease columns.
* Frontend `npm run build`: PASS, exit 0. Existing bundle-size/dependency warnings remain; no real-browser claim.
* ESLint on all changed server/frontend product files: PASS, exit 0.
* `git diff --check`: PASS; no prior migration/package/lockfile edits and no commits.

An additional red/green execution regression proves private-context provider exceptions no longer log an echoed private result; it changes only the shared execution error boundary, not unrelated provider implementations.

Controller follow-up gate: real installed StreamableHTTP SDK uses fixed bearer headers without `_authProvider`; an actual HTTP server advertises `mutate`, records the mutation and then returns 401 or 503. Both parameterized tests assert exactly one remote call/mutation and no application retry. Mixed legacy/personal websocket endpoint tests execute the actual route callback, continue legacy cluster/tool behavior for owner/other/anonymous/API-only identities, and permit personal behavior only to the owner. Final focused socket/privacy/PG run: **3 suites / 10 tests PASS**. No real-browser handshake claim is made.

## Fix-loop round 2 — exact F1–F5 review

Read `.opencode/personal-mcp-review/final-client-review.md` in full. Its actual-source probes were treated as uncovered paths, not dismissed on prior green tests.

### F1: durable owner-private context before init and every emission

`personal_mcp_contexts` is an additive privacy-only table keyed `(workspace_id,user_id,thread_key)`; `0` is the stable null-thread sentinel. User/workspace FK cascades apply; definition/grant deletion never deletes this marker. `PersonalMcpContext.mark(invocation)` persists it **before personal tool discovery/exposure**, encrypts an existing invocation prompt, and sets sticky runtime privacy. Subsequent invocations in that exact owner/thread context encrypt their persisted prompt, carrying protection across process restart or definition removal.

The socket endpoint fetches only invocation metadata and the marker before constructing/initializing `AgentHandler`. Private contexts require a signed owner session, current active membership, and valid JWT. Unauthorized/expired/other-owner sockets close before provider setup, attachments, history, files or output. Genuinely legacy-only context is unchanged; a mere personal catalog entry does not close it. `AgentHandler` independently checks before provider setup/attachment consumption/history/file loads/start, decrypts private prompts only after authorization, and carries sticky state into fresh AIbitat instances.

All actual socket transmissions are queued through a guard that rechecks durable context, JWT validity/expiry and current user/membership immediately before sending; messages/feedback use that guard too. Existing personal caller capabilities retain their socket token and `assert` verifies it again. The app has no persisted browser logout-token revocation list; membership removal, suspension and expiry are enforced; logout-only client storage deletion does not magically invalidate a still-valid signed JWT (remaining system-session limitation).

New actual-handler tests use real `AgentHandler.init/createAIbitat/startAgentCluster`, real websocket plugin and database, with default agent definitions/model start stubbed to avoid live inference. Tests cover quoted private follow-up + cached attachment, owner/other/anonymous/expired session, definition removal, denial before init/history/attachment consumption, owner-only output, membership/expiry revocation before emission, and genuinely legacy-only anonymous behavior. This is stronger than the prior mocked-handler route tests but still not real-browser/proxy verification.

### F2–F4: sticky diagnostic boundaries and async registration

* Streaming and non-streaming execution suppress generic args/results/`toolCallResult` for **later legacy tools** once private context is sticky. Legacy MCP plugin diagnostics and websocket introspection also check sticky state.
* The chat pre-registration listener rechecks privacy immediately after awaited insertion, redacting prompt/response even on abort before registering the ID. Deferred-create → first private flip → abort regression reproduced the original race and now passes.
* All 32 direct `console.error(error.message,error)` catches across 31 agent provider wrappers now have the same narrow `!this.invocation?.personalMcpUsed` guard. No provider requests/retries/model behavior changed. Actual Generic OpenAI streaming wrapper test reproduced the echoed private exception before the guard and now verifies omission. Other wrappers were audited/guarded statically and covered by server regression, not all dynamically fault-injected.

### F5: real nested public account contract

Token parser validates nested `account` object, nonempty string actor ID and string label, then sanitizes only the label into `account_label`. Real OAuth HTTP exchange and rotating refresh → encrypted grant → **own status** test now uses `{account:{actor_id,label}}`; A label remains A after refresh while B is isolated. Whole identity objects/raw JWT fields are not persisted.

### Q2: executable additive migration + migration-free PG startup

Added executable Node artifacts (run with `node`, not the old Docker entrypoint):

* `server/scripts/personal-mcp-pg-migrate.cjs`: requires explicit `PERSONAL_MCP_PG_MIGRATION_APPROVED=true` and privately supplied `DATABASE_URL`; runs only `personal-mcp-grants.sql` plus `personal-mcp-contexts.sql` in one PG transaction. Sanitized success/failure output; no history replay/generate/schema mutation.
* `server/scripts/personal-mcp-pg-start.cjs`: validates an already-PG-generated client against `current_database()`, checks both new tables, disconnects preflight client, then launches the real `server/index.js`. No generation or `migrate deploy`. Use an operator-reviewed container startup override invoking this file after additive migration.

`personal-pg.e2e.test.js` connects only to the dedicated localhost `anythingllm_mcp_oauth_test`, builds a full fixture schema in its own `personal_client_full_startup` namespace, copies application source/deps with isolated Prisma output, changes only that copied schema to PostgreSQL, `db push`es the full empty fixture schema, generates the full PG client, replaces only fixture new tables using the executable additive job, and starts the real copied application using the startup artifact. An authenticated member request to `/api/workspace/pg-startup/mcp-personal` returns 200; the durable marker writes through the PG-generated Prisma client. The fixture schema is dropped at cleanup. Neither main SQLite client nor backend-worker namespace nor original data nor production entrypoint is touched. Local copied artifacts remain ignored under `server/storage/personal-pg-integration-*`.

Both SQLite/PG context migrations are additive; prior migration files/history remain untouched. For production, apply both files/job after schema/provider/backup approval and ship an isolated PG release artifact; do not invoke the stock generate + migrate-deploy entrypoint. These scripts are explicit scope-limited release artifacts, not a general SQLite→PG migration tool.

### Round 2 fresh gates

* Server: **110 suites / 1,525 tests PASS**, exit 0 (`round2-server.log`).
* MCP E2E including full PG startup: **3 suites / 22 tests PASS**, exit 0 (`round2-e2e.log`). Includes legacy E2E and actual HTTP/SDK no-replay counters.
* Changed server product ESLint: PASS. Frontend build: PASS (`round2-frontend-build.log`). `git diff --check`: PASS.
* Previous root-wide run's seven collector load failures remain documented; no collector dependency work was performed, and root-wide was not repeated for this scope-limited round.

New files this round: `server/models/personalMcpContext.js`, SQLite/PG context SQL, both `server/scripts/personal-mcp-pg-*.cjs`, `personalMcpActualHandler.test.js`, `personalContext.test.js`, `personalProviderPrivacy.test.js`, `personal-pg.e2e.test.js`. Existing websocket harness fixture was extended with the new metadata lookup so unchanged hostile-frame assertions still run; its behavioral assertions were not relaxed. Existing mock OAuth provider now emits the supplied nested account contract. Remaining new provider changes are only the named privacy guards; no roles/deployments/commits/child agents.

Final independent scoped re-review remains required. Browser A/B UX, production proxy handshake, actual approved backend integration and production activation/human role gate remain separate and open.

## Fix-loop round 3 — R2-1 / R2-1b / R2-2 only

Read `.opencode/personal-mcp-review/client-rereview-2.md` in full. F2–F5 and accepted global shadow exclusion were not reopened. No production operations, children, roles, commits, dependencies or migration-history changes this round.

### R2-1: reserve before first-use preparation

New `PersonalMcpContext.prepare(invocation)` classifies the **persisted invocation creator's** enabled personal grant against the currently effective definition and its fingerprint. It requires an actual decrypted access token and a valid remote `perUserAuth` config. It does not call personal boot/discovery/provider code and does not infer eligibility from mere catalog existence, the socket viewer, or request userId. If the creator has a connected personal capability, it calls `mark()` **before socket ownership validation/handler construction**, and `AgentHandler.init()` independently calls it before provider/attachment/history preparation.

The existing durable `(workspace,user,thread)` marker is the reservation for this invocation's owner context. The current UUID prompt and all same-context invocation prompts are protected within the same database transaction as the marker. Other/anonymous sockets arriving first or during deferred personal boot therefore see the reservation before initializing; definition disconnect/removal never clears it. A disconnected grant, unrelated user's grant or truly legacy-only context does not create a reservation.

`mark()` now first performs a parameterized no-op write on the existing workspace row inside the Prisma transaction, then writes the marker and encrypts all same-context plaintext invocation prompts. This establishes a DB-supported ordering point: PostgreSQL row lock / SQLite write lock, before reading state. There is no process-local mutex, invented permission, request-controlled identity, provider execution or mutation retry. Workspace-level lock granularity is conservative and short-lived; no remote/network operation is held inside the transaction.

Actual endpoint + actual AgentHandler test pauses owner preparation in `activeMCPServers`/personal boot, connects anonymous and other-member sockets to the same UUID, and checks no competitor init/history/output. The reservation is also read by a separately started process, proving it is not a local boolean. Legacy disconnected-personal and unrelated/legacy anonymous cases remain passing.

### R2-1b: deferred invocation insert vs mark

`PersonalMcpContext.protectCreated(invocation)` obtains the same DB ordering lock and rechecks the marker **after the awaited insert and before returning/publishing the UUID**. If mark committed before insertion/protection, the new prompt is encrypted. If protection finishes first, subsequent `mark()` scans/encrypts every persisted row in that context, including this one. Thus the transition cannot commit while leaving a same-context persisted plaintext row; pre-transition inserts can temporarily be plaintext before publication, as in legacy behavior, but are protected on the postinsert/transition boundary. A failed transaction returns no invocation through the existing model failure path rather than publishing an unprotected UUID.

Regression: deferred actual Prisma `create` → concurrent durable mark → release insert asserts both returned and persisted prompt are encrypted. SQLite runs this against the disposable DB; PG fixture runs actual `mark`/`protectCreated` concurrently on its isolated generated client and checks persisted encryption. No new field/table/migration is required: this tightens transaction use of the already-additive privacy table.

### R2-2: preflight effective datasource

`personal-mcp-pg-start.cjs` explicitly selects `ANYTHINGLLM_DATABASE_URL || DATABASE_URL`, requires a PostgreSQL URL, and passes that exact value as the Prisma datasource override before checking the two tables or requiring the application. It now matches `server/utils/prisma/index.js` precedence; no URL/credentials are printed and no generation/history migration is added.

VM constructor regression first failed because the old preflight had no datasource options. Isolated real PG application test now uses **distinct URLs/schema targets** in both directions:

* `DATABASE_URL` points to an unmigrated fixture namespace, override points to the migrated namespace: preflight and authenticated application API succeed against the override.
* Default points to migrated namespace, override points to unmigrated namespace: startup exits 1 with the bounded preflight message and never launches the application.

The PG fixture now uses unique `personal_client_fix3_<random>` namespaces and an allocated dynamic HTTP port, cleans only its own fixture namespaces, and does not conflict with/control the independent real-app integration worker. It still generates only copied PG Prisma output; main SQLite client/production entrypoint remain untouched.

### Round 3 TDD / fresh gates

`round3-red.log` records failing connected-personal reservation, deferred-create encryption and divergent-target constructor tests before these fixes. `round3-covering.log` is the focused green iteration. Final retained logs under ignored `server/storage/personal-mcp-test-evidence/`:

* `round3-server.log`: **111 suites / 1,530 tests PASS**, exit 0.
* `round3-e2e.log`: **3 suites / 22 tests PASS**, exit 0; legacy MCP, personal HTTP/SDK and distinct-target full PG startup included.
* `round3-lint.log`: changed round-3 server product files PASS, exit 0.
* `round3-frontend-build.log`: `npm run build` PASS, exit 0; frontend source unchanged this round.
* `git diff --check`: PASS.

No root-wide rerun/dependency scope expansion; historical collector load failures remain as previously documented. Final **scoped security re-review is required before acceptance**, not deferred as a nonblocking concern. Browser/proxy/live backend/production activation gates remain separate; no production-ready claim is made.

## Fix-loop round 4 — R3-1 strict classification only

Read `.opencode/personal-mcp-review/client-rereview-3.md` and the latest round-3 report. This round addresses only the absent-versus-UNKNOWN first-use classification blocker. No children/reviewers, commits, roles/permissions, dependencies, deployment or production operations. Previous healthy full-chat results remain parent-supplied evidence; no new browser/full-model-chat claim is made here.

### Source APIs and authoritative outcomes

* `server/utils/MCP/hypervisor/index.js`: new static `MCPHypervisor.findServerConfigStrict(name, workspaceId)`, inherited by the compatibility layer. Classification passes the **persisted invocation workspace ID**, not its embedded workspace object, socket viewer or request identity. The static read avoids the hypervisor constructor's file-creation/setup path. It resolves only names from the persisted creator's enabled grants, checks the authoritative workspace override first, and reads global configuration only after a successful absent-workspace result. A present but unreadable override never falls back to global. A healthy workspace override can classify without consulting an unhealthy irrelevant global catalog.
* The strict global read uses actual `fs.readFileSync` + `JSON.parse`, with no repair/extraction/fallback. Root must be a non-array, non-null object with its own non-array, non-null `mcpServers` object. Empty/whitespace files, missing files/read failures, malformed JSON, missing `mcpServers`, arrays/null and invalid relevant definition/auth flag shapes are UNKNOWN. Successfully read `{"mcpServers":{}}` is healthy absence; target lookup uses own properties. Only the relevant target is classified/validated, so unrelated malformed entries do not create a blanket catalog gate. Existing `mcpServerConfigs`, `findServerConfig`, `safeJsonParse` and lenient discovery semantics are unchanged.
* `server/models/workspaceMcpServer.js`: new `WorkspaceMcpServer.findStrict(workspaceId, name)` distinguishes no persisted row from failed lookup/decryption/JSON/config validation. Decryption explicitly requires the existing `SIG_KEY` and `SIG_SALT` and passes those exact values to `EncryptionManager`; it never generates/replaces keys or writes environment files. Crypto error logging is suppressed; only bounded `personal_config_unavailable` escapes. Existing lenient `find`/`listDecrypted` remain unchanged.
* `server/models/personalMcpContext.js`: `prepare` wraps the strict classifier (`prepareStrict`) with bounded `personal_context_unavailable`. Existing durable markers short-circuit as before. Creator enabled names alone are consulted; healthy deletion/disabled/nonpersonal or changed-definition fingerprint outcomes remain unmarked legacy where no prior marker exists. For a current personal definition, actual `Grant.find` must successfully decrypt a matching enabled grant with a nonempty string access token; corrupt/missing token data or thrown grant/config queries reject rather than becoming absence. No discovery/provider/remote execution occurs here.
* `server/endpoints/agentWebsocket.js`: classification is marked in progress before `prepare` and the marker read; failure closes silently without handler initialization or a generic error frame/log. The same bounded classification error from independent `AgentHandler.init` also closes silently. Socket ownership and existing emission/message rechecks remain unchanged.

`lock`, `mark`, `protectCreated`, cross-process reservation, shared transaction ordering and all-context prompt encryption are unchanged. No database or migration changes.

### Actual endpoint regressions and TDD

`server/__tests__/endpoints/personalMcpActualHandler.test.js` executes the actual registered endpoint, classifier, Prisma grant/config data, crypto and actual `AgentHandler`. Initial RED: **12 failed / 10 passed**, showing malformed-global unauthorized initialization, corrupt-shadow global fallback/reservation, and generic frames on corrupt-token or thrown lookup failure (`round4-red.log`). Additional strict-format/provenance tests were written before the new API (`round4-strict-red.log`); the first endpoint command needed `STORAGE_DIR` before it could collect, then the behavior failures were reproduced.

Final negative matrix is anonymous/other-member **first**, across malformed global, empty file, missing block, null/array catalogs, read failure, corrupt encrypted shadow, thrown shadow lookup, corrupt/missing grant tokens, thrown grant-list/grant-find and strict-config lookup. Assertions: closed socket, **zero frames**, no handler init/provider setup/history/files/default-definition/AI start, no marker or invocation closure, and independent handler init also rejects before provider/attachment consumption. Restoring healthy config/shadow/tokens/query allows the actual owner to reserve, initialize, consume the still-retained original attachment and emit the owner input. The model start/default definition remain fixtures; this proves endpoint/handler boundaries, not actual model inference or network-websocket stress.

Actual endpoint positive cases preserve deleted, disabled, nonpersonal and unrelated-user anonymous legacy operation without reservation (including unreadable catalog when the creator has no enabled grants). Existing disconnected and durable-marker tests remain. New `personalStrictConfig.test.js` also covers exact current-format/empty behavior, own-property lookup, relevant-invalid versus unrelated-invalid entries, missing-file no creation, original signature requirements/no environment writes, decryptable invalid shadows, and persisted workspace-ID provenance. Existing separate-process reservation and insertion/privacy tests remain passing. The older first-use test now cleans its enabled grant fixture, preventing it from contaminating the unrelated-user case; its assertions were not relaxed.

### Fresh verification evidence

Logs retained under ignored `server/storage/personal-mcp-test-evidence/`:

| Gate | Evidence | Result |
| --- | --- | --- |
| Covering endpoint/strict/context | `round4-covering.log` | **3 suites / 72 tests PASS**, exit 0 |
| All server unit suites | `round4-server.log` | **112 suites / 1,589 tests PASS**, exit 0 |
| MCP E2E: legacy, personal HTTP/SDK, isolated PG startup/transaction | `round4-e2e.log` | **3 suites / 22 tests PASS**, exit 0 |
| Changed server product ESLint (no fix) | `round4-lint.log` | PASS, exit 0 |
| Root-wide Jest | `round4-root.log` | **114 suites / 1,610 tests PASS; 7 collector suites fail to load**, exit 1 |
| `git diff --check` | Fresh command | PASS |

Commands used root `node node_modules/jest/bin/jest.js --runInBand` with `NODE_ENV=test`, absolute `STORAGE_DIR`/disposable `ANYTHINGLLM_DATABASE_URL` and synthetic `SIG_KEY`/`SIG_SALT`. Server command selected `server/__tests__` and used `--setupFilesAfterEnv ./server/__tests__/utils/lark/_polyfill.js`; covering selected the three files above. E2E selected `server/__tests__/e2e/mcp` with inline node/testMatch config and the previously authorized local `PERSONAL_MCP_TEST_PG_URL`. Root command selected no path and used the same polyfill. ESLint ran from `server` against `models/personalMcpContext.js`, `models/workspaceMcpServer.js`, `utils/MCP/hypervisor/index.js`, `endpoints/agentWebsocket.js`. No frontend edits/build this round.

Root failures are the same seven previously documented missing collector dependencies: `RepoLoader/GithubRepo.test.js` (`@langchain/community/document_loaders/web/github`), `WebsiteDepth/index.test.js` (`langchain/document_loaders/web/puppeteer`), `RepoLoader/GiteaRepo.test.js` (`ignore`), `Confluence/ConfluenceLoader.test.js` (`slugify`), `WhisperProviders/ffmpeg/index.test.js` (`fix-path`), `processLink/helpers/htmlToMarkdown.test.js` (`turndown`), `downloadURIToFile/index.test.js` (`dotenv`), all under `collector/__tests__`. No collector changes or green full-project claim.

**Independent R3-1 scoped security re-review remains required before acceptance.** The security finding is not parked or downgraded; this report records implementation/test evidence, not reviewer approval or production readiness. Browser/proxy/backend/release and production rollout remain separately owned and untouched.
