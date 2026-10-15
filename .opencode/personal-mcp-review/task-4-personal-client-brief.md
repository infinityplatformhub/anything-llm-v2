# Task 4: personal MCP OAuth in anything-llm-v2

Read alongside client-handoff.md and the approved spec. Work ONLY in
/Users/jintawattuitemwong/Documents/GitHub/anything-llm-v2-mcp-oauth/personal-mcp-oauth.
No child workers/reviewers; independent review comes from the parent. No production
changes, push, deploy, broad dependency upgrades, or changes to the old anything-llm.

## Required opt-in and invariants

Add `anythingllm.perUserAuth: true` for remote OAuth servers; it is mutually
exclusive with `perWorkspaceAuth`. Definitions remain admin-managed. Metadata
discovery/client registration may be shared, personal grants may not.

Store grants in a new personal connection table keyed by
`(workspace_id, user_id, server_name)`, with encrypted access/refresh tokens,
expiry, enabled state, public account label, and monotonic version for conditional
updates. Preserve the existing workspace_mcp_connections schema and behavior.
No migration/copy of existing shared credentials into personal rows.

Derive the caller from validated browser session or owner-validated invocation;
never request JSON `userId`, a tool argument, a supplied thread identifier or a
global default. Missing/suspended/nonmember callers fail closed for personal MCP.
Personal grants cannot be accessed through API-key-only agents or scheduled jobs.

Propagate caller identity through OAuth start/callback/disconnect, current status,
server listing, probe/manual call, agent discovery, plugin construction, runtime
call, session/client cache, boot lock, refresh lock, config fingerprint and cleanup.
Revalidate membership/server URL/active user at OAuth callback. A reconnect or
disconnect invalidates stale refresh writes. Revoke remotely then clear only this
user's local connection; failure still blocks local use and is reported honestly.
Definition destination change/delete invalidates all affected personal grants,
pending flows and cached clients, without affecting other definitions.

## Browser UX and ownership

Ordinary authenticated workspace members can connect/disconnect/view their own
personal grant without permission to edit definitions or other grants. Add the
smallest existing member-accessible surface; do not open all management settings.
OAuth callback returns to that surface, not an admin-only page for ordinary users.
State remains bound to the initiating caller and stored single-use verifier.

The invocation websocket currently looks up UUID without ownership checks. For a
personal MCP invocation, validate socket browser identity and creator ownership
before sending tools/introspection/results. Preserve tested legacy behavior.
Personal tool arguments/results/credentials must not enter generic debug logs,
other-user sockets, or broadly readable shared workspace history. Recheck hidden/
suppressed tool authorization at dispatch time, not only initial plugin discovery.

## Tests and preparation

Dependencies were independently APFS-cloned into this worktree; root Jest installed
locally. No symlinks to original deps. Existing SQLite migrations have been applied
to worktree test DB at server/storage/anythingllm.db. Use absolute
ANYTHINGLLM_DATABASE_URL=file:/Users/jintawattuitemwong/Documents/GitHub/anything-llm-v2-mcp-oauth/personal-mcp-oauth/server/storage/anythingllm.db
for tests. This is disposable local data, never production credentials.

Baseline 3 suites / 141 tests PASS:
server/__tests__/endpoints/mcpOAuth.test.js
server/__tests__/utils/MCP/serverConfig.test.js
server/__tests__/utils/MCP/workspaceHypervisor.test.js
Full regression list is in client-handoff.md. Add tests first for A/B in one
workspace, forged IDs, revoked membership, state replay/callback config change,
refresh/disconnect race, personal token ciphertext, ordinary-member UX/access,
owner-bound websocket, private result isolation and unchanged legacy connections.

Production has PostgreSQL Prisma source/client but SQLite migration lock. Provide
an explicitly PostgreSQL-compatible new-table migration path and verify it on a
disposable PostgreSQL DB; do not rewrite or replay old SQLite migrations on PG.
Local new Prisma generation must remain inside this worktree.

HTTP auth failures must not trigger automatic retries of a possibly executed
non-idempotent tool mutation. An explicit rejected-auth response before dispatch
may be retried only when tests prove the mutation was not executed.

## Report and review

Report all files, contracts, test commands/results, RED/GREEN evidence, migrations,
and remaining integration blockers. Do not claim live connectivity until parent
verifies the deployed browser and tools. Only task code may be committed; preserve
all baseline user artifacts and do not use git add -A.
