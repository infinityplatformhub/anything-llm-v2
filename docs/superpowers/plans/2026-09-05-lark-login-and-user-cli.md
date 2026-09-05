# Lark Login and Per-User CLI Implementation Plan

- **Approved spec:** `docs/superpowers/specs/2026-09-05-lark-login-and-user-cli.md`
- **Recon:** `.infi/recon-lark.md`
- **Approved mockup:** `docs/superpowers/mockups/2026-09-05-lark-login-and-user-cli.html`
- **Worktree:** `.claude/worktrees/lark-login`
- **Branch:** `feat/lark-login`
- **Evidence contract:** `cd server && npx jest __tests__/utils/lark`
- **Execution rule:** Each task is sized for one Sonnet subagent, uses test-driven development, and should finish within one hour.

## 0. Repository Conventions and Existing Seams

- Root Jest is CommonJS through `package.json` (`"test": "jest"`, Jest `^29.7.0`). No `server/jest.config` exists. From `server`, `npx jest <path>` resolves root dependencies. CI runs root `yarn test` after `yarn prisma:setup` in `.github/workflows/run-tests.yaml`.
- Every file under `server/__tests__/utils/lark/` starts with `require("./_polyfill");`. Existing `server/__tests__/utils/lark/_polyfill.js` shims `buffer.SlowBuffer` so `jsonwebtoken` loads under local Node 26.
- Mock `fetch` per test and restore it in `afterEach`, following `server/__tests__/utils/agentFlows/executors/api-call.test.js`.
- Mock Prisma per file before requiring subject code, following `server/__tests__/models/memory.test.js:1-13`.
- Follow agent model mocks in `server/__tests__/utils/agents/defaults.test.js:9-24` and plugin structure in `server/__tests__/utils/agents/aibitat/plugins/generate-image.test.js`.
- No child-process mock precedent exists. Mock with `jest.mock("child_process", () => ({ spawn: jest.fn() }))`; return fake `EventEmitter` process with `stdout`, `stderr`, and `kill` spy.
- In encryption tests, construct `new EncryptionManager({ key: "test-key", salt: "test-salt" })`. Default construction mutates `SIG_KEY` and `SIG_SALT` and calls `dumpENV()` when unset in `server/utils/EncryptionManager/index.js:37-43`.
- Settings writes are gated by `supportedFields` in `server/models/systemSettings.js:69`; requested admin reads are gated by `publicFields` at line 41 and `GET /admin/system-preferences-for` at `server/endpoints/admin.js:330-459`. Validation lives in `SystemSettings.validations` at line 108.
- Preserve masked secrets with merge semantics matching `gmail_agent_config` in `server/models/systemSettings.js:266-295`: ignore incoming values matching `^\*+$`. Never expose decrypted app secret through an API response.
- `SystemSettings.currentSettings()` at `server/models/systemSettings.js:452` feeds unauthenticated `/setup-complete`; add only a Lark-enabled boolean there, never credentials, tenant, scopes, allowlist, or tokens.
- `POST /admin/system-preferences` at `server/endpoints/admin.js:462-497` accepts admin and manager roles, but manager writes are reduced to `managerAllowedFields`. New Lark keys remain admin-only by omission from that list.
- Password login starts at `server/endpoints/system.js:198`; JWT creation is `server/utils/http/index.js:25`. `TemporaryAuthToken.issue(userId)` returns `{ token }`; validation is single-use with a six-minute expiry in `server/models/temporaryAuthToken.js`.
- Existing Simple SSO lands at `frontend/src/pages/Login/SSO/simple.jsx`, calls `System.simpleSSOLogin`, and exchanges at `GET /request-token/sso/simple` in `server/endpoints/system.js:351-392`. That exchange is gated by the `SIMPLE_SSO_ENABLED` environment setting and multi-user middleware.
- `User.create` in `server/models/user.js:108-140` enforces password complexity. Username validation uses `^[a-z][a-z0-9._@-]*$`, requires 2–64 characters, and therefore requires a lowercase letter first at `server/models/user.js:16-45`.
- Built-in plugins live under `server/utils/agents/aibitat/plugins/`, export through that directory's `index.js`, and are selected by `server/utils/agents/defaults.js`. Runtime user ID already reaches `AIbitat` through `handlerProps.invocation` in `server/utils/agents/index.js:855-863`; plugin code reads `aibitat.handlerProps.invocation.user_id`. Do not add a second user-ID channel.

