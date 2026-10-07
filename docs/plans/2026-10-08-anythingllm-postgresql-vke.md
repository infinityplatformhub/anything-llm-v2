# AnythingLLM PostgreSQL VKE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use @subagent-driven-development (recommended) or @executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision and verify a dedicated, empty PostgreSQL single instance on VKE without changing the live AnythingLLM application or migrating its data.

**Architecture:** A dedicated StatefulSet and SSD PVC in the existing namespace, internal Service, TLS and SCRAM, separate admin/migrator/runtime credentials, and a narrowly scoped ingress policy. Synthetic verification uses temporary maintenance clients; storage is retained, and off-cluster backup remains a mandatory gate before real data migration.

**Tech Stack:** Kubernetes/VKE, official PostgreSQL 17 Debian image pinned by digest, existing `ebs-ssd`, kubectl, Python standard library, OpenSSL, psql/pg_dump/pg_restore in the pinned PostgreSQL image.

**Spec:** `docs/specs/2026-10-08-anythingllm-postgresql-vke-design.md`

## Global Constraints

- Namespace `anythingllm`; StatefulSet and ClusterIP Service `anythingllm-postgres`; one replica; TCP 5432.
- New dedicated 20 GiB ReadWriteOnce SSD PVC; never reuse `anythingllm-storage`; new bound PV reclaim policy Retain, without changing the shared StorageClass.
- Requests 250m CPU / 512 MiB RAM; limits 1 CPU / 1 GiB RAM; shared_buffers 128 MiB, max_connections 50; graceful stop 60 seconds.
- No public exposure, app migration, pgvector setup, database-provider switch, or deployment of the separately built agent-finalization image.
- Preserve live application image, pod template, PVC, settings and unrelated local changes; do not inspect or reuse other projects' credentials.
- Distinct random admin/migrator/runtime passwords and TLS private material in Kubernetes Secrets; no credentials in Git, command arguments, logs or evidence.
- No scheduled backup destination provisioned now; no real production data until scheduled off-cluster backups and independent restore are approved and implemented.
- Rollback stops only the new StatefulSet; retain storage and secrets. Never delete PVC/PV as cleanup.

## Review Focus

- Existing names or partially initialized storage: reruns must not rotate passwords or reinitialize data; stop on unfamiliar/partial resources.
- StorageClass Delete policy: verify the new PV becomes Retain before calling provisioning complete; never patch another PV.
- TLS files and certificate names: server must load its key with safe ownership/mode; client must reject wrong hostname/CA and plaintext connection.
- NetworkPolicy unsupported by cluster networking: denied-client connection test must establish enforcement or report the limitation without claiming isolation.
- Verification interrupted: synthetic objects/client pods may be cleaned only within owned scope, never dropping the real database, PVC or other applications' resources.

---

## Files and interfaces

Create under `cloud-deployments/k8/infi-dev2/postgres/`:

- `postgres.yaml`: PVC, ClusterIP Service, configuration/bootstrap ConfigMaps, StatefulSet and ingress NetworkPolicy; Secret references only.
- `provision.py`: guarded preflight, ephemeral credential/certificate generation, Secret creation, apply/readiness and PV protection.
- `verify.py`: TLS/auth/privilege/persistence/logical restore and policy probes; redacted evidence and scoped cleanup.
- `README.md`: commands, rerun/rollback rules, credential handoff without printing passwords, limits and backup-before-migration gate.
- `tests/test_provision.py`: stdlib unittest command-recording kubectl fake; no live cluster access.

CLI interfaces:

`python3 provision.py --kubeconfig <path> --dry-run` performs read-only preflight plus local/server-side validation; exits nonzero on conflicts and never creates resources.

`python3 provision.py --kubeconfig <path> --apply` provisions only the resources listed here after preflight; outputs names/readiness only. Existing fully owned healthy resources can be verified/reconciled without credential rotation; partial or unfamiliar state requires operator investigation.

`python3 verify.py --kubeconfig <path> --evidence <approved-temp-path>` verifies only this instance and returns 0 only for required database/TLS/persistence/restore checks. Network-policy unsupported is an explicit warning/limitation, not a silent pass; do not migrate while access-control assumptions remain unresolved.

### Task 1: Guarded database infrastructure and secure bootstrap

**Files:** Create `postgres.yaml`, `provision.py`, `tests/test_provision.py`.

**Consumes:** approved spec, existing kubeconfig, namespace and `ebs-ssd`.
**Produces:** dedicated ready PG with database `anythingllm`, roles `anythingllm_migrator` and `anythingllm_app`, retained SSD and Service DNS `anythingllm-postgres.anythingllm.svc.cluster.local`.

- [ ] Write failing stdlib tests: `test_dry_run_never_mutates`, `test_existing_unfamiliar_resource_aborts`, `test_partial_secret_state_aborts`, `test_rerun_preserves_passwords`, `test_pv_patch_targets_only_owned_claim`, and `test_no_secrets_in_commands_or_output`.
  Assert no apply/create/patch/delete in dry-run; no Secret replace; no application image/PVC mutation; only discovered dedicated claim's bound PV gets Retain; randomized sensitive sentinel absent from argv/stdout/stderr/evidence.
- [ ] Run `python3 -m unittest discover -s cloud-deployments/k8/infi-dev2/postgres/tests -v`; observe failure before implementation.
- [ ] Inspect registry digest/platform for `postgres:17-bookworm`, container UID/key-loading requirements, kubectl/OpenSSL availability, namespace permissions and name conflicts. Pin immutable digest in manifest; stop if suitable image or TLS tooling unavailable.
- [ ] Implement `provision.py` CLI above with ownership label `app.kubernetes.io/name=anythingllm-postgres`, dedicated PVC `anythingllm-postgres-data`, Secrets `anythingllm-postgres-auth` and `anythingllm-postgres-tls`.
  Credentials may be sent to kubectl via stdin or protected temporary files, never command-line values. Temporary private CA/server files must be restricted and removed in finally blocks. Do not issue renewal/credential rotation on rerun.
