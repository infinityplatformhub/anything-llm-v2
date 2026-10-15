# Task 4 — provisional independent preflight review

**Disposition: changes requested on the frozen snapshot; not a final PASS.**

Reviewed `task-4-review-snapshot.diff` against `task-4-personal-client-brief.md` and `client-handoff.md`. The implementation worker is still finishing. This is not a review of its eventual report or final diff.

## Review boundaries and evidence

- No children, implementation edits, deployments, migrations, or test-suite reruns. The only write is this review artifact.
- Implementation paths below are relative to `/Users/jintawattuitemwong/Documents/GitHub/anything-llm-v2-mcp-oauth/personal-mcp-oauth`. Line numbers refer to the **new side of the supplied snapshot**, not an assumed current worktree revision. Snapshot line references are supplied where useful.
- A focused read of `server/utils/agents/aibitat/index.js:990–1339` in that worktree was **permission denied** (`permission.rejected`; non-interactive permission cannot be requested). No alternate access path was attempted. Consequently, unchanged surrounding code, deployment wiring, HTTP/JWT helper behavior, and other execution paths remain unverified.
- Read all 1,660 snapshot lines and both requested briefs. Used a read-only Python parser to calculate new-side hunk line numbers; did not run application code or tests.
- The two review axes below were assessed directly, without subagents, as explicitly requested. No undocumented style rule is treated as a hard violation.

## Spec findings

### S1 — P1: global deletion invalidates unrelated workspace-owned personal definitions

**Paths:** `server/utils/MCP/index.js:358`; `server/utils/MCP/hypervisor/index.js:93–96`; `server/models/personalMcpGrant.js:87–91`; `server/utils/MCP/personalRuntime.js:115–122`.

Deleting a global personal server calls `invalidatePersonalServer(null, name)`. `Grant.invalidate` then omits the workspace predicate and clears **every** personal grant with that `server_name`; runtime cleanup similarly matches every workspace with that name. However, the catalog explicitly supports workspace-owned definitions shadowing global definitions (`server/utils/MCP/index.js:33–35`; snapshot lines 545–547).

**Reproduction:** global `medusa` is personal; workspace W owns its own personal `medusa` pointing at a different server. W's member connects to its owned definition. Delete the global `medusa`: W's tokens are cleared, its generation/version advances, its pending callback becomes unusable, and its cached client is stopped despite its effective definition remaining unchanged.

**Requirement:** task brief lines 31–32 and handoff lines 30–32 require invalidating affected grants/caches **without affecting other definitions**.

**Scoped correction:** invalidate only workspaces whose effective definition resolves to the global definition being deleted, preserving same-name workspace-owned definitions. Add a deletion regression with one global consumer and one workspace shadow, checking grants, pending flow validity, and caches.

### S2 — P1: websocket gate changes legacy invocation behavior merely because a personal definition exists

**Path:** `server/endpoints/agentWebsocket.js:85–94` (snapshot lines 130–139).

The authentication predicate is whether **any effective server definition** has `perUserAuth`, not whether this invocation uses or will expose a personal tool. The endpoint closes a socket without an owner browser session before continuing, even for a legacy-only invocation. A disconnected or unused personal server is enough to trigger this.

**Reproduction:** add a personal definition to a workspace which also uses existing FlowAccount/TNV; open an otherwise legacy-compatible invocation socket using its UUID without the new session subprotocol. It is closed despite no personal tool being requested. API-key-created invocations with no browser owner are also blocked wholesale rather than simply being denied personal tools.

**Requirement:** task brief lines 42–44 requires ownership checks for a personal invocation and preservation of tested legacy behavior; handoff lines 6–9 preserves existing workspace connections. Anonymous/API-key/scheduled callers must fail closed **for personal auth**, not necessarily lose all legacy functionality.

**Scoped correction:** keep personal discovery/execution unavailable unless an owner session is validated, while preserving legacy-only invocation operation. Ensure unauthorized sockets cannot attach to an invocation that exposes private tools/results. Test mixed workspaces, disconnected personal definitions, legacy-only API invocations, and the actual websocket endpoint, not only `fromSocket`.