## 1. Global Constraints

These values are binding across all tasks and are reviewer checkpoints.

- **OAuth scopes:** Default and documented scope string contains exactly `offline_access`, `contact:user.email:readonly`, `im:message`, `im:message.send_as_user`, `im:chat:readonly`, `docx:document`, `wiki:wiki`, `calendar:calendar`, `contact:user.base:readonly`. Admin may edit the list.
- **OAuth endpoints:** Authorize at `https://accounts.larksuite.com/open-apis/authen/v1/authorize`. Exchange and refresh at `https://open.larksuite.com/open-apis/authen/v2/oauth/token`. Fetch user info from `https://open.larksuite.com/open-apis/authen/v1/user_info` with Bearer user access token and read `data.{open_id, union_id, tenant_key, name, avatar_url, email}`.
- **PKCE and state:** Use S256, server-generated verifier and state, fixed server-derived redirect URI, ten-minute database TTL, and atomic single-use state consumption. Never accept a caller-provided redirect URI.
- **Tenant restriction:** Compare user-info `tenant_key` against configured `lark_tenant_key` before resolving, linking, provisioning, persisting tokens, or issuing a session. Empty or mismatched tenant fails closed.
- **Username rule:** Derive from lowercased email local-part, sanitize to `[a-z0-9_.-]`, enforce the repository's lowercase-letter first and 2–64-character rules, then resolve collisions with `2`, `3`, and so on while keeping the result within 64 characters. If email is absent or sanitization cannot yield a valid letter-first username, use `lark_<first 12 chars of open_id>`.
- **Encryption:** Encrypt app secret, access token, refresh token, and OAuth state verifier at rest through `EncryptionManager`. Decrypt only inside server OAuth/runner boundaries. Treat masked secret updates as no change.
- **Refresh:** Refresh when fewer than five minutes remain. Lark refresh tokens rotate and are single-use, so serialize per identity and atomically persist the new encrypted pair and expiries before returning the new access token. On refresh failure, mark `needs_reauth` and return `Reconnect Lark in Settings`.
- **CLI environment:** Set `LARKSUITE_CLI_BRAND=lark`, `LARKSUITE_CLI_APP_ID`, `LARKSUITE_CLI_USER_ACCESS_TOKEN`, `LARKSUITE_CLI_CONFIG_DIR=<per-invocation tmp dir>`, `LARKSUITE_CLI_DATA_DIR=<same>`, `HOME=<same>`, and `CI=1`. No `config.json` is needed. Always append `--as user --json`.
- **CLI denial:** Always deny `auth`, `config`, `profile`, `logout`, and `api`, even if an admin allowlist contains them.
- **CLI allowlist:** Default first-token prefixes are `im`, `docs`, `docx`, `wiki`, `calendar`, and `contact`. Validate first token and grouped second token without shell parsing. Spawn with an argument array, never a shell string.
- **Canonical commands:** Support `contact +search-user --query "<email or name>"`, `im +messages-send --user-id ou_xxx --text "..."`, and `docs +fetch --doc "<url or token>"` under the same policy.
- **Read classifier:** `+search-user`, `+fetch`, `status`, and any command token ending in `-list`, `-get`, or `-search` are reads. Everything else is a write.
- **Write approval:** Every classified write calls existing `requestToolApproval` before process spawn. Reads do not request approval. Denied approval means no spawn.
- **Token isolation:** Agent-facing plugin receives only an opaque runner operation and result. Agent model, prompt, tool schema, logs, args, stdout, stderr, and errors never contain app secret, access token, refresh token, verifier, or raw process environment.
- **Process controls:** Timeout is 60 seconds. Combined captured output is capped at 64 KB. Kill timed-out or over-limit child, remove invocation temp directory in all outcomes, redact secrets from errors, and audit user ID, redacted args, outcome, and exit code in `event_logs`.
- **Website scope:** Feature requires multi-user mode. Feishu, single-user mode, bot identity, local hand-off, and MCP are out of scope.

## 2. Deviations from Approved Spec

