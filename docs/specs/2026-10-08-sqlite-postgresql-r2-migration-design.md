# SQLite → PostgreSQL with a preserved R2 recovery set

Date: 2026-10-08
Status: Architecture approved by the user in this OpenCode session; independent review completed with two contract clarifications incorporated below. Implementation-plan approval remains outstanding.
Execution: Supervised OpenCode workers, independent review, correction loop.
Repository baseline: `a17d40f31eb6d8a4d28a40f9297aa38d9c831ff2`.

## Outcome and scope

Back up the existing SQLite database **and application storage** to the existing private R2 bucket `anything-llm-backup`, preserve that recovery set, verify recovery, and migrate the application database to the dedicated PostgreSQL instance.

The user confirmed DB + storage and clarified that the immediate task is to preserve a backup and migrate to PG. Scheduled backups, retention/pruning, lifecycle changes and numerical RPO/RTO are **not part of this task**. Earlier provisioning documents' scheduled-backup requirement is superseded for this task by the current one-time backup direction; recovery verification and access-control gates still apply. This is not a claim of continuous disaster recovery or protection of later PG writes.

Do not add HA, pgvector/vector-provider changes, UI, MCP changes, unrelated agent fixes, general dependency upgrades, schema cleanup or cluster-wide CNI changes. Preserve existing untracked user work. Do not push or commit unrelated files.

## Facts and production gates

- Checked-in application: SQLite Prisma provider, SQLite migrations, runtime URL override through `ANYTHINGLLM_DATABASE_URL`, startup migration execution.
- Historical infrastructure evidence: dedicated VKE PostgreSQL 17.11, retained 20 GiB SSD, TLS/SCRAM, separate administrator/migrator/runtime accounts; synthetic verification passed. These are not newly verified live results.
- Parent recovered prior OpenCode discussion: synthetic R2 upload/download/checksum/list/delete passed, temporary S3 credentials authorized and stored in a Kubernetes Secret. Secret name/current validity need safe reference discovery; never print or store credential values in Git.
- Historical blocker: an unauthorized client could reach PG despite NetworkPolicy. Do not claim isolation from YAML alone or waive this gate silently.
- Production application revision was previously reported as `f43be3da`; exact image/source/schema/storage and all active writers need read-only verification. Repository HEAD is not proof of the deployed baseline.
- No actual production backup, migration or cutover has been completed by this workflow.

## Options and recommendation

1. **Separate PG schema/migration/client artifact and offline typed import (recommended).** Preserve SQLite defaults and existing tests; add provider-parity checks. Limits changes to the migration but requires an isolated PG test path.
2. Replace the existing SQLite provider everywhere. Simpler artifact selection, but disrupts SQLite development/tests and the preserved rollback artifact; SQLite SQL history still cannot run on PG.
3. Online dual writes or generic loading without explicit preservation checks. Adds reconciliation complexity or leaves fork-specific data conversion unverified; not recommended within this scope.

The recommended implementation is option 1, subject to approval. Do not replace this fork's schema with `upstream/pg`: preserve Lark, workspace MCP, agent settings and all other current fields.

## Implementation contracts

### Provider and deployment

- Retain current SQLite schema/history/defaults. Add a dedicated PostgreSQL schema and history, derived from the complete fork schema, with parity tests for fields, mappings, relations, defaults, constraints and indexes.
- Generate provider-specific clients/artifacts without overwriting the SQLite client used by existing tests. PG configuration must fail closed on missing/wrong URL or provider, unavailable PG or incompatible schema; never fall back to SQLite.
- Preserve `ANYTHINGLLM_DATABASE_URL` as the explicit runtime override; do not introduce ambient `DATABASE_URL` redirection.
- Apply PG DDL through an explicitly invoked migrator-only task. PG runtime startup must not run migrations or receive administrative/migrator credentials. Preserve SQLite startup compatibility.
- Verify runtime grants, sequence access and actual Prisma TLS CA/hostname checking; a `psql` test alone is insufficient.
- Existing migrator default privileges grant runtime DML on future tables, including `_prisma_migrations`. The explicit PG DDL task must revoke runtime INSERT/UPDATE/DELETE and other write privileges on that ledger; grant SELECT only if the read-only startup check needs it. Test application CRUD/sequence allocation succeeds while ledger writes and DDL fail.
- Audit raw SQL and transactions. Fix only reproduced PG incompatibilities, including recovery-code issuance (`createdAt` quoting/concurrency) and scheduled-job claiming. Propose per-parent-row locks within PG transactions to retain existing invariants; verify through real-PG concurrent tests. No scheduler/recovery feature redesign.

### Consistent one-time R2 backup

- Inventory DB location and persistent storage, configuration/encryption dependencies and external services without exposing values. Do not claim that external vector data is included in local storage.
- At the final capture, stop and verify **all** DB/file writers, including jobs/collectors/connectors/webhooks; prevent automatic restart. Capture a WAL-aware SQLite snapshot plus storage from that same frozen boundary. Never copy only a live SQLite main file.
- Check SQLite integrity and foreign keys. Preserve the original SQLite database and storage. Use the same immutable snapshot for backup validation and final import.
- Keep sensitive DB/storage contents protected in transit and at rest. Client-side encryption is proposed for sensitive recovery payloads; key custody must be independently recoverable and approved before real data upload. Do not introduce a new secrets platform, upload plaintext credentials or regenerate application encryption keys.
- Recover two distinct dependencies: the archive-decryption key **and the effective application `SIG_KEY`/`SIG_SALT` pair**. Secret-supplied values may differ from the PVC's `.env`; copying that file alone is not proof of recovery. Use approved protected recovery references/injection, never print values. The independent drill must restore the original application pair and prove representative encrypted settings decrypt with integrations blocked. Inventory or ciphertext comparison alone does not clear this gate.
- Consume the existing R2 Secret through protected references/mounts, not command arguments, logged environments or full Secret dumps. Use private HTTPS access and a unique run prefix; do not overwrite unfamiliar objects.
- SHA-256 payloads, upload, download and verify. Publish a protected manifest/completion marker **last**. Include run/source/snapshot identities, protected checksums, counts and dependencies, never secret values. R2 ETag is not a SHA-256 substitute.
- Partial/corrupt sets never count as complete; no automatic deletion, retention jobs or lifecycle changes. Preserve the pre-migration set until separately directed otherwise.
- Test recovery into independent disposable storage and PG, not another database on the production PG instance/PVC. Restored applications must have blocked/mocked outbound integrations and background effects.

