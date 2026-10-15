# Actual all-components local verification

Own only temp test artifacts under
/private/var/folders/17/xt4yqxps7y74x2_89xt3b2hm0000gn/T/opencode/redball-full-chat/.
Do not edit implementation/backend/client/adapter, spawn children, deploy, or touch
production. Use three actual implementation surfaces:

- Client worktree /Users/jintawattuitemwong/Documents/GitHub/anything-llm-v2-mcp-oauth/personal-mcp-oauth
- Backend worktree /Users/jintawattuitemwong/Documents/GitHub/redballstore-mcp-oauth/personal-mcp-oauth/apps/backend
- Adapter apps/medusa-mcp in same backend repository.

If cross-worktree read access is denied, report exact limitation. No bypass.
Client currently fixes private-context socket guard/schema and PG startup. Backend
expands action resolver and browser headers. Avoid in-progress dependency writes;
use isolated copied app/deps/test schema outputs and unique fixture DBs/ports.

## Preparation and proof

Inspect actual E2E infrastructure and browser temp scripts for supported local
Medusa boot; current reviewed OAuth store/module works on real PG. Use unique
fixture DB on local PG55471 (medusa/local-mcp-test-only) and Redis6397. Dedicated
AnythingLLM SQLite or PostgreSQL test DB only, not another worker fixture. Keep
production domains mapped to local HTTPS fixture only and block outbound network.

Run actual AnythingLLM auth/workspace/member endpoints and OAuth helper; actual
adapter /mcp and real Medusa /mcp-auth/* and Admin API. No x-test-user authentication
stand-in, no mocked DB identity, no fake Medusa resolver. Local fixture native users,
password/session login, membership/roles/grants via real supported services.

Actual browser AnythingLLM personal connection surface -> native Medusa login ->
consent -> actual AnythingLLM callback -> account label, then chat read/update.
Allow a deterministic local tool-calling model fixture only to make chat execution
repeatable; label it as model stub, not evidence of public LLM quality. The actual
agent/plugin/socket/auth/tool schema path must run. Stub must not receive tokens.
No live LLM cost or external provider requests necessary.

A product-reader, B scalar-product writer, C order-only Medusa users and corresponding
AnythingLLM members in same workspace. No production roles. Direct same-user API
comparison, create requires complete AND bundle, role/policy/link revoke denial,
grant revoke, A/B cache/refresh/disconnect separation, unsupported fields/delete
disabled. Capture owner/other/anonymous socket outcomes without private data logs.

If implementation currently incomplete, prepare harness and report concrete blocked
contract/test; do not poll worker output or wait indefinitely. Parent will rerun
after fixes. Never label isolated helper/SDK tests as actual chat/browser E2E.

Report full-chat-report.md in owned temp directory, sanitized commands/results,
tested vs blocked gates, exact defects. Screenshots only test identities and no
token/password/CSRF/code values. Stop only owned fixture listeners/DBs safely;
preserve evidence and never remove another task's artifacts.