1. **Dedicated Lark token exchange and landing.** Add `GET /request-token/sso/lark` and frontend route `/sso/lark` instead of redirecting Lark callbacks to `/sso/simple`. Reuse the Simple SSO landing logic and `TemporaryAuthToken.validate`, but gate the new endpoint with multi-user mode plus `lark_login_enabled`, not `SIMPLE_SSO_ENABLED`. Why: the existing sibling endpoint is inseparably gated by an unrelated environment flag, while the approved spec explicitly says Lark enablement comes from admin settings. Authority: approved spec lines 60–61 and task instruction's required deviation decision.
2. **Invalid email local-parts fall back to an open-ID username.** If sanitized local-part starts with a digit, punctuation, or becomes shorter than two characters, use `lark_<first 12 chars of open_id>` instead of forcing the literal sanitized local-part. Why: repository validation requires a lowercase letter first and 2–64 characters, while the spec only names an allowed character set. Authority: repository invariant in `server/models/user.js:16-45`; this narrows username derivation without changing identity linkage or tenant trust.
3. **CLI read classifier uses validated canonical forms.** Treat only `+search-user`, `+fetch`, `status`, and tokens ending in `-list`, `-get`, or `-search` as reads; classify every other invocation as write. This replaces the broader spec examples `read`, `export`, and `download`. Why: confirmed pinned CLI command grammar provides auditable, fail-closed tokens; misclassification must require approval rather than bypass it. Authority: confirmed external CLI facts supplied for this plan.
4. **`api` joins permanent denylist.** Deny `api` alongside `auth`, `config`, `profile`, and `logout`. Why: raw API access bypasses subcommand-prefix policy and undermines allowlist review. Authority: confirmed external CLI facts supplied for this plan.

## Task 1: Add Lark Persistence Models

**Goal:** Add identity and short-lived OAuth-state persistence with uniqueness, cascade deletion, expiry, and encrypted-field model boundaries.

**Files**
- Modify `server/prisma/schema.prisma`
- Create `server/prisma/migrations/20260905000000_add_lark_identity_and_oauth_state/migration.sql`
- Create `server/models/larkIdentity.js`
- Create `server/models/larkOauthState.js`
- Create `server/__tests__/utils/lark/models.test.js`

**Behaviour**
- Add `lark_identities` exactly as approved: unique `user_id`, unique `open_id`, optional `union_id`, required tenant and encrypted token fields, expiries, scopes, `needs_reauth`, timestamps, and user cascade relation.
- Add `lark_oauth_states` with state primary key, encrypted `code_verifier`, mode, optional `user_id`, expiry, and creation time. Validate mode as `login` or `connect` in model code.
- Model methods expose create/get/upsert/delete operations needed later, parse numeric user IDs, and never return decrypted secrets by default.
- State consumption uses a Prisma transaction to delete only a matching unexpired state and returns one record once. Expired and replayed states return no usable verifier.
- Identity token-pair update is one Prisma operation and supports setting `needs_reauth`.

**Tests to write FIRST**
- `server/__tests__/utils/lark/models.test.js`
  - `consumes an unexpired OAuth state exactly once`
  - `rejects expired OAuth state and deletes it`
  - `rejects unsupported OAuth state mode`
  - `upserts one identity per user and open_id`
  - `updates rotating token pair atomically`
  - `marks identity as needing reauthentication`

**Acceptance command:** `cd server && npx jest __tests__/utils/lark/models.test.js`

**Depends on:** None.

**Risks:** Migration SQL must match repository-supported SQLite/PostgreSQL strategy and generated Prisma names. State consume must not permit a read-delete race.

**touches: schema, auth**

## Task 2: Implement OAuth, PKCE, Refresh, and Tenant Validation

**Goal:** Provide testable Lark OAuth primitives, encrypted credential loading, user-info retrieval, tenant enforcement, and serialized rotating refresh.

**Files**
- Create `server/utils/lark/constants.js`
- Create `server/utils/lark/oauth.js`
- Create `server/__tests__/utils/lark/oauth.test.js`

**Behaviour**
- Generate cryptographically random state and PKCE verifier with Node `crypto`; derive URL-safe SHA-256 challenge.
- Build authorize URL using fixed endpoint and query keys `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method=S256`, and `response_type=code`.
- Exchange authorization code by JSON POST to token endpoint with `{ grant_type: "authorization_code", client_id, client_secret, code, redirect_uri, code_verifier }`.
- Refresh at the same endpoint with `grant_type: "refresh_token"`; use a per-identity promise mutex so one rotating refresh token is consumed once.
- Persist refreshed access token, refresh token, scopes, and expiries atomically before resolving the fresh token. On HTTP or Lark payload failure, set `needs_reauth` and throw exact actionable message `Reconnect Lark in Settings`.
- GET user info with Bearer access token. Require `data.open_id` and exact configured `tenant_key`; reject tenant mismatch before callers can persist identity or issue authentication.
- Encrypt/decrypt app secret and tokens using injected `EncryptionManager`; never include secrets or response bodies containing tokens in logged errors.

