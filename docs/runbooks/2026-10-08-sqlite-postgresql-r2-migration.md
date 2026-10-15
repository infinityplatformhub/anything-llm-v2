# SQLite → PG / preserved R2 recovery set — operator runbook

Status: corrected local rehearsal passed on the latest inspected live-image
baseline; the user explicitly accepted the internal-network isolation risk on
2026-10-08 and requested continuation. The first live maintenance attempt was
aborted on storage permission validation and the original SQLite deployment
resumed. **Production PostgreSQL cutover is not complete.**
Current evidence and remaining
gates: `docs/runbooks/2026-10-08-pg-pre-cutover-readiness.md`.
Authority: approved migration design and plan dated 2026-10-08 under `docs/specs/`
and `docs/plans/`. Scope is one preserved SQLite DB + app-storage R2 backup,
verified recovery and PG migration. No schedules, pruning or extra features.

## Local entrypoints

```bash
node scripts/database/cli.cjs --help
node scripts/database/cli.cjs contract
node scripts/database/test.cjs all
```

`MIGRATION_JEST_PATH` may identify installed Jest 29 if root dependencies are
absent. Tests use synthetic fixtures and owned disposable containers, not
production. Adapter tests are not actual R2 proof. Operations require
`--request <0600 JSON file>`; never supply credential URLs as CLI arguments.
The CLI does not load `.env`, prints fixed redacted failures and does not grant
production authority.

## Production prerequisites

- Verify deployed image/source, schema/history and DB/storage identities.
  Historical `f43be3da` is not fresh proof. Assemble migration-only changes on
  that verified baseline, excluding unrelated agent-finalization code at HEAD.
- Inventory/freeze **all** DB/file writers and restart controls: server,
  collector, sidecars, schedulers/connectors, webhooks, maintenance/GitOps/HPA.
- PG NetworkPolicy remains unenforced, with explicit operator risk acceptance
  dated 2026-10-08 in the approved design. It is no longer a cutover blocker for
  this migration. Preserve internal-only exposure, TLS and least privilege; no
  cluster-wide CNI change or additional network privileges.
- Verify PG artifact/runtime, strict Prisma TLS/CA/hostname, least privilege,
  schema/data/capacity and full login/chat/agent/file smoke.
- Safely discover existing R2 Secret references/current validity and approve a
  synthetic probe. No full Secret dumps, decoded values or logged environments.
- Establish independent custody of archive key **and effective application
  SIG_KEY/SIG_SALT**; `.env` alone is insufficient. Recovered original keys must
  decrypt representative settings with external integrations blocked.
- Present actual readiness evidence and instantiated cutover for go/no-go.

## Protected request contracts

### Dedicated maintenance image

The application image deliberately does not contain the full offline CLI. Build
a separate maintenance image from the reviewed migration runtime, not repository
HEAD. The Dockerfile-specific allowlist includes only top-level migration source
and reviewed Prisma schema/migration files; no test fixtures, credentials, `.env`,
application storage or unrelated source. The CLI and source history live under
`/app/maintenance`, separate from the inherited app. This prevents inherited live
SQLite migrations and the reviewed source extensions from being applied twice.
Runtime dependencies, generated client and validators are reused through
symlinks without replacing the inherited application files. Mount the container
root filesystem read-only for production operations, with separate owned output
and temporary volumes.

```bash
docker build --platform linux/amd64 \
  --build-arg RUNTIME_IMAGE=<reviewed-migration-runtime-reference> \
  -f scripts/database/Dockerfile.maintenance \
  -t <owned-maintenance-image> .
docker run --rm --platform linux/amd64 --network none <owned-maintenance-image> --help
docker run --rm -i --platform linux/amd64 --network none \
  --read-only --tmpfs /tmp:rw,uid=1000,gid=1000,mode=1777 \
  --entrypoint python3 <owned-maintenance-image> - \
  < scripts/database/tests/maintenance_image_smoke.py
```

Use immutable registry digest references for production. The entrypoint requires
an explicit CLI operation and protected request; the default only prints help.
Do not deploy it as the application image or grant it production credentials
during fixture checks. Mount only the operation's necessary source, output,
request and credential references.

### Operation inputs

