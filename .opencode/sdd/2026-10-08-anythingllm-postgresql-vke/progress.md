# SDD ledger — plan: docs/plans/2026-10-08-anythingllm-postgresql-vke.md

User approved design, native plan and provisioning on 2026-10-08. Baseline 8e2215fb;
live application remains Step 3, f43be3da. Agent-close image not deployed.
Pre-flight: Task 1 resource/Secret/DNS identities consumed by Task 2 and README; consistent.
Ruling: work in current repository under previously approved native/master workflow;
only PG files/design/plan are staged; unrelated untracked content untouched.
Ruling: bootstrap CA signing key exists only in protected temporary storage and is
discarded after certificate generation; renewal needs a planned CA/certificate rotation.
Cost if wrong: certificate maintenance outage; document before migration.
Task 1: in progress — safety tests before implementation, then live server-side dry-run.
Task 1: complete (local tests 7/7 green; server-side dry-run passes; live
PG_PROVISION_READY, dedicated PVC bound and PV Retain). No app mutation.
Task 2: in progress — local verifier safety tests 11/11 green; live verify launched.
Final review dispatch attempted, unavailable (Subagent session not found); direct review only.
Task 2: first live verifier passed DB/TLS/role/persistence/restore, fixtures removed.
NetworkPolicy UNENFORCED: unauthorized client reaches TCP 5432. MigrationReady=false.
Ruling: do not change cluster-wide CNI/network policy enforcement without a separate
approved task; keep empty internal TLS/password DB and report migration blocked.
Cost if wrong: other cluster workloads can reach authentication boundary; no real data yet.
Direct review: strengthen wrong-CA test to use valid unrelated system roots; ensure
DNS positive control for denied client; cleanup failure must prevent successful exit.
Final live verification launched with these checks; expected provisioning-only result.
Task 2: Ruling: pinned official PG image has no system CA bundle; generate a valid
unrelated probe CA in maintenance emptyDir instead. Cost if wrong: false TLS-negative result;
live positive verify-full and wrong-CA/hostname/plaintext/password rejection all passed.
Task 2: complete — final live verify exit 0, version 17.11, synthetic data removed,
restart persistence + logical restore passed. NetworkPolicy warning retained; no backup/cutover.
Task 3: operator README completed, provision rerun dry-run passed preserving Secrets.
Local tests 13/13; tracked app suite 95/95 (1469 tests); no application files changed.
Final review: self-review (dispatch unavailable); no independent-review claim.
Task 3: complete (commit a17d40f3 pushed; all required provisioning tests pass;
app unchanged/online, maintenance clients zero, no migrated data). Network-policy
isolation and off-cluster backup remain explicit migration blockers.