**Tests to write FIRST**
- `server/__tests__/utils/lark/oauth.test.js`
  - `builds international authorize URL with S256 PKCE and exact scopes`
  - `exchanges code with fixed redirect URI and verifier`
  - `fetches user info with Bearer user access token`
  - `rejects a mismatched or missing tenant key`
  - `returns unexpired access token without refresh`
  - `refreshes with less than five minutes remaining and persists rotating pair first`
  - `coalesces concurrent refreshes for one identity`
  - `marks needs_reauth and redacts token response on refresh failure`

**Acceptance command:** `cd server && npx jest __tests__/utils/lark/oauth.test.js`

**Depends on:** Task 1.

**Risks:** Lark error bodies may vary. Normalize them without leaking token-bearing payloads. Do not hold failed mutex promises after settlement.

**touches: auth**

## Task 3: Resolve, Link, and Provision Lark Identities

**Goal:** Convert validated Lark user info into a safe existing or newly provisioned AnythingLLM user and attach one identity without takeover races.

**Files**
- Create `server/utils/lark/identity.js`
- Create `server/__tests__/utils/lark/identity.test.js`

**Behaviour**
- Resolve an existing identity by `open_id` first and reject suspended users.
- For first login, lower-case and sanitize email local-part to `[a-z0-9_.-]`. Auto-link only when that valid local-part exactly equals an existing username and configured tenant already matched.
- Use `lark_<first 12 chars of open_id>` when email is absent or sanitized local-part violates letter-first or minimum-length validation. Enforce 64-character maximum while appending `2`, `3`, and so on for collisions.
- Provision via `User.create` with `role=default` and `crypto.randomBytes(32).toString("hex")`; never return or log random password.
- Connect mode binds current authenticated user only. Existing binding to another user returns `link_conflict`; linking another identity to same user also conflicts through unique `user_id`.
- Persist encrypted tokens only after identity decision succeeds. Use unique constraints/transaction handling so concurrent callbacks cannot steal or duplicate linkage.

**Tests to write FIRST**
- `server/__tests__/utils/lark/identity.test.js`
  - `resolves an existing identity before email linking`
  - `auto-links exact valid email local-part inside configured tenant`
  - `does not auto-link a sanitized but non-exact username`
  - `derives valid lowercase username and appends collision suffix`
  - `falls back when local-part starts with non-letter or is too short`
  - `provisions default user with unseen random compliant password`
  - `rejects suspended linked and auto-linked users`
  - `rejects connect conflict without changing either user`
  - `handles concurrent unique conflict without account takeover`

**Acceptance command:** `cd server && npx jest __tests__/utils/lark/identity.test.js`

**Depends on:** Tasks 1 and 2.

**Risks:** Email auto-link is a deliberate trust decision valid only after tenant verification. Unique-constraint recovery must re-read ownership, not blindly retry assignment.

**touches: auth, permission**

## Task 4: Add Secure Admin Configuration

**Goal:** Store validated Lark settings, expose only safe values, provide admin CRUD and connection testing, and add frontend model calls.

**Files**
- Modify `server/models/systemSettings.js`
- Modify `server/endpoints/admin.js`
- Modify `server/endpoints/system.js`
- Modify `frontend/src/models/admin.js`
- Modify `frontend/src/models/system.js`
- Create `server/__tests__/utils/lark/settings.test.js`

**Behaviour**
- Add supported keys `lark_login_enabled`, `lark_app_id`, `lark_app_secret`, `lark_tenant_key`, `lark_scopes`, and `lark_cli_allowlist`.
- Validate booleans, normalized non-empty identifiers, exact list serialization, and allowlist entries. Defaults use binding values from Section 1.
- Encrypt new app-secret input before storage. Ignore all-asterisk masked submissions, preserving prior ciphertext. Admin read returns a mask/presence marker, never ciphertext or plaintext.
- Keep Lark settings absent from manager allowlists. Add strict-admin endpoint for connection test that decrypts server-side, requests an app access token, and returns only success and tenant display data.
- Add `LarkLoginEnabled` boolean to unauthenticated setup response only when multi-user mode and configuration requirements are met.
- Frontend models wrap admin get/update/test and public setup-enabled retrieval using existing request helpers.

