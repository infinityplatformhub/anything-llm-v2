# Urgent PostgreSQL cutover readiness — 2026-10-08

Status: corrected local rehearsal **PASS**; production cutover awaits the
remaining recovery/freeze/cutover gates. The first authorized maintenance attempt
was aborted because storage capture rejected legitimate PVC setgid directories;
the original SQLite Deployment resumed safely. The operator explicitly accepted
the
internal-network isolation risk on 2026-10-08; the historical isolation finding
below remains valid but is no longer a cutover blocker. The user requested migration before their holiday;
continuation is already authorized and does not require another interview.

## Verified baseline and candidate

- Read-only checks found the live app and PG Ready, without restarts. Deployment
  generation 21 was observed, with one app replica and `Recreate` strategy.
- Live app digest remained
  `8a98ca8a0a73057d1bb7077c72a02034e3bcf07a4de21622b3f5656e8dd98d9f`.
  Rechecked its seven baseline startup/model files against the earlier inspected
  baseline before applying the migration overlay; all were identical.
- The source-manifest comparison found 696 baseline JavaScript/CommonJS files,
  703 candidate files, and no changes outside the migration allowlist. Existing
  deployed personal-MCP feature files are inherited, not replaced from HEAD.
- Built a corrected `linux/amd64` local overlay, matching the node architecture:
  `anythingllm-pg-migration:latest-live-fixture-codex-20261008-corrected`.
  Local image identity:
  `sha256:13223afff08046e5e058f8df0b97c58d8fcc0a0dcecaccb7177bf9981cfa6253`.
  It was subsequently pushed under the same immutable digest; production still
  runs the original SQLite image, not this candidate.
- Both 20 GiB PVCs were Bound. No namespace Jobs/CronJobs/HPA were listed.
  Both the app and `mcp-bridge` mount writable application storage; stopping only
  the HTTP process is not a complete writer freeze. External reconciliation and
  operational writers still require explicit final verification.

## Standards review and corrections

The scoped independent runtime review found two fail-closed gaps:

1. Runtime URL `schema=other` or duplicate schema parameters could disagree with
   the catalog checked in `public`. Preflight now permits only absent schema
   (default public) or exactly one `schema=public`, rejecting alternatives before
   database/application effects. Negative and valid-public tests were added.
2. A SERIAL column could use another table's sequence. Catalog validation now
   checks both its exact reviewed `nextval` default and sequence ownership.
   Real-PG regression first reproduced the missing rejection, then passed after
   correction, including detached ownership and runtime preflight rejection.

Independent correction review found no blocking issue in these changes. The 39
reviewed SERIAL sequence names are unique and fit PostgreSQL's identifier limit.

## Spec review and corrections

The scoped independent preservation review found one high-severity shared-trust
gap: importer and verifier could agree on a corrupted export sequence while
ignoring the original SQLite high-water mark.

The independent original-snapshot reader now supplies `sqlite_sequence` and row
maxima. Import validates these before `setval`; standalone verification compares
source-derived bounds too. Tests reject lowered 17/500 and empty-table/500 bounds,
and jointly corrupted export/target state; valid empty defaults, missing sequence
rows, preserved historical bounds and Int-limit failures are covered.

Synthetic SQLite/mock-PG tests reproduced the failures before correction. The
final real-PG suite passed the new corruption/rollback/sequence-state regressions.
An independent reviewer who did not author this fix found no blocking correction
issue. These scoped reviews do not certify unreviewed code or pending live gates.

## Final corrected verification

```bash
MIGRATION_JEST_PATH="$TMPDIR/opencode/pg-r2-test-tools/node_modules/jest/bin/jest.js" \
MIGRATION_RUNTIME_IMAGE=anythingllm-pg-migration:latest-live-fixture-codex-20261008-corrected \
node scripts/database/test.cjs all
```

- 117 Node tool/fixture tests passed, zero failures/skips, including real PG,
  independent recovered import, strict TLS, ledger privileges and actual app
  startup/login/chat-history/agent-model smoke on the latest-baseline overlay.
  External LLM/MCP integrations were blocked; live integration success is not
  claimed.
- 37 Python tests passed; 95 tracked server suites / 1,469 regressions passed;
  four client-selection tests passed.
- 18 infrastructure/probe unit tests passed separately. Scoped Prettier,
  Python syntax and `git diff --check` passed.
- After completed runs, no running Docker containers with the migration fixture
  label remained. Retained unrelated containers/files were not cleaned.
- Protected local logs are under `$TMPDIR/opencode/`:
  `pg-r2-corrected-build-20261008-XXXXXX.log` and
  `pg-r2-deadline-final-20261008-XXXXXX.log`.

## Remaining live gates — do not waive for the deadline

1. **PG network isolation — operator risk accepted:** the prior TCP probe was
   UNENFORCED. On 2026-10-08 the user explicitly accepted this risk because the
   deployment is internal and requested continuation. No enforcement claim or
   network changes follow from this waiver. Keep ClusterIP-only exposure, TLS
   and least privilege; no cluster-wide CNI change is authorized.
2. **Real application recovery:** the explicitly authorized actual-R2 synthetic
   probe passed (see `docs/runbooks/2026-10-08-r2-live-synthetic-probe.md`), including
   download/decrypt, independent-process restore and conditional 412 protection.
   Maintenance-v1 tooling and independently retained archive/effective
   application keys were prepared. Rebuild maintenance-v2 with the setgid fix
   and pass the Linux capture/restore smoke. Synthetic
   transport/recovery success is not an independently recoverable app-data backup.
3. **Final baseline/freeze/rehearsal:** reconcile any subsequent deployment
   drift, inventory all writers/reconciliation, establish a maintenance window,
   freeze them and capture one immutable DB+storage set. Publish encrypted R2
   backup, independently download/restore and verify before migration.
4. **Authorized cutover:** migrator-only schema/import from that
   same snapshot, complete preservation verification, runtime-only startup and
   controlled live workflows before reopening traffic.

The earlier local verification preceded the live attempt. That attempt stopped
all application writers, captured SQLite, failed before full storage capture and
resumed SQLite without production PG writes or a real R2 backup publication.
Retain original SQLite/storage and operation evidence. After PG writes
or storage mutation, a simple SQLite switchback is unsafe. This one-time backup
does not protect subsequent PG writes.

Subsequent operator-authorized continuation: live readiness/source digest was
reconfirmed, and a separate local maintenance image passed ten synthetic
capture/export/restore and packaging checks across 40 models, using UID 1000,
no network and a read-only root filesystem. See the operator runbook's
continuation evidence for image identity and repeatable commands. Production
image delivery and independent key custody subsequently completed.
Actual complete app-data capture/recovery/import and cutover remain pending.
The latest sandbox denies Docker/Kubernetes access; see the runbook's
2026-10-09 storage-correction section for test limits and the exact resume gates.
