# Personal MCP local verification evidence

Date: 2026-10-08. Branch: `feat/personal-mcp-oauth`.

All database-backed Jest commands set:
`ANYTHINGLLM_DATABASE_URL=file:/Users/jintawattuitemwong/Documents/GitHub/anything-llm-v2-mcp-oauth/personal-mcp-oauth/server/storage/anythingllm.db`.

Local Node uses the existing `server/__tests__/utils/lark/_polyfill.js` preload for removed SlowBuffer compatibility. Commands run from this worktree root unless stated otherwise.

## Final outputs

```text
Server: node node_modules/jest/bin/jest.js server/__tests__ --runInBand
        --setupFilesAfterEnv ./server/__tests__/utils/lark/_polyfill.js
Test Suites: 107 passed, 107 total
Tests:       1514 passed, 1514 total
Exit: 0

Root: same command without server/__tests__ filter
Test Suites: 7 failed, 109 passed, 116 total
Tests:       1535 passed, 1535 total
Exit: 1 (collector missing dependencies; exact suite names in report)

MCP E2E: node node_modules/jest/bin/jest.js server/__tests__/e2e/mcp
         --runInBand --config '{"testEnvironment":"node","testMatch":["**/*.e2e.test.js"]}'
Test Suites: 2 passed, 2 total
Tests:       21 passed, 21 total
Exit: 0

Frontend: npm run build (cwd frontend)
Exit: 0

ESLint: explicit changed product-file lists (cwd server/frontend)
Exit: 0

git diff --check
Exit: 0
```

PG test environment additionally sets `PERSONAL_MCP_TEST_PG_URL` to the parent-provided disposable `anythingllm_mcp_oauth_test` database at `127.0.0.1:55471`. New table SQL was executed inside a transaction-scoped schema, tested and rolled back; no backend-worker or production schema was touched.

## Observed RED before implementation

| Test iteration | Observed failure |
| --- | --- |
| Personal grant/caller | Missing `personalMcpGrant` module; initial environment error corrected with existing SlowBuffer preload before implementation. |
| Runtime | 7 failures: personal server globally booted, no A/B personal discovery, missing `bootPersonalServer`; then green. |
| Refresh lease | `Grant.acquireRefresh is not a function`; then green for unique DB lease and generation-scoped disconnect. |
| Personal member OAuth | Missing revocation/member route/authorization support; then green with legacy OAuth suite preserved. |
| History privacy | Serialized private result/citations/outputs present in shared save; then redacted. |
| Frontend contract | Personal config rejected; personal chat controls absent; then accepted/mounted. |
| Global swap/delete | Grant remained enabled after swap; scoped invalidation added. |
| Review fixes | Missing global-only invalidation, unsanitized/missing account label, private follow-up prompt stored; then covered green. |
| Aborted follow-up | Pre-registration contained `private-follow-up-aborted`; then placeholder. |
| Provider exception privacy | Generic error output contained `private-echoed-result`; then bounded generic exception without echoed payload. |

Real endpoint callback tests cover websocket owner/other/anonymous/API-only identities without blocking ordinary chat. Actual AIbitat streaming/non-streaming execution tests cover generic trace/log isolation. Real OAuth HTTP and MCP SDK test covers same-workspace A/B call results, rotating refresh and disconnect isolation.

Raw iteration logs remain local under ignored `server/storage/personal-mcp-test-evidence/`. They are not application artifacts and are not needed for the parent patch.

Final transport follow-up: actual HTTP/SDK `tools/call` records a mutation then returns 401/503; each test observes one call and one mutation, no `_authProvider` and no replay. Socket/privacy/PG focused run: 3 suites / 10 tests PASS, exit 0.

## Round 2 superseding results

Read exact `.opencode/personal-mcp-review/final-client-review.md` F1–F5. Fresh local logs:

```text
round2-server.log: 110 suites / 1525 tests PASS, exit 0
round2-e2e.log: 3 suites / 22 tests PASS, exit 0
round2-pg-startup.log: isolated full PG generated client + real app startup PASS
round2-lint.log: changed server product lint PASS, exit 0
round2-frontend-build.log: frontend npm run build PASS, exit 0
git diff --check: PASS
```

Round-2 TDD red logs: `round2-trace-race-red.log` demonstrates private→legacy emitter/introspection leak and deferred chat insert race; `round2-provider-red.log` shows actual Generic OpenAI catch emitted `private-provider-echo`; `round2-context-red.log` shows missing durable context module; `round2-account-red.log` shows nested verified account label absent from own status. Final tests exercise durable owner/private context, actual handler follow-ups/attachments after definition removal, initial expired/other/anonymous denial, current membership/expiry before output, genuinely legacy-only anonymous compatibility, deferred registration abort redaction, actual private→legacy execution, provider wrapper and nested account exchange/refresh→status.

Full PG startup test uses isolated deps/schema/generated output in ignored worktree storage; executes both additive PG SQL files via new explicit migration job, starts actual copied application via migration-free startup artifact, writes the durable marker with PG-generated Prisma and gets 200 from authenticated personal API. Dedicated PG fixture namespace is removed; no SQLite history, main generated client replacement or production startup occurs. Browser/proxy verification remains open. Historical root collector failures are retained, not re-run this round.

## Round 3 superseding results (R2-1/R2-1b/R2-2 only)

Exact review read: `.opencode/personal-mcp-review/client-rereview-2.md`.

```text
round3-red.log: reservation, deferred-create encryption and PG override constructor regressions FAIL before fixes
round3-covering.log: focused regression iteration PASS
round3-server.log: 111 suites / 1530 tests PASS, exit 0
round3-e2e.log: 3 suites / 22 tests PASS, exit 0
round3-lint.log: changed product-file lint PASS, exit 0
round3-frontend-build.log: frontend build PASS, exit 0
git diff --check: PASS
```

First-use test executes actual endpoint/AgentHandler and pauses personal boot/default discovery, rejects competing anonymous/other socket before initialization, reads reservation from a separate process, and retains disconnected-personal compatibility. Deferred actual insert vs mark test verifies encrypted returned/persisted prompt. Existing privacy table uses a first-write workspace-row transaction ordering lock supported by SQLite/PG; no schema/migration changes in round 3. PG-generated actual context helpers execute concurrently in isolated fixture.

Distinct PG datasource startup runs both default-unmigrated/override-migrated (launch succeeds) and default-migrated/override-unmigrated (exit1 before app). Unique fixture schemas/dynamic port avoid independent integration worker conflicts. No production/delegation/roles/commits. Final scoped reviewer approval remains blocking; browser integration is separate.