**Tests to write FIRST**
- `server/__tests__/utils/lark/settings.test.js`
  - `accepts and normalizes exact Lark settings keys`
  - `encrypts app secret and preserves it on masked update`
  - `never returns plaintext or ciphertext app secret`
  - `rejects malformed scopes and forbidden allowlist entries`
  - `keeps Lark settings inaccessible to manager role`
  - `returns only enabled boolean from public setup settings`
  - `tests app connection without leaking credentials`

**Acceptance command:** `cd server && npx jest __tests__/utils/lark/settings.test.js`

**Depends on:** Task 2.

**Risks:** Adding secret to `publicFields` would leak it through generic preference reads. Connection-test errors must be sanitized.

**touches: auth, permission**

## Task 5: Add Login OAuth Routes and Dedicated Landing

**Goal:** Complete login-mode redirect flow without dependence on Simple SSO environment flags.

**Files**
- Create `server/endpoints/lark.js`
- Modify `server/index.js`
- Modify `server/endpoints/system.js`
- Create `frontend/src/pages/Login/SSO/lark.jsx`
- Modify `frontend/src/main.jsx`
- Modify `frontend/src/utils/paths.js`
- Modify `frontend/src/models/system.js`
- Create `server/__tests__/utils/lark/auth-routes.test.js`

**Behaviour**
- `GET /api/lark/auth/start` requires multi-user mode and enabled, complete Lark settings. It derives callback URI server-side, creates encrypted ten-minute login state, then redirects to Lark authorize endpoint.
- `GET /api/lark/auth/callback` atomically consumes state, exchanges code, fetches tenant-validated user info, resolves/provisions identity, rejects suspended users, persists tokens, issues `TemporaryAuthToken`, and redirects to `/sso/lark?token=...`.
- Callback maps expected failures to login query values `tenant`, `denied`, `suspended`, `link_conflict`, or `unknown`. It does not expose provider descriptions, codes, state, verifier, or tokens in URLs beyond the one-time temporary token.
- `GET /request-token/sso/lark` requires multi-user mode and current `lark_login_enabled`; it reuses `TemporaryAuthToken.validate`, login audit/telemetry, and response shape from Simple SSO without `simpleSSOEnabled`.
- Frontend `/sso/lark` exchanges temporary token through a dedicated `System.larkSSOLogin`, stores returned session using existing login behavior, and handles expired/replayed token failure.
- Do not modify `validatedRequest.js` or `makeJWT`.

**Tests to write FIRST**
- `server/__tests__/utils/lark/auth-routes.test.js`
  - `rejects start outside multi-user mode or when disabled`
  - `stores encrypted verifier and redirects with fixed callback URI`
  - `consumes state before exchanging callback code`
  - `rejects tenant before identity persistence or temporary token issue`
  - `issues temporary token and redirects to dedicated landing`
  - `rejects suspended user before session creation`
  - `maps denied and unknown callbacks without leaking details`
  - `exchanges temporary token without SIMPLE_SSO_ENABLED`
  - `rejects replayed temporary token`

**Acceptance command:** `cd server && npx jest __tests__/utils/lark/auth-routes.test.js`

**Depends on:** Tasks 1–4.

**Risks:** Callback order is security-critical. State must be consumed once even when downstream exchange fails. Only trusted server origin constructs redirects.

**touches: auth, permission**

## Task 6: Add User Connect, Status, and Disconnect Routes

**Goal:** Let an authenticated user inspect, connect, reconnect, and disconnect their own Lark identity.

**Files**
- Modify `server/endpoints/lark.js`
- Modify `frontend/src/models/system.js`
- Create `server/__tests__/utils/lark/user-routes.test.js`

**Behaviour**
- Add authenticated `GET /api/lark/status`; return connection state, display name, avatar URL, email, scopes, and `needs_reauth`, but no token or internal encrypted field.
- `GET /api/lark/auth/start?mode=connect` requires valid logged-in user, stores their user ID in expiring state, and redirects through same PKCE flow.
- Callback gets connect target exclusively from consumed state, never request query/session fallback. It applies tenant validation before link and returns user-settings success/error location.
- Add authenticated `DELETE /api/lark/identity`; delete only identity owned by requesting user. Document no remote revoke endpoint and do not pretend local delete revokes Lark grant.
- Reconnect replaces encrypted token pair and clears `needs_reauth` for same owned identity.