### S3 — P2: private-history path still persists unredacted prompt content

**Path:** `server/utils/agents/aibitat/plugins/chat-history.js:176–183` (snapshot lines 743–750).

`_storePersonal` replaces the response and omits citations/outputs, but passes the original `prompt` unchanged to `WorkspaceChats.upsert`. Setting `include: false` is not itself a read-access restriction. Thus a personal invocation whose prompt contains private tool input values (for example, an account/customer identifier or credentials supplied by the user), or a subsequent prompt quoting the private tool reply, persists those values in the generic chat row despite `personalMcpUsed` being sticky.

**Requirement:** task brief lines 45–46 and handoff lines 33–34 prohibit personal arguments/results/credentials leaking into broadly readable shared history.

**Confidence boundary:** unredacted persistence is directly visible. The exact downstream history-reader audience could not be inspected due to the worktree access denial; this finding does not claim a demonstrated cross-user HTTP read. Nevertheless, the new path explicitly calls this shared history and does not implement a prompt privacy boundary.

**Scoped correction:** redact/omit the prompt as well on this shared-history path, or demonstrate an existing owner-only storage/read boundary for the whole row. Extend privacy tests with private values in the prompt and follow-up prompts quoting prior results; current tests use only `prompt: 'hello'`.

### S4 — P2: required public account label is absent from persistence and member status

**Paths:** `server/prisma/schema.prisma:160–178`; `server/endpoints/mcpOAuth.js:277–282`; `frontend/src/components/WorkspaceChat/ChatContainer/PersonalMcpConnections.jsx:33–37`.

The new grant model has tokens/expiry/enabled/version but no public account-label field. The member status response exposes only server name, connected/reauth state, and expiry, and the member UI renders only the server name and connection state. There is no way in this snapshot to confirm which provider account a member connected.

**Requirement:** task brief lines 14–17 explicitly requires a public account label. An arbitrary extra value in the encrypted token JSON would not supply the required public member status/UX contract.

**Scoped correction:** persist and return an appropriately sanitized, nonsecret provider account label on the member's own status surface. Do not expose token claims wholesale or broaden member access to definitions/other users' grants.

## Quality findings / evidence gaps

These are limitations of the supplied tests/evidence, not assertions that tests have failed.

### Q1 — P2: endpoint-level websocket and execution privacy regressions are not covered by the added tests

**Paths:** `server/__tests__/utils/MCP/personalPrivacy.test.js:27–40`; `server/__tests__/utils/MCP/personalRuntime.test.js:94–103`; `server/__tests__/utils/MCP/personalFrontend.test.js:15–20`.

The ownership test directly invokes `fromSocket`; it does not exercise websocket registration, handler initialization ordering, actual owner/other-user sockets, or mixed legacy/personal invocation behavior. The logging test invokes the generated plugin handler directly on a stub aibitat, bypassing the actual aibitat execution branches whose logging/emitter behavior changed. The frontend mounting test checks source substrings rather than rendering an ordinary-member session.

These tests cannot establish the end-to-end ownership, generic-log isolation, or legacy websocket preservation required by task brief lines 42–47 and 61–64. In particular, they would not catch S2. Add narrowly targeted integration coverage to the existing endpoint/execution test infrastructure; no unrelated UI redesign is warranted.

### Q2 — P2: PostgreSQL verification and production migration integration remain an open gate

**Paths:** `server/prisma/postgresql/personal-mcp-grants.sql:1–20`; `server/__tests__/utils/MCP/personalPostgresql.test.js:6–32`; `server/prisma/migrations/20261008000000_personal_mcp_grants/migration.sql:1–19`.

The standalone PG SQL is additive and uses PG-compatible syntax, while the SQLite migration is separate. This is the right separation in the snapshot; **no replay of old SQLite history is shown**. The PG test is designed for a guarded localhost disposable DB and rolls back a fixture schema.

However, no worker report/test output or production build/migration path is provided here, and the existing deployment path could not be inspected. The presence of SQL and a test file does not prove successful execution or that production will use the PG path instead of the SQLite migration directory. Final acceptance needs the worker's exact disposable-PG command/results and evidence of the selected production migration procedure, without running/deploying it in this review.