- [ ] Configure SCRAM host authentication, reject non-TLS TCP, require TLS on Service connections. Certificate includes short Service name, namespace-qualified name, `.svc`, and `.svc.cluster.local` DNS names. Private key is loaded with PostgreSQL-required permissions via init setup if necessary; no world-readable private-key volume.
- [ ] Bootstrap using mounted environment/Secret material, not interpolated credentials in public ConfigMaps: admin `postgres`; database owner/migrator `anythingllm_migrator`; restricted runtime `anythingllm_app`. Revoke PUBLIC database/schema creation, grant runtime CONNECT/USAGE and future-owner default table/sequence permissions. Execute no AnythingLLM migrations.
- [ ] Add health probes (startup budget at least 10 minutes, readiness 10s interval, liveness budget at least 60s); avoid external Service probes. Persistent PGDATA subdirectory, 60s termination grace, explicit SSD requests/limits and `/dev/shm` memory volume suitable for the resource limit.
- [ ] Policy selects only dedicated PG pod, allows same-namespace `app=anythingllm` and `anythingllm-db-maintenance=true` pods on TCP 5432. Do not select/deny other application pods.
- [ ] Run unit tests green, `python3 -m py_compile provision.py`, server-side dry-run and diff review. Confirm no resource creation has occurred yet.
- [ ] Save live AnythingLLM pod-template/image/storage identity to redacted evidence. Apply new resources, await PVC binding/readiness, patch only its PV to Retain and verify it. On failure stop and report; no destructive automatic cleanup.

### Task 2: Database verification and scoped synthetic restore

**Files:** Create `verify.py`; extend `tests/test_provision.py`.

**Consumes:** Task 1 resource names/DNS/Secret references and ownership label.
**Produces:** redacted evidence, verified empty database, removed synthetic fixture/client objects; no app cutover.

- [ ] Write failing tests: `test_verify_cleanup_is_scoped`, `test_verifier_never_prints_credentials`, `test_missing_backup_destination_blocks_migration_claim`, `test_policy_unsupported_is_reported`.
  Cleanup must never delete PG PVC/Secret/StatefulSet or drop `anythingllm`; errors retain diagnostic state without leaking credentials; unsupported policy cannot be reported as isolation success.
- [ ] Implement `verify.py` with two temporary pinned-image clients: labeled maintenance client and unlabeled denied client, no public ports. Mount only required Secret keys; never dump all environment variables or Secret values.
- [ ] Verify version 17, intended database/owner/roles and no runtime SUPERUSER/CREATEDB/CREATEROLE. Verify runtime cannot CREATE ROLE/CREATE DATABASE or create arbitrary schema objects. Confirm TLS with `sslmode=verify-full`, correct CA/DNS; positive successful connection and negative bad password, bad CA/hostname, non-TLS connection.
- [ ] Create uniquely named synthetic table as migrator, verify permitted runtime SELECT/INSERT/UPDATE/DELETE and transaction rollback. Record known fixture ID/content for persistence/restore comparison.
- [ ] Delete only the labeled PG pod after pre-checking it contains no real application data; wait for StatefulSet pod Ready and retained PVC, then prove synthetic content persists. Do not restart AnythingLLM. Confirm its pod-template/image unchanged and public ping online.
- [ ] Dump fixture database to maintenance-client emptyDir using custom-format pg_dump; create uniquely named temporary restore database as admin, restore and compare fixture count/content. Drop only that temporary DB and original synthetic table; do not drop/recreate `anythingllm`.
- [ ] Probe allowed and denied clients. For denied timeout/unreachable, retain positive control from allowed client to prove PG actually ready. If denied can connect, report policy unenforced; maintain TLS/auth restrictions and mark migration access-control gate unresolved.
- [ ] Run unit tests green, live verifier and scoped cleanup verification; ensure application database is empty after fixture removal and no maintenance pods or credential files remain. Scheduled off-cluster backup and independent loss-of-instance restore remain NOT TESTED/NOT CONFIGURED.

### Task 3: Operator delivery and final gate

**Files:** Create `README.md`; record redacted live evidence in approved OpenCode temp directory.

**Consumes:** verified resource identity/results from Tasks 1–2.
**Produces:** prepared database status and explicit migration prerequisites; no migration authorization.

- [ ] Document exact provision/verify commands, Service DNS, Secret/key names, TLS CA usage, and rollback command scaling only the dedicated StatefulSet to zero; no credential values.
- [ ] Document single-instance outage risk, Retain limitations, additional 20 GiB SSD charges, internal Service versus enforced NetworkPolicy distinction, backup-before-migration gate, and PostgreSQL application DB versus pgvector distinction.
- [ ] Direct review all manifests/scripts and tests; request independent review if the tool works. If unavailable, explicitly report direct review only.
- [ ] Verify final Ready/PVC/PV Retain/service exposure, no restart loop, application unchanged and ping online, fixture cleanup, tests and evidence. Commit only this task's manifests/scripts/tests/design/plan after verification; push only within the approved repository workflow, no application image deployment.
- [ ] Report provisioning complete only if required tests passed. Clearly state no application data migrated, live app still SQLite, no automatic off-cluster backup yet, and any network-policy limitation. Request separate migration approval after backup/security prerequisites are settled.

## Execution approval

Design approved by user. This plan requires review/approval before resource creation.
Recommend native execution in this session because tasks share live resource identity
and sensitive bootstrap state, and previous subagent dispatch is unavailable.