**Tests to write FIRST**
- `server/__tests__/utils/lark/user-routes.test.js`
  - `returns safe disconnected and connected status shapes`
  - `requires authentication for connect status and disconnect`
  - `binds connect callback to user ID stored in state`
  - `rejects open_id already owned by another user`
  - `reconnects owned identity and clears needs_reauth`
  - `disconnects only requesting user's identity`
  - `does not claim remote token revocation`

**Acceptance command:** `cd server && npx jest __tests__/utils/lark/user-routes.test.js`

**Depends on:** Tasks 1–5.

**Risks:** Connect-state ownership must survive redirects without trusting browser parameters. Status shape must remain secret-free.

**touches: auth, permission**

## Task 7: Build Isolated CLI Policy and Runner

**Goal:** Run pinned server CLI as one connected user with fail-closed policy, fresh token, bounded resources, cleanup, redaction, and audit.

**Files**
- Create `server/utils/lark/cli.js`
- Create `server/__tests__/utils/lark/cli.test.js`

**Behaviour**
- Validate non-empty string argument arrays and reject shell strings, NULs, and malformed command tokens.
- Enforce admin first-token allowlist and grouped-command validation. Always deny `auth`, `config`, `profile`, `logout`, and `api` regardless of case or allowlist.
- Classify only `+search-user`, `+fetch`, `status`, and tokens ending `-list`, `-get`, or `-search` as reads. All other valid commands are writes.
- Resolve identity by numeric invocation user ID, require connected/non-reauth state, obtain fresh token through OAuth refresh logic, and never return token to caller.
- Create per-invocation temp directory with Node `fs.promises.mkdtemp`; set exact environment keys from Section 1 plus inherited safe process environment. No config file.
- Spawn executable with argument array plus `--as user --json`, `shell: false`, exact environment, and piped output. Cap combined stdout/stderr at 64 KB, timeout at 60 seconds, kill on either boundary, and recursively remove temp directory in `finally`.
- Return parsed JSON when valid; on non-zero exit include bounded sanitized stderr. Redact app secret and all known token values from errors and audit.
- Log one event for every attempted invocation with user ID, redacted args, policy outcome, exit code, timeout/output-limit indicators. Rejected policy attempts are audited without spawning.

**Tests to write FIRST**
- `server/__tests__/utils/lark/cli.test.js`
  - `allows configured canonical contact search docs fetch and message send`
  - `denies permanent subcommands even when allowlisted`
  - `denies non-allowlisted and malformed argument arrays without spawn`
  - `classifies exact read forms and defaults unknown forms to write`
  - `spawns with isolated exact Lark environment and required suffix flags`
  - `refreshes token before spawn without exposing it in result`
  - `kills at timeout and combined output limit`
  - `surfaces bounded stderr on non-zero exit with secrets redacted`
  - `cleans temporary directory on success failure and kill`
  - `audits policy rejection and process outcome with redacted args`

**Acceptance command:** `cd server && npx jest __tests__/utils/lark/cli.test.js`

**Depends on:** Tasks 1, 2, and 4.

**Risks:** Child processes may emit close/error in different orders. Completion and cleanup must be idempotent. Environment inheritance must not override exact CLI variables.

**touches: permission**

## Task 8: Register Agent Plugin and Approval Gate

**Goal:** Expose one Lark tool only to eligible users and require existing in-chat approval before every write.

**Files**
- Create `server/utils/agents/aibitat/plugins/lark-cli.js`
- Modify `server/utils/agents/aibitat/plugins/index.js`
- Modify `server/utils/agents/defaults.js`
- Modify `server/utils/agents/index.js` only if current plugin attachment cannot access existing `handlerProps`
- Create `server/__tests__/utils/lark/plugin.test.js`

