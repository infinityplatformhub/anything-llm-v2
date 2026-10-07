# Step 3: targeted attachment correctness backports

## Approved design/scope

User approved three bounded upstream fixes and the same regression/build/browser,
review, commit/push/deploy/production-smoke workflow as previous releases.
Base: `475a6da70b7b4365721ae6d69fd8cf0b1f8a38bd`.

- `0c23763c` (#6585): optional document access when removing parsed files from a
  queue that also includes images; ignore image-removal events at parsed-file API.
- `495ad61a` (#6633): protect referenced collector output by basename of parsed
  metadata.location (including MBOX -msg-N output); preserve slugified filename
  fallback for legacy/missing/malformed metadata.
- `50b1b151` (#6629): inspect aggregate response.ok in both modal and parsed-file
  menu embedding paths; show error rather than unconditional success on failure.

No full upstream merge, schema/dependency change, new provider, MCP credential
change, or SQLite contention refactor. Existing conversation isolation/readiness
and late-completion safeguards retained. Memory must remain disabled in production.

## Red-green verification

Before implementation actual JSX tests reproduced mixed image/parsed removal
crash and image-removal listener rejection; modal and parsed-menu failure/mixed
response batches incorrectly displayed success. A real temporary-filesystem test
ran the actual cleanup job with only model/job completion boundaries substituted;
it reproduced deletion of referenced MBOX -msg-N files.

After implementation:

- **94 tracked server suites / 1,465 tests passed** (8 additional tests). Includes
  new real-filesystem cleanup regression and actual JSX removal/toast cases.
- Positive controls: successful embedding still shows success, legacy filenames
  retained, actual orphan removed, image retained after parsed-file removal.
- Frontend production build/postbuild passed with relative `/api` build setting.
- Scoped frontend ESLint passed; changed-file root lint exits 0 with existing
  warnings; `git diff --check` passed.
- Browser local updated UI: login/recovery, readiness, SPA thread/workspace
  isolation, actual chooser/mixed queue removal, no-crash image removal, modal
  and parsed-menu error toast passed with no page errors and fixtures cleaned.
  Parse/delete/embed responses are browser-intercepted fixtures; local collector
  health is mocked. This proves UI behavior, not live embedding success.

## Review / limitations

Direct inspection against the three upstream patches: implementation is scoped
to four files and follows their logic. Independent reviewer dispatch still fails
with `Subagent session not found`; no independent-review claim.
Full bare root Jest previously collects unrelated child worktrees/helper files
and exhausts heap; verification uses explicit tracked server test paths plus new
test. This does not claim exhaustive collector/browser-companion/live integration
parity. Existing large frontend chunk warning remains.

Cleanup deletion testing must use only temporary storage, never manually run the
global cleanup job on production data. Production browser synthetic failure
coverage must intercept parse/delete/embed rather than induce live service errors.
Production release digest/results will be recorded separately after rollout.

Logs in approved OpenCode temporary directory: `step3-red.log`, `step3-suite.log`,
`step3-build.log`, `step3-lint.log`, `step3-browser-local.log`.
