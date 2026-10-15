# Read-only live inspection: SQLite → PG/R2

Observed 2026-10-08 using `infi-jorhor-dev2`, namespace `anythingllm`.
Only metadata/schema/filesystem inventory queries and TCP positive control ran.
No credential values, application rows, resource mutations, backup or migration.

## Verified live state

- App 1/1, pod 2/2, no restarts; PG 1/1, no restarts.
- App image digest: `fbb74c5b8a58878f700b5f9150d28e3f02eb777b6731857e521a2548444007b1`.
  Deployment change-cause still claims `f43be3da`; that annotation is stale and
  cannot establish source provenance.
- Live app uses SQLite, Node 18.20.8, Prisma 5.3.1.
- Live schema SHA-256 `202594a3ddc39e4ba6cc8a84a548089734241db9ad585b1cabed3dc99ef14a8a`:
  40 models, 46 finished migrations, no rolled-back entries. Two additional
  existing tables: `personal_mcp_grants`, `personal_mcp_contexts`.
- Live schema and two migration checksums match the existing personal-MCP
  worktree. Its feature code is NOT being imported into this migration checkout;
  preserve existing tables/data through a separately recorded schema extension.
  Live invocation code hash also differs from both old baseline and current
  personal-MCP worktree: current deployed artifact must be used as the patch base.
- SQLite main file approximately 81 MB; storage inventory approximately 302 MB,
  8,472 files and 9 internal symlinks, all under `.npm-bridge` sidecar npm cache.
  Do not silently exclude storage links: review cache exclusion or safe link
  preservation before actual capture.
- App PVC and PG PVC both Bound, 20 GiB SSD. PG PV Retain; app PV **Delete**.
  Do not delete app PVC/PV or change policies without explicit approval.
- PostgreSQL 17.11, TLS on, max_connections 50; public application tables empty.
  Migrator/runtime neither superuser nor createdb/createrole.
- R2 Secret reference exists: `anythingllm-r2-backup-temporary`. Validity and key
  contents NOT inspected. App encryption references `anythingllm-env`.
- No namespace Jobs/CronJobs/HPA; app includes storage-writing `mcp-bridge` sidecar.
- Existing NetworkPolicy allows same-namespace app/maintenance selectors. Historical
  non-enforcement is still unproven today; allowed-app TCP reached PG Service.
  No unauthorized-client test or privileged filter change performed.
- kube-system DaemonSets list kube-proxy and EBS CSI; this does not by itself prove
  presence/absence of VKE's network-policy implementation.
- Subsequent cluster-wide **pod metadata only** identifies Flannel v0.28.5 in
  `kube-flannel`. No separate policy-enforcement workload was identified in that
  inventory. This is consistent with historical non-enforcement, not a substitute
  for denied-client TCP tests or proof about managed VKE components. No other
  application's containers, credentials or data were inspected.

## Concrete remaining blockers

1. Reconcile migration contract and tests to all **40 live tables**, preserving
   existing personal-MCP behavior by patching the actual live artifact, not rolling
   back to `f43be3da` or copying another worktree's uncommitted feature changes.
2. Resolve/present PG-specific enforcement after verifying real topology. Do not
   infer TCP isolation from TLS or create unauthorized test pods/changes.
3. Safely plan storage-cache links, writer freeze and protected effective keys;
   actual R2 synthetic probe requires mounting existing credentials, not dumping
   them. Read-only inspection has not authorized those mutations/data operations.
4. Fresh review, build/rehearsal on reconciled artifact, then actual cutover gate.

## Local reconciliation evidence

The preservation extension now has 40 PG models, with separate copied source
provenance SQL outside the default SQLite migration history. Scoped local Node
checks **19/19** (including real PG/independent recovered import) and Python
**34/34** passed. A current-live-digest local overlay is being built; the existing
live invocation feature code is inherited unchanged. No image push/deployment.

The current-live-digest overlay built successfully. Its first smoke failed before
app testing because the disposable PG fixture accepted a connection during the
image's temporary initdb server, which then intentionally shut down. Readiness
now explicitly waits for final PID 1 PostgreSQL before connecting; corrected smoke
is running, not yet claimed passed. No live app/PG resource changed.

Corrected smoke **passed** on `anythingllm-pg-migration:current-live-fixture`:
40-table migration/import/independent restore plus strict TLS, actual app startup,
HTTP login/chat history and deployed-baseline invocation model read. Existing
deployed personal-MCP feature files remain inherited from the live base unchanged;
no external LLM/MCP call is part of this test. Storage internal relative-link
capture/restore now has dedicated tests, with external/absolute/chained/excluded
targets still rejected. Python **37/37** passed. Full reconciled regression runner
is executing; no live backup or cutover has happened.

## Authorized TCP probe result

Two credential-free probe pods ran after explicit user approval. Allowed and
unlabelled denied pods both connected to PG Service and direct pod IP
`10.244.0.212`. Verdict: **UNENFORCED**. No Secret/SQL; probe node `172.16.0.97`.
Ownership-selector query after completion found no remaining probe pods. App/PG
Ready 1/1. No app/PG modification by this probe. PG-only enforcement remains a
blocker; temporary-probe approval does not authorize privileged filtering.

Another deployment changed the app to digest
`8a98ca8a0a73057d1bb7077c72a02034e3bcf07a4de21622b3f5656e8dd98d9f`, pod
`anythingllm-578964bcff-d5g5c`, node `172.16.0.97`. This workflow did not deploy it.
Read-only schema and relevant model/runtime hashes remain identical, 40 models.
Reconcile/rebuild on that latest artifact; do not overwrite concurrent work with
the earlier fixture image. Coordinate a stable window before final capture.