**Behaviour**
- Register built-in plugin under stable `lark-cli` name and make it workspace-configurable through existing agent-skill settings.
- Availability requires multi-user mode, enabled complete Lark config, and identity connected for `aibitat.handlerProps.invocation.user_id`. Do not expose tool when user ID is absent or identity needs reauth.
- Plugin accepts only structured `args: string[]`. It obtains user ID from `aibitat.handlerProps.invocation.user_id`, calls classifier, and invokes existing `requestToolApproval` for every write before runner.
- Approval card shows redacted canonical command and effect category, never process environment or credentials. A denied approval returns without invoking runner.
- Reads call opaque runner directly. Plugin receives no token and exposes no token-returning helper to model.
- Preserve current plumbing at `server/utils/agents/index.js:855-863`; add no duplicate user-ID parameter unless attachment API demonstrably requires it.

**Tests to write FIRST**
- `server/__tests__/utils/lark/plugin.test.js`
  - `reads user_id from handlerProps invocation`
  - `is hidden without enabled config connected identity or user_id`
  - `is hidden when identity needs reauth`
  - `runs classified read without approval`
  - `requests approval before classified write`
  - `does not run write after denied approval`
  - `passes only user ID and args to opaque runner`
  - `registers plugin once in exports and defaults discovery`

**Acceptance command:** `cd server && npx jest __tests__/utils/lark/plugin.test.js`

**Depends on:** Tasks 4 and 7.

**Risks:** Plugin definitions can be cached before invocation context exists. Availability must be evaluated at correct per-chat attachment stage, not globally.

**touches: permission**

## Task 9: Add Login and User Settings UI

**Goal:** Implement approved login button, safe error banners, and three-state user Lark settings experience.

**Files**
- Modify `frontend/src/components/Modals/Password/MultiUserAuth.jsx`
- Modify `frontend/src/pages/Login/SSO/lark.jsx`
- Modify `frontend/src/main.jsx`
- Modify `frontend/src/utils/paths.js`
- Create `frontend/src/components/UserMenu/AccountModal/LarkConnection.jsx`
- Modify `frontend/src/components/UserMenu/AccountModal/index.jsx`
- Modify `frontend/src/models/system.js`

**Behaviour**
- Show `Login with Lark` beside password login only when public setup data reports Lark enabled in multi-user mode. Start server OAuth route with normal browser navigation.
- Render fixed local messages for `tenant`, `denied`, `suspended`, `link_conflict`, and `unknown`; never render arbitrary provider query text.
- Add Settings > Lark page matching approved mockup: disconnected with Connect button, connected with safe profile/scopes and Disconnect, reauth warning with Reconnect.
- Connect/reconnect use server `mode=connect` route. Disconnect requires explicit UI confirmation, updates state after success, and states that local disconnect does not revoke remote grant.
- Preserve existing recovery-code behavior reached after token exchange.

**Tests to write FIRST**
- Frontend has no first-party test script or source test harness. Before JSX changes, write a manual acceptance checklist against approved mockup and exercise it after build:
  - `shows Lark button only when enabled and multi-user`
  - `maps known error codes to fixed banners and ignores arbitrary text`
  - `renders disconnected connected and needs-reauth states`
  - `starts connect and reconnect with connect mode`
  - `confirms disconnect and refreshes local status`

**Acceptance command:** `cd frontend && yarn build` (frontend has no first-party test script or source test harness).

**Depends on:** Tasks 5 and 6.

**Risks:** Existing frontend may lack component-test infrastructure. If so, keep server tests authoritative and use build plus manual mockup comparison rather than adding a new test dependency.

**touches: auth**

## Task 10: Add Admin Authentication Settings UI

**Goal:** Implement approved Settings > Authentication > Lark panel with safe secret editing and connection feedback.

**Files**
- Create `frontend/src/pages/Admin/LarkSettings/index.jsx`
- Modify `frontend/src/main.jsx`
- Modify `frontend/src/utils/paths.js`
- Modify `frontend/src/components/SettingsSidebar/index.jsx`
- Modify `frontend/src/models/admin.js`

**Behaviour**
- Render Enabled, App ID, write-only masked App Secret, allowed tenant key, computed read-only redirect URL, editable scopes, CLI allowlist chips, and Test connection per approved mockup.
- Load only admin-safe response. Existing app secret appears masked and unchanged unless admin enters a new value.
- Keep exact default scopes and allowlist visible. Prevent permanently denied commands from being submitted and display server validation errors.
- Test connection calls strict-admin server endpoint and displays sanitized success/tenant or failure. Never place credentials in URL, browser logs, or error details.
- Disable enablement submission until required App ID, existing-or-new secret, tenant key, scopes, and allowlist are present.

