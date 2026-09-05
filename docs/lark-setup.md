# Lark Login and Per-User Agent Tool Setup

## 1. Create the Lark app

Create a dedicated custom/internal app in the [Lark international developer console](https://open.larksuite.com/). Do not reuse a War Room or bot app. Set app availability to **All members** of the tenant.

Register this redirect URL exactly, replacing `<SERVER_URL>` with the public AnythingLLM server origin:

```text
<SERVER_URL>/api/lark/auth/callback
```

The server derives this URL from `SERVER_URL` alone; users cannot supply a redirect URL and no request header can influence it. `SERVER_URL` is therefore **required** whenever Lark login is enabled: saving the settings with it unset returns HTTP 400 naming `SERVER_URL`, and if it is removed afterwards the feature fails closed, reporting Lark login as disabled. Lark login uses these fixed international OAuth endpoints:

- Authorization: `https://accounts.larksuite.com/open-apis/authen/v1/authorize`
- Code exchange and refresh: `https://open.larksuite.com/open-apis/authen/v2/oauth/token`
- User information: `https://open.larksuite.com/open-apis/authen/v1/user_info`

Add these scopes in the listed order:

```text
offline_access
contact:user.email:readonly
im:message
im:message.send_as_user
im:chat:readonly
docx:document
wiki:wiki
calendar:calendar
contact:user.base:readonly
```

Also grant the app permission `tenant:tenant:readonly` in Lark Developer Console for **Test connection** to query the tenant and auto-fill its key. This tenant-token permission is separate from the user OAuth scopes above. Without it, credentials can still test successfully, but you must enter the tenant key manually.

The agent acts as the connected member, so it requires a user access token rather than a tenant or bot token. `im:message.send_as_user` permits approved message writes to appear as that member. Before production rollout, use test credentials in the international Lark API Explorer to verify that user access tokens and `im:message.send_as_user` support send-as-user for this app. Stop rollout and return for scope/design review if verification fails; bot fallback is not implemented.

OAuth uses server-generated state and PKCE S256. State is single-use with a ten-minute lifetime. App secrets, OAuth state verifiers, user access tokens, and refresh tokens are encrypted at rest.

## 2. Configure admin settings

Open **Settings > Authentication > Lark** and configure:

- **Enabled** (`lark_login_enabled`): exposes Lark login only when AnythingLLM is in multi-user mode and configuration is complete.
- **App ID** (`lark_app_id`): enter the dedicated app identifier, such as `cli_xxx`.
- **App Secret** (`lark_app_secret`): write-only credential. Existing values appear as `********`; submitting that mask preserves the encrypted stored secret.
- **Allowed tenant key** (`lark_tenant_key`): enter `<tenant_key>`. User information must contain this exact tenant key before identity resolution, linking, provisioning, token persistence, or session issuance.
- **Redirect URL**: read-only computed value. Register it in the Lark app exactly as shown.
- **Scopes** (`lark_scopes`): space-separated list. The default is the exact scope list in section 1.
- **CLI allowlist** (`lark_cli_allowlist`): allowed first command tokens. Default entries are `im`, `docs`, `docx`, `wiki`, `calendar`, and `contact`.

`auth`, `config`, `profile`, `logout`, and `api` are permanently denied, regardless of the configured allowlist. Empty or malformed identifiers, scopes, or allowlist entries fail validation. Invalid updates return HTTP 400. Enabling Lark requires an App ID, an existing or new App Secret, an allowed tenant key, and the `SERVER_URL` environment variable set to the public server origin.

1. Fill **App ID** and **App Secret**, and review the scopes and allowlist.
2. Click **Test connection** before saving. The server tests the form credentials without persisting them.
3. When tenant discovery succeeds, the **Allowed tenant key** fills automatically when empty. Verify it matches your company. If the tenant cannot be read, grant `tenant:tenant:readonly` and test again, or enter the tenant key manually.
4. Turn on **Enable Lark**.
5. Click **Save settings**.

Test connection returns only sanitized success or failure data and the tenant key/name when available. Stored secrets and access tokens are never returned to the browser. When the secret remains masked, testing uses the stored secret.

## 3. User flow

Eligible users choose **Login with Lark** on the multi-user login page. The callback rejects users from any tenant other than the configured tenant and rejects suspended AnythingLLM users before session creation.

First login resolves an existing Lark identity before considering automatic linking. Automatic linking occurs only when the raw Lark email local-part, lowercased and with no characters stripped, is exactly equal to an existing AnythingLLM username **and** that account's role is `default`. An address whose local part would have to be rewritten to match, such as the plus-addressed alias `ad+min@corp.com`, never links, and an `admin` or `manager` account is never claimed by an email match at all: those owners must link Lark deliberately through **Settings > Connect**. This is a deliberate trust boundary and is safe only because tenant matching happens first. When no link applies, AnythingLLM provisions a default-role user with a random 32-byte hexadecimal password that is never displayed or logged. Username collisions receive numeric suffixes.

Users manage their identity under **Settings > Lark**:

- **Connect** links the current authenticated AnythingLLM user after the same tenant-validated OAuth flow.
- **Reconnect** replaces the encrypted rotating token pair and clears `needs_reauth` for the same owned identity.
- **Disconnect** deletes only the local identity record. It does not revoke the Lark grant because the integration has no remote revoke operation.

The server refreshes tokens when fewer than five minutes remain. Refresh tokens rotate and are single-use, so refresh is serialized per identity and the new encrypted pair is persisted atomically before use. Refresh failure marks the identity `needs_reauth`; login or agent use then directs the user to reconnect in Settings.

## 4. Agent tool

The server-hosted agent tool accepts structured argument arrays. Canonical commands are:

```text
contact +search-user --query "<email or name>"
im +messages-send --user-id ou_xxx --text "..."
docs +fetch --doc "<url or token>"
```

Policy checks the first command token against the admin allowlist and checks grouped command tokens against the permanent denylist. Arguments are passed as an array with no shell parsing. The runner always adds `--as user --json`.

Every argument token is validated, not only the command tokens. An accepted invocation is exactly two positional command tokens followed by flags and their values. A third positional token is rejected, so a second subcommand cannot ride along behind a read-shaped one. Flag values may not name a local file: a leading `@`, an absolute path, a drive letter, `..`, a control character, or a value beyond 4096 characters is refused. Flags the runner owns (`--as`, `--config`, `--profile`, `--brand`, `--app-id`, `--user-access-token`, `--tenant-access-token`) and flags that name a filesystem location (`--output`, `-o`, `--output-dir`, `--out`, `--local-dir`, `--file`, `--body-file`, `--patch-file`, `--data`, `--csv`, `--image`, `--attachment`, `--path`, and any flag ending in `-file`, `-dir`, or `-path`) are rejected outright.

The fail-closed classifier reads an explicit allowlist of `group +subcommand` pairs pinned to `@larksuite/cli@1.0.93`, exported as `READ_COMMANDS`. Only non-mutating verbs are listed, for example `contact +search-user`, `docs +fetch`, `im +chat-list`, `im +messages-search`, `wiki +node-list`, and `calendar +agenda`.

Everything absent from that allowlist, including `+messages-send`, is a write. A name that merely looks like a read, such as `+messages-delete-list`, is a write. Every write requires explicit in-chat approval before process spawn. Denied approval causes no invocation. Reads do not request approval. A CLI upgrade that adds verbs cannot silently widen the read set, because the allowlist is pinned rather than derived from a suffix rule.

The agent receives only an opaque runner and result; it never sees the app secret, access token, refresh token, OAuth verifier, or raw process environment. Each invocation receives a fresh temporary `HOME` and these isolated variables:

```text
LARKSUITE_CLI_BRAND=lark
LARKSUITE_CLI_APP_ID=cli_xxx
LARKSUITE_CLI_USER_ACCESS_TOKEN=<user_access_token>
LARKSUITE_CLI_CONFIG_DIR=<per-invocation temporary directory>
LARKSUITE_CLI_DATA_DIR=<same temporary directory>
HOME=<same temporary directory>
CI=1
```

Only `PATH`, `LANG`, `TZ`, and `TMPDIR` may be inherited. The temporary directory is removed after every outcome. Execution has a 60-second timeout and a combined stdout/stderr cap of 65,536 bytes (64 KB); either limit kills the child process. Errors and audit arguments are credential-redacted. Every attempted invocation records a `lark_cli_invocation` event with user ID, redacted arguments, outcome, exit code, timeout state, and truncation state. Invocations rejected before the app secret and access token resolve record `argCount` in place of the arguments, because no secret list exists yet to redact them against.

## 5. Deployment

`docker/Dockerfile` pins `@larksuite/cli@1.0.93` in both `build-amd64` and `build-arm64`. Package postinstall downloads the checksummed Linux binary appropriate to each stage. Do not replace the pin with a floating version or add a runtime download.

Build and validate both architectures before a BytePlus VKE rollout. Publish a multi-architecture image only after both stage builds pass, then roll it out through the normal VKE image deployment process. Keep `SERVER_URL` set to the public HTTPS origin used by the registered callback.

`LARK_CLI_PATH` may override the executable path when the image layout requires it. The feature runs only on the AnythingLLM server. There is no local CLI hand-off, shared CLI login, credential file, or `config.json`; the server injects a fresh per-user token and isolated directories for each invocation.

## 6. Verification

Run the Lark server test suite:

```bash
cd server && npx jest __tests__/utils/lark
```

Run the end-to-end suite, which boots the real server against a throwaway database with a mock Lark and a fake CLI on `PATH`:

```bash
cd server && npx jest __tests__/e2e/lark --runInBand
```

Run the Playwright browser suite from the repository root. Install Chromium before the first run:

```bash
npx playwright install chromium
npm run test:e2e:lark
```

Build each target from the repository root in an environment that permits package postinstall:

```bash
docker buildx build --platform linux/amd64 --target production-build --load -f docker/Dockerfile -t anythingllm-lark:amd64 .
docker buildx build --platform linux/arm64 --target production-build --load -f docker/Dockerfile -t anythingllm-lark:arm64 .
```

Check the pinned package and executable presence without credentials, authentication, or any outbound user action:

```bash
docker run --rm --entrypoint npm anythingllm-lark:amd64 list -g @larksuite/cli@1.0.93 --depth=0
docker run --rm --entrypoint sh anythingllm-lark:amd64 -c 'test -x "$(command -v lark-cli)"'
docker run --rm --entrypoint npm anythingllm-lark:arm64 list -g @larksuite/cli@1.0.93 --depth=0
docker run --rm --entrypoint sh anythingllm-lark:arm64 -c 'test -x "$(command -v lark-cli)"'
```

Complete preproduction verification in Lark API Explorer using test credentials. Confirm international send-as-user behavior before enabling production login or agent writes.

### Limitations

- Lark international (`larksuite.com`) is supported; Feishu (`feishu.cn`) is not.
- Multi-user mode is required; single-user mode is not supported.
- Agent actions use user identity only; bot identity and tenant-token actions are not implemented.
- Local CLI hand-off and MCP variants are not implemented.
- Local disconnect deletes AnythingLLM credentials but does not revoke the remote Lark grant.
- International send-as-user remains blocked for production until verified in Lark API Explorer.
- Lark console labels may change; fixed protocol URLs and repository behavior remain authoritative.
