# Plan — Lark admin Test connection from form values + browser E2E for every Lark flow (issue #18)

Bug found by human test on 2026-09-05 after issue #2 closed. Spec + approved mockup
(`docs/superpowers/mockups/2026-09-05-lark-login-and-user-cli.html:149,267`) show "Test connection"
working straight from the form with no prior save. Implementation only tests persisted settings, and
Save (enabled) requires the tenant_key that only Test connection provides. Recon: `.infi/recon-lark-e2e-ui.md`.

## 1. Global Constraints

- Branch `feat/lark-login`, worktree `.claude/worktrees/lark-login`, base HEAD `5e032a15`. Never push.
- Never run the real Lark CLI; never put its hyphenated name in a Bash command (hook). Jest via
  `node ../node_modules/jest/bin/jest.js`. Node 22 at `/opt/homebrew/opt/node@22/bin` for servers
  (has SlowBuffer); Node 26 is the default shell node.
- Security invariants from issue #2 stay: app secret never returned to the browser; the test route
  remains strict admin (`strictMultiUserRoleValid([ROLES.admin])`); a masked secret `********` means
  "use stored secret"; secrets never logged. `SERVER_URL` stays required to enable.
- Missing-input behaviour (lesson #10): when neither body nor stored credentials exist the test route
  answers `{ ok:false, error:"missing_credentials" }` (200); rejected by Lark → `"rejected"`; network or
  non-JSON → `"unreachable"`. Fixed enum, no raw error text.
- Existing suites stay green: `__tests__/utils/lark` (130) and `__tests__/e2e/lark` (21, 0 skipped).
- Playwright: `@playwright/test` 1.62.1 already in root node_modules; Chromium 1148 installed. Config
  file `e2e/lark.playwright.config.ts` (new; do not touch the sibling branch's `e2e/` harness files —
  that directory exists only on `feat/workspace-scoped-agents`, not on master, so this branch creates
  its own minimal `e2e/` files and they must not collide by name: use `lark.*` prefixes).
- Browser E2E boots the REAL server (production build served from `server/public`, `NODE_ENV=test`,
  temp storage + sqlite via the existing helpers in `server/__tests__/e2e/lark/helpers/`), the REAL
  mock Lark server, and drives Chromium against `http://127.0.0.1:<port>`. No jest mocks, no
  network to real Lark. Frontend must be built once with `VITE_API_BASE='/api'` by global setup if
  `server/public/index.html` or `_index.html` is missing or older than `frontend/src` (cache in
  `e2e/.cache/lark-frontend.stamp`, gitignored).
- Evidence contract (issue #18):
  `cd server && node ../node_modules/jest/bin/jest.js __tests__/e2e/lark --runInBand && cd .. && npx playwright test -c e2e/lark.playwright.config.ts --reporter=line`
  must print `passed` with 0 skipped.

## 2. Tasks

### Task A — Test connection uses form values (server + frontend + tests) — Sonnet

Files: `server/endpoints/admin.js` (test route), `server/utils/lark/settings.js` (`fetchAppAccessToken`
error enum), `frontend/src/models/admin.js` (`testLarkConnection(payload)`), `frontend/src/pages/Admin/LarkSettings/index.jsx`,
`server/__tests__/utils/lark/settings.test.js`, `server/__tests__/e2e/lark/lark.e2e.test.js` (scenario 1),
`docs/lark-setup.md` (admin steps).

1. Route `POST /admin/lark-settings/test` accepts optional body `{ lark_app_id, lark_app_secret }`.
   Resolution: body app_id else stored; body secret unless empty or `********`, else stored decrypted.
   Validate app_id with the same rule as settings validation. Missing either → `missing_credentials`.
   Never persist anything from this route.
2. `fetchAppAccessToken` throws a typed error: `rejected` (HTTP ok but code≠0 or 4xx/5xx JSON),
   `unreachable` (fetch throw / non-JSON). Route maps to the enum; still 200 with `{ok:false,error}`.
3. Frontend: `Admin.testLarkConnection({ lark_app_id, lark_app_secret })` sends form values (secret
   omitted when not editing so the stored one is used). On success fill the tenant_key input if empty
   and show `Connection successful. Tenant: <key>`. On failure show a message per enum:
   missing_credentials → "Enter App ID and App Secret first."; rejected → "Lark rejected the App ID or
   App Secret."; unreachable → "Could not reach Lark. Check network and try again."
   Add `data-testid` on: app-id input, app-secret input, tenant-key input, enabled toggle, test button,
   save button, test-result box.
4. TDD: unit tests for the route (body over stored, masked secret uses stored, missing → enum, manager
   still 401, nothing persisted) and enum mapping; E2E scenario 1 gets a step "test BEFORE save with
   form credentials → ok + tenant_key" and "missing → missing_credentials".
5. Docs: admin flow becomes fill → Test → tenant auto-filled → enable → Save.

Acceptance: `__tests__/utils/lark` green (count grows), `__tests__/e2e/lark --runInBand` green,
`cd server && npx eslint .` 0 errors, `cd frontend && npx eslint src` clean, `yarn build` passes.
Commit: `fix: test Lark connection with form credentials before saving (#18)`.

### Task B — Playwright browser E2E for every Lark user flow — Sonnet (parallel with A; touches only new files + `.gitignore` + root `package.json` script)

Files (new): `e2e/lark.playwright.config.ts`, `e2e/lark/global-setup.ts`, `e2e/lark/global-teardown.ts`,
`e2e/lark/fixtures.ts`, `e2e/lark/*.spec.ts`; `.gitignore` add `e2e/.cache/`, `e2e/.state/`, `e2e/logs/`,
`test-results/`, `playwright-report/`; root `package.json` script `"test:e2e:lark": "playwright test -c e2e/lark.playwright.config.ts"`.

Global setup: build frontend if stale (see constraints), copy `frontend/dist` → `server/public`
(only when stale), `createTempEnvironment()` + `MockLark` + `startServer()` from the existing helpers
(require via `createRequire`), enable multi-user with an admin, write `{ baseURL, mockLarkUrl, admin }`
to `e2e/.state/lark.json`; teardown stops server, mock, removes temp root. Playwright `use.baseURL`
read from that file; `workers: 1`; trace `retain-on-failure`; `expect` timeout 10 s.

Specs, each an independent test driving the UI (log in through the real login form, not by injecting
JWT, except where noted):
1. `admin-settings.spec.ts` — admin → `/settings/authentication/lark`: empty form → click Test →
   "Enter App ID and App Secret first."; fill app id + secret → Test → tenant auto-filled and success
   box; toggle enable → Save → toast; reload → secret shows masked, values persisted; manager login →
   page not in sidebar and direct URL redirects/denied.  (Depends on Task A's testids and enum — coordinate:
   until A lands, write against the agreed testids and expected strings above; the suite goes green after A.)
2. `login.spec.ts` — logout → login page shows "Login with Lark" only when enabled; click → lands on
   mock authorize → auto-redirect → `/sso/lark` → home as new user; username = email local-part visible
   in account menu; second login as same Lark user → same account (no duplicate). Denied consent
   (`?deny=1` via mock toggle) → back on `/login` with the denied banner; foreign tenant (mock user
   toggle) → tenant banner and no user created (assert via admin Users page count).
3. `connect.spec.ts` — password user → `/settings/lark` shows Connect → click → mock → back with
   "Lark account connected." toast, profile name/email shown, no token text anywhere in DOM →
   Disconnect → confirm → shows Connect again.
4. `single-user.spec.ts` — flip `multi_user_mode` off via DB helper (`withDb` from helpers/db.js) →
   login page has no Lark button, `/settings/lark` is not reachable, `/api/lark/status` → 403 and
   `/api/ping` still 200 → restore.
5. `agent-skill.spec.ts` — admin → Agent Skills page lists "Lark" skill entry and it can be toggled
   on and persists after reload (UI only; the CLI itself is never run).

Acceptance: `npx playwright test -c e2e/lark.playwright.config.ts --reporter=line` → all passed, 0
skipped, runtime < 4 min, leaves no listening ports and no temp dirs (assert in teardown). Node 22 must
be on PATH for the server child: global setup prepends `/opt/homebrew/opt/node@22/bin` if present and
otherwise uses current node with the existing preload shim.
Commit: `test(e2e): browser E2E for Lark admin, login, connect, single-user and skill flows (#18)`.

### Task C — Final: run the full evidence contract on the merged HEAD, `task.sh check --issue 18 --base 5e032a15`, review.

## 3. Rulings
- Test route stays POST and admin-only; credentials in body are fine because the secret already
  travels in the settings POST over the same channel.
- Browser suite is a separate Playwright config, not wired into the sibling branch's `run.sh`, to
  avoid a cross-branch dependency; a follow-up can merge them after both branches land.