### Guarded migration

- Bind immutable source checksum, mapping/schema version and explicit target identity. Reject unknown source tables/columns, unexplained production drift and invalid/unsupported values rather than skipping/coercing them.
- Require a fresh approved target or exact PG baseline with zero application rows. Reject existing data, unexpected migration history, partial imports, concurrent importers and wrong targets. No force/reset/truncate or destructive cleanup.
- Parameterized typed import in FK order with constraints enabled; bounded batches within one transaction. Re-evaluate before production if dependency cycles or transaction capacity require a different strategy.
- Preserve IDs, null versus empty/false/zero, timestamp instants/precision, hashes, JSON string formatting and ciphertext/text bytes. Preserve all fork fields and existing records; this is not cleanup.
- PG owns its own Prisma migration ledger; capture SQLite history as provenance, do not import it as PG migration history.
- Preserve sequence bounds using both imported maxima and SQLite sequence high-water marks, including deleted high IDs/empty tables. Verify next-ID behavior.
- Compare all tables' counts, full ID sets, typed canonical digests, relationships, constraints and sequences. Log protected aggregate evidence, not production rows or plaintext values.
- Interruption or uncertain commit is FAILED/UNKNOWN. Quarantine and inspect the target; sequence changes may survive rollback. Never automatically append/upsert on retry or delete source/targets.

### Network gate

Investigate a PG-specific access-control remedy and demonstrate allowed/denied clients to both Service and direct pod address with positive controls and restart/address-change checks. Authentication is not proof of TCP isolation. Any proposed remedy requiring elevated privileges or infrastructure changes must be reviewed separately before applying it. If a PG-only solution cannot be proven, report the blocker and stop production migration; do not change cluster-wide networking or silently weaken the gate.

Operator amendment, 2026-10-08: the user explicitly accepted the unenforced
network-isolation risk for this internal deployment and instructed migration work
to continue. This supersedes the network-enforcement cutover gate above; it is
not evidence that NetworkPolicy works. Preserve the internal ClusterIP-only
service, TLS, least-privilege roles and existing policy. Do not install network
controllers, grant network privileges or expose PG publicly. Actual backup,
independent recovery, encryption-key custody, writer freeze and controlled
cutover requirements remain unchanged.

## Execution and acceptance

1. Review this design; then review a concrete implementation plan. Use OpenCode workers with explicit file/task boundaries and independent review; send findings back until tests and scope checks pass.
2. Local fixtures: provider parity/build, SQLite regressions, disposable real-PG migrations/import preservation/concurrency/failure tests, synthetic DB+storage backup and independent recovery. No production credentials or data in fixtures.
3. Read-only production-baseline verification and rehearsal: reconcile schema/storage, build only migration-required changes on the verified app baseline, demonstrate isolation and measure migration/recovery. Do not bundle the previously parked agent image.
4. Present readiness evidence and the actual write-freeze/cutover sequence for production go/no-go. Freeze writers, capture final set, verify R2 recovery, import the same snapshot, validate completely, start only the approved PG artifact with runtime credentials and retained storage/encryption material, test login/chat/agent and reopen traffic explicitly.

Before PG writes **and storage mutation**, rollback may resume the retained SQLite artifact after proving single-writer operation. After either boundary, a simple switchback is unsafe: freeze, prefer repair-forward, and require explicit reconciliation/reverse-migration or data-loss decision. Startup jobs can cross the boundary before traffic opens. The preserved backup does not contain later PG changes.

Completion requires actual evidence for backup/recovery, complete data preservation, PG application workflows, least privilege/TLS and successful approved cutover. The isolation requirement is superseded only by the explicit operator risk acceptance recorded above; do not claim enforcement. Fixture success alone is not production completion. No ongoing PG backup guarantee is claimed.

## Grounding

- `docs/specs/2026-10-08-anythingllm-postgresql-vke-design.md`
- `docs/plans/2026-10-08-anythingllm-postgresql-vke.md`
- `.opencode/sdd/2026-10-08-anythingllm-postgresql-vke/progress.md`
- `cloud-deployments/k8/infi-dev2/postgres/{README.md,postgres.yaml,provision.py,verify.py}`
- `server/prisma/schema.prisma`, `server/prisma/migrations/`
- `server/utils/prisma/index.js`, `docker/docker-entrypoint.sh`
- `server/models/{passwordRecovery.js,scheduledJobRun.js}`

The existing provisioning verifier assumes synthetic/empty data and restarts PG. Do not run it unchanged against a populated migrated database.

## Independent review disposition

Read-only reviewer `ses_ee8289273ffecNF80Z2ZJxuWPg` reported no critical/high-severity contradiction and two medium findings. Both were checked against the local bootstrap, deployment Secret references and `EncryptionManager` behavior, and incorporated above. These are preimplementation contracts, not evidence that backup, migration or production readiness has passed.