All paths and references must be safely identified; examples below are field
names, not guessed live values. Keep requests and intermediate plaintext in a
protected directory. No production rows/keys in logs.

- `capture`: `database`, `storage`, fresh `directory`, explicit
  `excludeStoragePaths` for actual DB/WAL/SHM relatives, `writersFrozen: true`,
  `freezeEvidence` reference. This attestation is not automated proof. Creates
  WAL-aware `sqlite.db`, consistent `storage.tar`, and protected `capture.json`.
  Stop on any integrity/FK/file-inventory change; preserve incomplete evidence.
- `export`: closed immutable `snapshotPath`, `sourceSha256`, reviewed `contract`,
  fresh `exportPath`. Tagged plaintext export is sensitive; encrypt before upload.
  Unknown schemas/types, overflow/NUL, invalid Boolean or time precision stop.
- `publish`: bucket `anything-llm-backup`, validated R2 `endpoint`, protected
  AWS-format `credentialsFile`, independently protected raw 32-byte `keyFile`,
  unique `prefix`, work `directory`, named payload paths and source identities.
  Include DB/storage and approved protected effective-key recovery payload.
  Current pinned AWS CLI adapter image is arm64/local Docker, not a Kubernetes
  Job artifact. All PUTs are conditional no-overwrite; download/checksum/decrypt
  precede manifest and completion-last publication. No delete/prune API.
- `restore`: same protected transport/key references, prefix, fresh directory.
  Validates complete authenticated/checksummed sets. `restore-storage` takes
  `archivePath`, `archiveSha256` and fresh extraction `directory`; unsafe paths,
  links/devices are rejected. Setgid is permitted only on directories and its
  mode is preserved; setuid/sticky bits and setgid files remain rejected.
  UID/GID inventory requires approved runtime mapping; arbitrary ownership is
  never restored. Never change original PVC permissions to make capture pass.
- `import` / `verify`: protected `connectionFile` (URL without query options),
  explicit `caFile` with mandatory certificate/hostname verification and exact
  `target: {host, port, database, schema: public, role: anythingllm_migrator}`, approved
  `artifact`/`contract`, recovered `snapshotPath`/`sourceSha256`,
  `exportPath`/`exportSha256`. Import additionally needs fresh persistent
  `stateDirectory`. Retain it: IN_PROGRESS/UNKNOWN quarantines the target, not
  permission to pick a new directory and retry production. Never reset/truncate,
  append/upsert or automatically retry uncertain commits. Verification reads
  original SQLite independently, not only export summaries.

## Actual cutover sequence — not completed

Reconfirm gates → stop writers/reconciliation → final consistent capture →
encrypted R2 publish/download verification → independent restore on separate
storage/PG with effects blocked → migrator-only schema on fresh target → import
same snapshot → full preservation verification → approved PG artifact with runtime
credentials/original keys/storage → controlled smoke → explicitly reopen traffic.

Retain original SQLite/storage/artifact and R2 set. Before PG writes **and storage
mutation**, rollback may resume SQLite only after proving compatible files and
one writer. After either boundary, including startup jobs, freeze/prefer
repair-forward; reverse migration/reconciliation/data loss needs explicit approval.
One-time backup does not cover later PG writes.

## Open limitations

Latest-live-digest local candidate/app smoke, read-only live inspection and scoped
independent correction reviews have completed. Runtime and maintenance-v1 images
were pushed, and a read-only-source maintenance pod was prepared. The first freeze
was aborted before complete storage capture, R2 publication or production PG
writes. The corrected maintenance image, fresh freeze/capture, actual independent
application-data recovery and cutover remain unpassed. Network enforcement is
unproven with explicit operator risk acceptance, not a pending blocker.
Local fixtures and scoped review are not production-migration completion evidence.

## Operator-authorized continuation evidence

- Fresh read-only live inventory reconfirmed app generation 21 / digest
  `8a98ca8a...`, two Ready app containers, PG Ready and both PVCs Bound. No
  namespace Jobs, CronJobs, DaemonSets or HPA were listed. Both application
  containers mount writable storage; freeze the entire Deployment.
- Live storage metadata: 336,060 KiB used (about 328 MiB), with 20,113,808 KiB
  available on the application PVC. This is capacity metadata, not a data
  snapshot or proof of frozen writers.
