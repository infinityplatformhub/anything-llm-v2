# Lark login + per-user lark-cli agent tool

Status: APPROVED 2026-09-05 (requester, in chat)
Date: 2026-09-05

## Goal

1. Company members log in to AnythingLLM with their Lark (international, `larksuite.com`) account.
2. The chat agent can run `lark-cli` on the server **as the logged-in user**, so messages/docs/events
   created by the agent appear as that user (not a bot). This is intentional and confirmed by the requester.

## Decisions (answered in requirement gathering)

| Topic | Decision |
|---|---|
| Login mode | "Login with Lark" button added beside existing password login. Multi-user mode required. |
| Auto-provision | Yes. First Lark login creates user with `role=default`. |
| Tenant restriction | Only configured `tenant_key` accepted. Others rejected before session creation. |
| Identity key | New table `lark_identities` keyed by `open_id` (+ `union_id`, `tenant_key`). |
| Linking existing users | (a) auto-link when Lark `email` local-part == existing `username`; (b) manual "Connect Lark" in user Settings > Lark while logged in. |
| Username for new users | local-part of Lark `email`, sanitized to `[a-z0-9_.-]`. Collision → append `2`, `3`, … No email → `lark_<first 12 chars of open_id>`. |
| Password for new users | random 32-byte hex (satisfies complexity), never shown. Recovery codes still generated on first login as today. |
| Lark app | New dedicated app (not the War Room bot). Admin creates in Lark developer console. |
| Config location | Admin settings page in UI (like other providers). Stored in `system_settings`; `app_secret` encrypted with `EncryptionManager`. |
| Token storage | `access_token`, `refresh_token`, expiries, scopes per identity, encrypted at rest. Refresh handled by server. |
| Scopes requested | `offline_access`, `contact:user.email:readonly`, `im:message`, `im:message.send_as_user`, `im:chat:readonly`, `docx:document`, `wiki:wiki`, `calendar:calendar`, `contact:user.base:readonly`. Admin can edit list. |
| Who runs lark-cli | Agent skill on server, per chat user. Website only; no local CLI hand-off. |
| CLI allowlist | Admin-configurable subcommand prefix allowlist. Default: `im`, `docs`, `docx`, `wiki`, `calendar`, `contact`. `auth`, `config`, `profile`, `logout` always denied. |
| Write approval | Every non-read invocation requires in-chat approval via existing `requestToolApproval`. Reads run directly. |
| Deploy | BytePlus VKE. `lark-cli` binary added to `docker/Dockerfile`, version pinned. |

## Out of scope

- Feishu (`feishu.cn`) domain.
- Lark as the *only* login method (`SIMPLE_SSO_NO_LOGIN`-style). Can be added later via env flag.
- Bot-identity (tenant token) actions.
- MCP server variant (`@larksuiteoapi/lark-mcp`).
- Single-user mode.

## Architecture

### Login flow (OAuth 2.0 authorization code + PKCE, server-side)

```
Browser  --GET /api/lark/auth/start-->  Server: create state+code_verifier (10 min, DB row), 302 to
         https://accounts.larksuite.com/open-apis/authen/v1/authorize?client_id&redirect_uri&scope&state&code_challenge&code_challenge_method=S256&response_type=code
Lark     --302 redirect_uri?code&state-->  Server /api/lark/auth/callback:
           1. validate state, load verifier
           2. POST https://open.larksuite.com/open-apis/authen/v2/oauth/token (authorization_code)
           3. GET  /open-apis/authen/v1/user_info  → open_id, union_id, tenant_key, name, email
           4. reject if tenant_key != configured
           5. resolve user: lark_identities.open_id → existing; else auto-link by email local-part; else create
           6. upsert lark_identities row with tokens
           7. TemporaryAuthToken.issue(user.id) → 302 /sso/simple?token=...
```

Reuses existing Simple SSO landing (`frontend/src/pages/Login/SSO/simple.jsx`) and JWT path.
No changes to `validatedRequest.js` or `makeJWT`.

Callback endpoint requires **no** `simpleSSOEnabled` env flag: enablement = admin settings row
`lark_login_enabled=true` + multi-user mode.

Suspended users are rejected at step 5 (same as password login).

### Connect from Settings (already logged in)

Same `/api/lark/auth/start?mode=connect` with logged-in JWT. Callback links identity to
`response.locals.user` instead of resolving/creating. Conflict (open_id already bound to another
user) → error page, no change.

### Token lifecycle

- Server refreshes when `< 5 min` remaining, via `grant_type=refresh_token`. Refresh tokens rotate;
  new pair persisted atomically before use. Per-identity mutex to avoid double refresh.
- Refresh failure (revoked / >365 days) → identity marked `needs_reauth`, agent tool returns clear
  message "Reconnect Lark in Settings".
- Disconnect (user Settings) → delete row. No remote revoke (Lark documents no revoke endpoint); noted as limitation.

### Agent skill `lark-cli`

- Built-in agent skill under `server/utils/agents/aibitat/plugins/lark-cli.js`.
- Enabled per workspace like other agent skills; visible only when admin enabled Lark + user has
  connected identity.
