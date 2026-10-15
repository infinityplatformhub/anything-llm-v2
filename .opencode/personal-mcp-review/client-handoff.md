# Personal Medusa MCP client handoff

Implementation repository:
/Users/jintawattuitemwong/Documents/GitHub/anything-llm-v2-mcp-oauth/personal-mcp-oauth

Approved scope: personal MCP OAuth connection, caller identity isolation, and
current Medusa role enforcement. No new role definitions/assignments, no migration
of the store, no unrelated LLM features. Existing FlowAccount and TNV connections
must keep their workspace behavior.

## Read-only audit conclusions

- Add explicit perUserAuth opt-in. Preserve perWorkspaceAuth for legacy servers;
  never clone old workspace grants into personal rows.
- Key personal persistence, enablement, status, client caches, boot/refresh locks,
  probe/manual call, disconnect by workspace/user/server.
- OAuth state currently includes userId, but saveTokens discards it. Personal
  callback rechecks active user, current membership and current server destination.
- Browser agents persist invocation.user_id. Propagate it into discovery,
  conversion and execution; derive identity only from authenticated context.
- API thread userId is request-supplied. Anonymous/API-key-only agents and jobs
  fail closed for personal auth. A cached client must never supply missing identity.
- Invocation websocket currently loads by UUID without owner validation. Personal
  paths require socket ownership verification before exposing tools/results.
- Ordinary members may manage only their own personal grant; server-definition
  CRUD/global administration remains under existing admin controls.
- Existing token persistence is plaintext; new personal credentials encrypted.
- Conditional refresh persistence prevents a stale refresh overwriting disconnect
  or reconnect; simultaneous calls use one refresh for the same personal grant.
- Server URL/config replacement or definition deletion invalidates all personal
  grants, pending flows, caches for that definition. Per-user disconnect touches
  only that user's grant and should call remote revocation.
- Tool logs currently include full args/results. Personal MCP outputs must not
  leak through shared logs/history or another user's websocket/invocation.

## Production storage gate

Live pod confirms Prisma source and generated-client provider are postgresql.
Checked-in repository schema and migration lock use sqlite. Production migration
must be separately rendered/verified for PostgreSQL; do not deploy existing
SQLite AUTOINCREMENT/DATETIME migrations to PostgreSQL. Inspect the current
deployment build path before introducing migrations; do not rewrite old history.

## Tests to preserve and extend

server/__tests__/endpoints/mcpOAuth.test.js
server/__tests__/endpoints/workspaceMcpStatus.test.js
server/__tests__/endpoints/workspaceMcpList.test.js
server/__tests__/endpoints/workspaceMcpServers.test.js
server/__tests__/utils/MCP/hypervisor.test.js
server/__tests__/utils/MCP/index.test.js
server/__tests__/utils/MCP/workspaceHypervisor.test.js
server/__tests__/utils/MCP/workspaceOwnedServers.test.js
server/__tests__/utils/MCP/serverConfig.test.js
server/__tests__/utils/MCP/singletonOrder.test.js
server/__tests__/utils/agents/workspaceMcpGating.test.js

Add same-workspace different-user isolation, forged caller IDs, membership removal,
callback-after-delete, config swap, refresh/disconnect races, owner-bound websocket,
unencrypted-storage checks and non-idempotent write retry protection. Use isolated
test DB only. Do not run migration or test writes against production.
