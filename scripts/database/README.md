# One-time SQLite → PG / R2 tools

These tools implement the approved one-time migration scope. Production
continuation is operator-authorized, but the cutover is **not complete**; see the
operator runbook in
`docs/runbooks/2026-10-08-sqlite-postgresql-r2-migration.md` and execution evidence
in the corresponding plan. No recurring backups, pruning or object deletion.

## Reproduce local checks

Requirements: installed server dependencies/Prisma 5.3.1, Python 3.11+, Docker,
OpenSSL, the pinned existing PG fixture image and generated separate PG client.
Root Jest 29 or `MIGRATION_JEST_PATH` pointing to an installed Jest 29 entrypoint.

```bash
node scripts/database/postgresql-schema.cjs --check
node scripts/database/test.cjs all
node scripts/database/cli.cjs --help
```

The suite runs owned disposable containers serially, uses synthetic secrets and
blocks outbound integrations during full app smoke. No fixtures can silently
skip requested PG tests. A full app image smoke additionally requires an explicit
`MIGRATION_RUNTIME_IMAGE` referencing a reviewed local migration-only fixture:

```bash
MIGRATION_RUNTIME_IMAGE=anythingllm-pg-migration:local-fixture node scripts/database/test.cjs postgres
```

Without that variable, model/database/restore tests run, but **full application
smoke is not claimed**. No fixture image is a production release by implication.

## Boundaries

- `snapshot.py`, `storage.py`: read-only SQLite backup/typed export and consistent
  storage archive primitives. Caller must independently stop/verify all writers.
  Capture/restore permit and preserve setgid directories used by Kubernetes PVCs,
  but reject setuid/sticky bits and setgid regular files. Ownership is not replayed;
  use the approved runtime UID/GID mapping. Never chmod production source storage
  to bypass capture validation. The Linux maintenance smoke must verify actual
  mode preservation; filesystems that clear special bits cannot certify it.
- `schema-contract.cjs`: reviewed physical mapping/FK order, not a general loader.
- `import.cjs`: explicit fresh PG target, exclusive locks, full validation before
  commit, retained state marker after failure/uncertain commit. No force/reset,
  append/upsert or automated retry.
- `verify.cjs`, `original-snapshot.py`: complete target-value comparison against
  an independent read of recovered SQLite, sequence and catalog checks.
- `recovery-set.cjs`, `publication.cjs`: authenticated encrypted payloads,
  downloaded SHA-256 verification and completion-last recovery publication.
- `r2.cjs`: pinned S3-compatible CLI with credentials mounted read-only; conditional
  uploads/download/list only. Current image is arm64/local Docker; live execution
  platform and actual R2 behavior must be verified separately.
- `cli.cjs`, `offline.py`: protected request files only, never command-line URLs
  or developer `.env`. Migration connections explicitly verify CA/hostname and
  exact requested target. Commands do not establish authorization.

Keep plaintext intermediates/key references protected. Production and Kubernetes
Secret material must never appear in test fixtures, logs, Git or pasted requests.
Retain original SQLite/storage and the R2 recovery set. Post-PG-write rollback is
not a simple switchback; no protection of later PG writes is provided by this set.

## Pending live gates

Fresh baseline/writer checks; rebuilt maintenance image with Linux setgid smoke;
complete immutable app-data capture, encrypted publication and independent
recovery; verified PG import and controlled cutover. Images and independent key
custody were prepared, but the first storage capture failed and SQLite resumed.
No complete production backup or PG data import has been performed. Unenforced
NetworkPolicy is an explicitly accepted internal-deployment risk, not a blocker.

The explicitly authorized actual-R2 synthetic probe passed upload/download,
checksum/decrypt, separate-process restore, zero-byte payloads, conditional 412
no-overwrite and wrong-key rejection. See
`docs/runbooks/2026-10-08-r2-live-synthetic-probe.md`. This is transport proof,
not a live application backup, key-custody approval or production go/no-go.