- Runtime needs `user_id` of invocation. Current skills receive no user id; plumb
  `invocation.user_id` from `handlerProps` (recon: `server/utils/agents/index.js:859-863`).
- Execution: `spawn("lark-cli", args, { env })` with

  ```
  LARKSUITE_CLI_APP_ID=<app_id>
  LARKSUITE_CLI_USER_ACCESS_TOKEN=<fresh access token>
  LARKSUITE_CLI_BRAND=lark
  LARKSUITE_CLI_CONFIG_DIR=<tmp dir per invocation>
  LARKSUITE_CLI_DATA_DIR=<same tmp dir>
  HOME=<same tmp dir>
  ```

  Env-injected token means lark-cli never touches shared config or keychain, no cross-user state,
  no CLI-side refresh (server owns refresh). Always pass `--as user --json`.
- Args are an array, never a shell string. First token (and second for grouped commands) checked
  against allowlist. Denylist enforced regardless of allowlist.
- Read vs write classification: verbs `list|get|search|read|status|export|download` (and `+…-list`,
  `+…-get` forms) are reads; everything else is write → `requestToolApproval`.
- Output capped (64 KB), timeout 60 s, stderr surfaced to agent on non-zero exit.
- Audit: each invocation logged to `event_logs` with user_id, args (secrets redacted), exit code.

### Admin settings page — Settings > Authentication > Lark

Fields: Enabled toggle · App ID · App Secret (write-only, masked) · Allowed tenant_key ·
Redirect URL (read-only, computed) · Scopes (textarea) · CLI allowlist (chips) ·
"Test connection" (fetches app_access_token, shows tenant name).

### User settings page — Settings > Lark

States: not connected (Connect button) · connected (name, avatar, email, granted scopes, Disconnect)
· needs re-auth (warning + Reconnect).

### Login page

Multi-user login form gains "Login with Lark" button when enabled. Error states shown via query
param on return: `?lark_error=tenant|denied|suspended|link_conflict|unknown`.

## Schema

```prisma
model lark_identities {
  id                 Int      @id @default(autoincrement())
  user_id            Int      @unique
  open_id            String   @unique
  union_id           String?
  tenant_key         String
  email              String?
  display_name       String?
  avatar_url         String?
  access_token       String   // encrypted
  refresh_token      String   // encrypted
  access_expires_at  DateTime
  refresh_expires_at DateTime
  scopes             String
  needs_reauth       Boolean  @default(false)
  createdAt          DateTime @default(now())
  lastUpdatedAt      DateTime @default(now())
  user               users    @relation(fields: [user_id], references: [id], onDelete: Cascade)
}

model lark_oauth_states {
  state         String   @id
  code_verifier String
  mode          String   // login | connect
  user_id       Int?
  expiresAt     DateTime
  createdAt     DateTime @default(now())
}
```

Config in `system_settings` keys: `lark_login_enabled`, `lark_app_id`, `lark_app_secret` (encrypted),
`lark_tenant_key`, `lark_scopes`, `lark_cli_allowlist`.

## Security notes

- `state` + PKCE S256 mandatory. State single-use, 10 min TTL.
- Secrets never returned to frontend; App Secret field is write-only.
- Redirect URI fixed server-side from configured server URL; not user-supplied.
- Tokens encrypted with `EncryptionManager` (`SIG_KEY`/`SIG_SALT`).
- Agent cannot read tokens: skill receives an opaque `runCli(args)` function, not the token.
- Allowlist + write approval defends against prompt injection acting as user.
- Route touches auth → Opus security review required at final review (per model policy).

## Risks / unconfirmed

1. **Lark international send-as-user**: Feishu docs confirm UAT + `im:message.send_as_user`; the Lark
   page fetched showed only TAT. Must verify in Lark API Explorer with the new app before Plan.
   If unsupported, messaging falls back to bot identity (scope change, needs re-approval).
2. `lark-cli` runs with App ID + env token only (maintainer confirmation, larksuite/cli issue #129).
   Verify with pinned version in Docker before relying on it.
3. Auto-link by username == email local-part is a trust decision: safe only because tenant is
   restricted to one company. Documented in admin page.
4. `TemporaryAuthToken` expiry constant is 6 min despite "1 hour" comment. Fine for our redirect; not touched.
5. This dev machine has a hook that blocks any shell command mentioning outbound lark-cli usage
   (War Room issue #93). Dev/QA subagents must use file tools for code and must not run
   `lark-cli` locally. Tests mock `spawn`.

## Evidence contract (draft, finalised at `task.sh start`)

```
cd server && npx jest __tests__/lark
# expect: PASS — state/PKCE, tenant reject, username derivation, allowlist, read/write classifier, token refresh rotation
```

## Mockups required (step 1.5)

1. Login page with Lark button + error states
2. Admin settings > Lark
3. User settings > Lark (3 states)
4. Chat: agent tool approval card for a write action

## Open questions for approval

None blocking. Approve spec → proceed to mockups.