- Built local `linux/amd64` maintenance image
  `anythingllm-pg-maintenance:codex-20261008`, identity
  `sha256:c7bf1bb8578a28a997e85bd3cfaf09c93db7d69e0828c7d3020d69611f273929`.
  It is based on reviewed migration runtime `sha256:13223aff...`; subsequent
  image delivery is recorded below. `RUNTIME_IMAGE` intentionally has no implicit
  default;
  BuildKit reports `InvalidDefaultArgInFrom` unless a valid default is provided,
  while this explicit-base build succeeds.
- The standalone synthetic smoke passed ten checks across all 40 model tables:
  packaged-source allowlist, inherited PG schema/migration provenance, contract,
  mandatory freeze attestation, SQLite snapshot, typed export, wrong-checksum
  rejection, storage restoration, original-source preservation and protected
  output modes. It ran as UID 1000, with no network, a read-only root filesystem
  and a separate ephemeral `/tmp` volume.
- Packaging smoke exposed inherited SQLite history plus duplicate source
  extensions and accidental inclusion of `seed.js`/README. The isolated
  maintenance history and recursive context exclusions corrected both; no
  production or runtime migration validation was relaxed. Python syntax and
  `git diff --check` passed.

These local preparation checks preceded the authorized live attempt below and
are not proof of a completed production backup or migration.

## Live attempt aborted; storage correction — 2026-10-09

- Run `sqlite-pg-20261008T171314-a2333146` retained protected local operation
  evidence and independent archive/application-key custody. Credential or
  application-key values must never be included in this runbook or logs.
- Immutable runtime `sha256:13223afff08046e5e058f8df0b97c58d8fcc0a0dcecaccb7177bf9981cfa6253`
  and maintenance-v1 `sha256:c7bf1bb8578a28a997e85bd3cfaf09c93db7d69e0828c7d3020d69611f273929`
  were pushed to the existing registry repository. The maintenance pod
  `anythingllm-migration-a2333146` mounts the source PVC read-only and writes only
  to its separate recovery volume.
- The entire application Deployment was stopped and zero writer pods verified.
  SQLite snapshot succeeded, but storage inventory rejected 1,999 legitimate
  setgid directories. The diagnostic found no other special-bit entries or
  unreadable directories. No complete recovery set or real R2 publication was
  created; production PG still had zero application tables.
- Evidence `freeze-aborted-storage-permissions.json` records the safe resumption
  of the original SQLite image at `2026-10-08T17:44:16.345Z`. Its rollout passed;
  source storage, application keys and production PG data were not modified.
  The partial capture is retained as failure evidence, **not a usable backup**.
- An independent Docker recovery target already has the reviewed migrator-only
  schema (40 application tables plus ledger), strict TLS and runtime ledger
  read-only privileges. No recovered application rows have been imported.
- Source capture and restore validation now permit setgid directories only.
  A synthetic `2770` directory archive reproduced restore rejection before the
  fix and succeeds afterward. Negative archive checks still reject setuid,
  sticky and setgid-file modes before extraction. Linux maintenance smoke now
  requires exact `2770` preservation, unchanged source permissions and rejection
  of disallowed capture modes; it does not skip these checks.
- Local Python run: 41 tests, zero failures, with five filesystem-dependent
  skips (one full setgid-preservation test and four capture-mode subtests because
  this host clears those bits). Node configuration/schema/recovery groups passed
  66 tests; runtime had 31 passes and three Docker-dependent entrypoint failures.
  These host results **do not certify Linux mode preservation**.
- This continuation's sandbox denies the Docker socket and Kubernetes API
  connection (`operation not permitted`). No image rebuild/push, fresh live
  freeze/capture or cutover was possible here. No new production mutation was
  attempted, and no network-isolation decision needs to be reconfirmed.

Resume with a session that can access Docker and the explicit dev2 kubeconfig:
build/push a uniquely tagged maintenance-v2 image from the reviewed runtime and
pass its Linux smoke; recheck the live template/image, effective keys and all
writers, then re-freeze and capture to a **fresh** directory. Do not require the
historical generation 21 after scale-down/up; guard mutations with current
resourceVersion and unchanged template/image. Publish and independently recover
the complete set before production PG import/cutover. Never reuse the aborted
capture or retry an ambiguous import using a new state directory.
