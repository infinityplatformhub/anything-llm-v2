# Release follow-up: recovery issuance, attachment readiness, root lint

## Approved scope

User approved three bounded fixes after diagnosis: atomic recovery-code issuance
and concurrent-login protection, disabled attachment selection until collector
readiness, and root ESLint compatibility without dependency/schema updates.
Base: `39cd4390bf65ac44ef2f9ed509ba48641871a92d`.
No additional upstream backports, commit, push, or deployment in this follow-up.
Production memory remains disabled; production was not stress-tested.

## Implementation

- `RecoveryCode.issueForUser` atomically replaces undisclosed codes, inserts a
  new set only for an unseen user, and updates the seen flag. Conditional SQL
  uses parameterized Prisma queries in a batch transaction on the existing
  SQLite schema. A competing issuance cannot append codes to an issued set.
- An interactive transaction was rejected after the isolated concurrent HTTP
  test reproduced an expired transaction. A batch transaction avoids application
  callbacks while holding the writer lock. SQLite deferred-lock upgrade can
  still return `P2010` with SQLite code `5`; only that confirmed busy error gets
  one 50 ms delayed retry after rollback. Other errors propagate. Persistent
  contention still fails safely; this does not claim all SQLite timeouts fixed.
- A losing concurrent login receives no new codes. The login response omits
  `recoveryCodes` instead of returning a truthy empty array that opens an empty
  recovery-code modal.
- Attachment input and button reflect provider `ready`; offline and pending
  health checks disable selection. Existing upload/navigation behavior remains.
- Root ESLint uses already installed compatible frontend React/hooks plugins;
  React rules are scoped to frontend. Original hooks safety/exhaustive-deps
  checks remain; new compiler rules are not introduced.

## Red / green evidence

Before implementation, real SQLite regression tests reproduced committed codes
after failed user update, concurrent duplicate codes, repeat issuance, and old
undisclosed codes accumulating. Actual JSX readiness test reproduced an enabled
button before deferred health resolved. Original root ESLint exited 2 with
`context.getFirstTokens is not a function` at `react/display-name`.

Final verification:

- **93 tracked server suites / 1,457 tests passed**, including 12 additional
  tests relative to the released suite. Explicit paths exclude E2E, helper-only
  files and unrelated child worktrees.
- Actual migrated SQLite in network-isolated Docker: concurrent authenticated
  HTTP login twice, both requests returned 200 each time, code counts `[4, 0]`,
  exactly four stored codes. Fixture cleanup passed.
- Persistent controlled SQLite writer lock: failure leaves zero newly issued
  codes and unseen user flag; after lock release a normal retry creates four
  codes. Fixture cleanup passed.
- Root lint on all five changed backend/frontend implementation files exits 0
  with existing warnings. New executable config tests prove backend `no-undef`
  remains active and frontend unsafe links/conditional hooks still produce errors.
- Frontend-config scoped ESLint exits 0 without diagnostics.
- Frontend production build and postbuild passed; existing chunk-size warning.
- Prettier on changed application/test files passed; `git diff --check` passed.

## Wider test-command limitation

The bare root Jest run collected unrelated `.claude/worktrees` and the non-test
helper `server/__tests__/utils/lark/_polyfill.js`, then aborted with JavaScript
heap exhaustion. It did NOT pass. Failing paths are retained in
`followup-full-suite.log`: the helper; child-worktree Lark settings/auth/plugin,
MCP OAuth/gating suites; child-worktree collector GiteaRepo/GithubRepo,
WebsiteDepth and htmlToMarkdown suites. Those unrelated files/configurations
were not changed. The explicit tracked server run above passed. This is not an
assertion that all root/collector/browser-companion tests pass.

## Isolated memory coverage and limits

Before implementation, enabled-memory authenticated HTTP CRUD, ownership,
workspace isolation, promote/demote, disabled gates and real chat provider-path
prompt isolation passed in a network-isolated container. LLM completion was a
loopback mock, not an external LLM (`AIG_API_KEY` absent). Production was untouched.
The changed attachment UI is verified with actual JSX/DOM regression and build;
new-version Playwright smoke remains a pre-release gate, not a completed result.

Independent reviewer dispatch remains unavailable (`Subagent session not found`).
Direct inspection is not independent review. The isolated image's restart also
hit an amd64-on-ARM emulation assertion during Prisma CLI startup; the prepared
fixture database was reused in a server-only, local-only test container instead.
Test fixtures cleaned; both test containers stopped. No fixture image published.

Logs under the approved OpenCode temporary directory:
`followup-red.log`, `followup-readiness-red.log`, `followup-tracked-final.log`,
`followup-root-lint-final.log`, `followup-frontend-build.log`,
`followup-concurrent-login-final.log`, `followup-recovery-lock-final.log`,
`anythingllm-followup-memory-http.log`, `followup-full-suite.log`.

## Step 2 release authorization and pre-release browser gate

The user subsequently authorized finishing Step 2 with browser smoke, commit,
push, deployment to the existing VKE instance, and production smoke testing.
No Step 3/upstream additions are included. Production memory must remain off.

Fresh pre-release verification: 93 suites / 1,457 tests, frontend production
build/postbuild with `VITE_API_BASE=/api`, changed-file root lint, Prettier and
diff checks passed. Root lint still reports existing warnings.

Playwright against the isolated, updated backend and newly built frontend passed
normal password login/recovery acknowledgment, disabled button/input during
deferred collector health, enabled selection on readiness, actual image chooser,
SPA thread navigation and subsequent image selection, SPA workspace isolation;
no page errors, fixtures cleaned. The local collector health boundary is mocked
because this fixture runs the server only; deployed smoke must also check real
collector readiness. Local build initially used the existing development `.env`
API URL; rerunning with the relative production API path corrected the test
environment without changing any environment file.

Step 2 logs: `step2-browser-local.log`, `step2-release-suite.log`,
`step2-frontend-build.log`, `step2-root-lint.log` in the approved temporary folder.
Production release results are recorded separately after rollout; they are not
claimed by this pre-release evidence.