**Tests to write FIRST**
- Frontend has no first-party test script or source test harness. Before JSX changes, write a manual acceptance checklist against approved mockup and exercise it after build:
  - `renders all configured fields and read-only redirect URL`
  - `preserves masked secret unless replacement entered`
  - `prevents permanent denylist entries`
  - `submits normalized scopes and allowlist`
  - `shows sanitized connection test result`

**Acceptance command:** `cd frontend && yarn build` (frontend has no first-party test script or source test harness).

**Depends on:** Task 4.

**Risks:** Mask placeholders can accidentally overwrite encrypted secret. Browser should never receive secret presence beyond a fixed mask.

**touches: auth, permission**

## Task 11: Pin CLI in Multi-Architecture Image

**Goal:** Install exact CLI package in both production architecture build stages and verify executable availability without local invocation.

**Files**
- Modify `docker/Dockerfile`

**Behaviour**
- Add `npm install -g @larksuite/cli@1.0.93` after Node/Yarn installation in both `build-arm64` and `build-amd64` stages.
- Keep exact version pinned. Package postinstall fetches checksummed Go binary for Linux ARM64 or AMD64 appropriate to each stage.
- Do not add runtime downloads, unpinned package versions, local config initialization, or credential files.

**Tests to write FIRST**
- No server Jest file is needed because this is image assembly only.
- Add no shell-based CLI test on development machine. Review Dockerfile stage placement and use Docker build evidence in deployment-capable CI/environment.

**Acceptance command:** Build both target stages with repository's existing Docker build commands, then inspect package/executable presence inside each built image without authenticating or sending commands.

**Depends on:** Task 7.

**Risks:** Cross-architecture package postinstall depends on stage platform. Cache can hide download failures, so final CI evidence should include a clean build.

## Task 12: Document Setup, Security Boundaries, and Verification

**Goal:** Give administrators complete setup, scope, redirect, CLI policy, reauthorization, and deployment instructions.

**Files**
- Create `docs/lark-setup.md`

**Behaviour**
- Document dedicated international Lark app creation and exact fixed OAuth endpoints.
- List exact scopes from Section 1 and explain why user access token plus `im:message.send_as_user` is required. Flag API Explorer verification for international send-as-user before production rollout; do not document bot fallback as implemented.
- Explain Admin Settings fields, computed redirect URL registration, tenant restriction, masked encrypted secret, default allowlist, permanent denylist, and fail-closed read/write classifier.
- Include canonical search, message-send, and docs-fetch commands as examples. Explain every write requires chat approval and agent never sees tokens.
- Explain connect, reconnect, token rotation, `needs_reauth`, local disconnect limitation, suspended-user rejection, auto-link trust boundary, and random-password provisioning.
- Document image pin `@larksuite/cli@1.0.93`, both supported architectures, BytePlus VKE rollout, and no local CLI hand-off/config file.
- Include evidence contract and Docker validation steps without credentials.

**Tests to write FIRST**
- Documentation review checklist:
  - `contains all exact scopes environment variables denylist and classifier rules`
  - `states tenant and encryption boundaries`
  - `states local disconnect does not revoke remote grant`
  - `states international send-as-user requires preproduction API Explorer verification`
  - `contains no real app IDs secrets tenant values or tokens`

**Acceptance command:** `cd server && npx jest __tests__/utils/lark` followed by link/path review of `docs/lark-setup.md`.

**Depends on:** Tasks 1–11.

**Risks:** Lark console labels may change. Keep protocol URLs and repository behavior authoritative and avoid unsupported claims.

## Final Whole-Branch Evidence

1. Run `cd server && npx jest __tests__/utils/lark` and require all Task 1–8 tests to pass.
2. Run focused frontend tests where existing infrastructure supports them and `cd frontend && yarn build`.
3. Run root `yarn test` after `yarn prisma:setup`, matching CI.
4. Build AMD64 and ARM64 Docker targets in an environment that permits package postinstall. Verify pinned executable presence without credentials or outbound user actions.
5. Manually compare login, admin settings, user settings states, and write approval card against `docs/superpowers/mockups/2026-09-05-lark-login-and-user-cli.html`.
6. Verify with test credentials in Lark API Explorer that international UAT supports `im:message.send_as_user` before production enablement. If unsupported, stop rollout and return for scope/spec re-approval; do not silently switch to bot identity.

Tasks touching auth/schema/permission get an Opus security review at final whole-branch review.