## Requested-risk coverage and residual checks

| Risk | Snapshot assessment (not a PASS claim) |
| --- | --- |
| Workspace/user/server key throughout | DB unique key and personal runtime client/boot keys use all three; global deletion violates effective-definition scoping (S1). Refresh lease is row-scoped. |
| Trusted browser/invocation caller, not body `userId` | `personalCaller.js:18–26` requires the middleware marker and WeakSet-issued caller; `:33–40` checks JWT identity against invocation owner. `validatedRequest.js:109` adds the marker. No body/thread identity use is introduced by this diff. Existing validator/JWT semantics and invocation creation provenance are not available in the snapshot. |
| Suspended/nonmember denial | `personalCaller.js:5–11` queries current user and membership; runtime `target` repeatedly asserts them. Tests cover helper denial and pre-exchange callback denial. Live endpoint and mid-flight denial remain unverified. |
| Callback ownership/destination/single use | Signed-state user, fingerprint/version, pre-exchange and post-exchange checks are visible in `mcpOAuth.js` hunks. Unchanged state consumption code is not fully included. No claim of browser/session ownership beyond the signed initiating state. Tests cover replay/config change before exchange, not all mid-exchange changes. |
| Encrypted tokens, refresh CAS, disconnect tombstone | AES-GCM binds ciphertext to workspace/user/name/fingerprint (`personalMcpGrant.js:15–32`); saves and refresh lease are version-conditional, clears advance version/generation. No legacy-token copy shown. Cross-process refresh contention/lease expiry and slow-revoke/in-flight-call outcomes need final evidence. |
| Admin definitions/member controls | Definition endpoint admin guards remain visible; member connect/status/disconnect use authenticated caller. Member chat surface and non-admin callback destination are added. Account label missing (S4). Full definition/global-admin route wiring not in snapshot. |
| Legacy servers unchanged | Personal boot/global discovery exclusions are present; no legacy connection-schema change shown. Mixed-workspace socket behavior regresses (S2). Existing regression run evidence absent. |
| Websocket caller ownership | Helper checks signed owner identity, but actual endpoint coverage missing (Q1); legacy gating too broad (S2). Current-catalog condition and pre-gate handler initialization need focused final review. |
| Hidden tool dispatch recheck | `personalRuntime.js:79–94` performs fresh list/filter/target/version checks before `callTool`; suppressed/unadvertised tests exist. Final integration must also establish workspace-level hidden/suppressed gating in unchanged agent code, which could not be read. |
| Private generic logs/history | Private plugin flag suppresses selected debug/result emission paths; shared response/citation storage is redacted. Prompt remains unredacted (S3). Other provider verbosity, fallback execution, introspection, attachments, and history-reader paths remain unverified (Q1). |
| Anonymous/API-key/scheduled fail closed | Runtime rejects absent/unissued caller; personal discovery requires caller; API/scheduled identity propagation is not introduced in this diff. Actual entrypoint tests/provenance still needed. Rejecting legacy invocation sockets is not evidence of correct scoped fail-closed behavior. |
| POST mutation auth retry risk | `personalRuntime.js:90–107` calls the tool once and does not implement a retry on 401. Added unit test mocks `Client`, so it does not prove SDK/transport-level no-replay behavior; final focused wire-level evidence is still needed. |
| PG migration not SQLite replay | Separate PG new-table SQL supplied; application/build wiring and successful disposable-PG execution remain unverified (Q2). |

## Final-review handoff

Review the worker's report and final diff before acceptance, including fixes or dispositions for S1–S4, focused tests closing Q1, disposable-PG evidence and migration procedure for Q2, and the previously inaccessible named integration risks above. Do not extrapolate the snapshot's mock tests into live connectivity, regression success, or a final PASS.

**Totals:** Spec: 4 findings (worst: P1 unrelated-definition invalidation and legacy websocket regression). Quality/evidence: 2 findings (worst: P2 integration-test and PG evidence gaps). No unrelated application redesign requested.
