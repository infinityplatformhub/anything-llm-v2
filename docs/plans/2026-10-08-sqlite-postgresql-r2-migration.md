# SQLite → PostgreSQL and one preserved R2 backup — implementation plan

Date: 2026-10-08
Status: Written plan approved by the user in this OpenCode session; T1 local implementation started. Production remains separately gated.
Approved design: `docs/specs/2026-10-08-sqlite-postgresql-r2-migration-design.md`.
Execution method already chosen: supervised OpenCode workers, independent reviewer, correction loop.
Baseline: `a17d40f31eb6d8a4d28a40f9297aa38d9c831ff2`.

## Scope and gates

Preserve one consistent SQLite **DB + application storage** recovery set in private R2 `anything-llm-backup`, verify independent recovery, and migrate the same immutable snapshot to the dedicated PG instance. Preserve SQLite defaults/tests and source artifacts. No recurring backups, retention/deletion, RPO/RTO policy, HA/PITR, pgvector, cluster-wide CNI changes, MCP features or unrelated agent release.

The user has approved the architecture, this concrete plan and execution method. Production inspection, data access/upload, infrastructure changes and cutover remain separately gated; local fixture success is not production success. No credentials or production rows in evidence.

Protect existing untracked `.claude/`, `.opencode/`, test fixtures and PNGs. Workers receive explicit file allowlists; no broad cleaning/staging, force/reset/truncate, target reuse after uncertain imports or automatic deletion of originals/backups.

## Findings incorporated before implementation

1. Existing PG default privileges grant runtime DML on future migrator-owned tables. Explicit migration work must revoke runtime writes to `_prisma_migrations`, preserving read access only for preflight if needed. Disposable tests must prove ledger DML/DDL is denied while application CRUD and sequence allocation work.
2. Recover archive encryption material separately from the **effective application `SIG_KEY`/`SIG_SALT` pair**. PVC `.env` is not sufficient evidence when deployment Secrets supply the effective values. Independently recover/inject that original pair and test representative settings decrypt without exposing values or external calls. Do not create a new secrets platform.

## Task sequence and contracts

### T1 — Pure provider configuration (first implementation task)

Files only:
- New `server/utils/prisma/configuration.js`.
- New `scripts/database/tests/configuration.test.cjs`.

Write failing tests first: absent provider preserves existing SQLite; explicit SQLite file URL works; ambient `DATABASE_URL` is ignored; PG requires explicit provider/PG URL; unknown provider, wrong scheme, artifact/provider mismatch and missing PG configuration fail closed; errors never include a synthetic password or credential-bearing URL.

Implement a pure validator accepting explicit configuration/artifact metadata. No dotenv, database, runtime singleton, Docker or startup changes in this task.

Red and green commands:
```bash
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath scripts/database/tests/configuration.test.cjs
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath server/__tests__/utils/prisma/prismaDatasource.test.js
```

Independent review and correction precede integration. Gate: only the two allowed files change and existing datasource behavior passes.

### T2 — Separate PG schema/client and disposable PG harness

Depends on T1. Files: `server/prisma/postgresql/schema.prisma`, independent PG migration directory/lock; `scripts/database/schema-contract.cjs`, `test.cjs`, tests/helpers/owned Compose fixture; narrow PG package scripts and generated-client ignore rule.

Copy complete fork model definitions, changing datasource/generator and only necessary provider representations. Never copy upstream schema wholesale. Isolate generated PG client under `server/generated/prisma-postgresql/`; preserve SQLite client/history.

Test logical and physical parity: all fields/maps/nullability/defaults/IDs, constraints/indexes/FK actions, fork models, timestamps and separate migration provenance. Use metadata plus real catalogs, not DMMF alone. Generate initial PG DDL through installed Prisma 5.3.1, review it, and ensure ledger privilege restrictions execute under the explicit migrator task.

```bash
server/node_modules/.bin/prisma validate --schema server/prisma/postgresql/schema.prisma
server/node_modules/.bin/prisma migrate diff --from-empty --to-schema-datamodel server/prisma/postgresql/schema.prisma --script
server/node_modules/.bin/prisma generate --schema server/prisma/postgresql/schema.prisma
node scripts/database/test.cjs schema
node scripts/database/test.cjs sqlite
```

Harness uses synthetic data/secrets, uniquely owned containers and temporary directories, loopback-only targets and a reviewed pinned PG image. Missing real-PG execution fails rather than silently skipping. Clean only explicitly owned fixtures; do not load developer `.env` or collect protected untracked tests.

### T3 — Provider-aware runtime and migration-free PG artifact

Depends on T2. Files: `server/utils/prisma/{client.js,index.js,preflight.js}`, narrow `server/index.js`, Docker build/entrypoint and runtime tests. Serialize shared package changes.

Preserve singleton interface and `ANYTHINGLLM_DATABASE_URL` override. Select matching client and `Prisma` namespace. Generate PG client at build time and bind provider/schema identity. PG startup runs neither generate nor migrate and cannot fall back to SQLite. Read-only PG preflight runs before app, collector, listeners or background effects; reject wrong role, schema or ledger.

Test actual Prisma CA/hostname validation using synthetic TLS, runtime CRUD/sequence allocation and denied DDL/ledger writes. Preserve existing SQLite startup. Review any required dependency change separately, not as an automatic upgrade.

```bash
node scripts/database/test.cjs runtime
node scripts/database/test.cjs postgres
node scripts/database/test.cjs sqlite
bash -n docker/docker-entrypoint.sh
```

### T4 — Reproduced PG compatibility fixes only

Depends on T2/T3. Files: `server/models/passwordRecovery.js`, `scheduledJobRun.js` and provider tests; direct `Prisma` namespace imports only where tests demonstrate mismatch.

Reproduce raw identifier/concurrency failures before fixes. PG recovery issuance locks its user row within the transaction before checking/issuing codes; scheduled claims lock the parent job row. Retain SQLite paths and established outputs. Test overlapping transactions with separate clients, exactly-one-winner behavior, rollback, unrelated-job concurrency and generated-client error handling. Audit other raw SQL; do not refactor unrelated code.

```bash
node scripts/database/test.cjs provider
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath server/__tests__/utils/passwordRecoveryAtomic.test.js
node scripts/database/test.cjs sqlite
```

### T5 — Immutable snapshot/storage capture and typed contract

Depends on T2. Files: `scripts/database/snapshot.py`, source contract and snapshot tests. Python stdlib SQLite backup captures committed WAL state; integrity/FK checks and full schema/storage inventory precede export.

Production capture requires verified DB/file writer freeze and restart prevention. Capture storage at the same boundary, preserve original DB/files, identify authoritative snapshot versus live DB/WAL/SHM copies, reject unsafe destinations/escaping symlinks. Preserve hidden/configuration files only through protected payload handling. Inventory external vector dependencies without claiming them included.

Tagged bounded export distinguishes null/empty/false/zero, preserves integers without JS precision loss, explicit timestamp precision, UTF-8/JSON/ciphertext exactness and SQLite sequence high-water marks. Reject unsupported columns/types/values rather than coercing/skipping. Bind snapshot SHA-256, source history and mapping version.

```bash
node scripts/database/test.cjs snapshot
node scripts/database/test.cjs schema
```

### T6 — Guarded parameterized PG import

Depends on T5. Files: `scripts/database/import.cjs` and tests. Credentials via protected references, never CLI URLs. Bind exact source hash/mapping and target identity; require approved empty target/exact baseline, exclusive importer and no app writers. Lock before checking emptiness.

FK-ordered bounded inserts within one transaction, constraints enabled, explicit preserved values/IDs, no app model helpers. PG migration ledger stays separate. Restore sequence bounds from maxima and SQLite historical high-water marks, including empty/deleted-high-ID cases. Uncertain commit/interruption or sequence failure quarantines the target: FAILED/UNKNOWN, never auto-retry/append/reset.

Tests: wrong/dirty target, duplicate importer, wrong hash/schema, competing writer, invalid values/FKs, mid-import failure, interruption, sequences. Unsupported cycles/capacity require review before production.

```bash
node scripts/database/test.cjs import
node scripts/database/test.cjs postgres
```

### T7 — Independent preservation verifier

Depends on T6. Files: `scripts/database/verify.cjs` and tests. Read original snapshot independently; compare every table's full key sets/counts, all-column typed digests, constraints/relationships/indexes and sequence state. Use explicit unambiguous canonical encoding and hand-authored expected fixtures to detect shared mapping mistakes.

Mutate fixtures to prove detection of timestamps/nulls/Booleans/JSON formatting/ciphertext/maps/relations and schema/sequence mismatch. Production verification does not allocate IDs or write probe rows. Any mismatch blocks startup. Evidence is protected aggregates, not row diffs.

```bash
node scripts/database/test.cjs verify
node scripts/database/test.cjs import
```

### T8 — Protected recovery set and narrow R2 transport

Depends on T5; independent of T6/T7 after contract review. Files: `scripts/database/{recovery-set.cjs,r2.cjs}` and tests. Reuse standard crypto/current dependencies; no custom S3 signing. AWS CLI is absent: select a reviewed pinned S3-compatible maintenance tool or narrowly reviewed SDK dependency before implementing actual transport. No installation during planning.

Synthetic tests use disk-backed transport and cannot claim R2 compatibility. Versioned authenticated encryption; separate independently recoverable backup key and effective application key pair. Never upload plaintext secrets or rely solely on PVC `.env` for recovery keys.

Unique prefix, closed/hash-bound payloads → encrypt/upload → download/hash/decrypt verification → protected manifest upload/download verification → completion marker last. No deletion API, lifecycle edits, overwriting unfamiliar objects or automatic partial cleanup. Restore validates complete sets/authentication/hashes and safe paths before exposing content.

Tests: wrong/missing key, corrupt/truncated data, partial uploads, failed downloads, existing prefix, archive traversal and credential leak sentinels.

```bash
node scripts/database/test.cjs recovery
```

### T9 — Independent synthetic recovery/rehearsal

Depends on T3/T4/T6/T7/T8. Restore downloaded full-schema fixture into separate directories and separate disposable PG instance/volume, without original fixture access. Verify files, SQLite, effective application keys/decryption, import and full preservation. Block/mock Lark/MCP/LLM/webhooks/background effects; do not add a production restore-mode feature.

Test login/recovery, chat/workspace/agent persistence and required fork CRUD, restart without migrations and fail-before-effects. Run tracked-only SQLite regressions and check-only formatting/lint; existing fix-mode lint must not rewrite unrelated files.

```bash
node scripts/database/test.cjs restore
node scripts/database/test.cjs all
python3 -m unittest discover -s cloud-deployments/k8/infi-dev2/postgres/tests -v
```

### T10 — Baseline and PG isolation gate

Read-only local feasibility may proceed after plan approval; production access requires specific authorization. Verify deployed image/source, schema/storage, Secret references/key names and all writers without printing values. Historical app baseline `f43be3da` differs from repository HEAD by unrelated agent-finalization code: assemble and prove a migration-only candidate on the verified deployed baseline.

Document PG-specific isolation feasibility and a non-destructive verifier. No cluster-wide CNI changes or live remedy without review/approval. Collect allowed positive controls and unauthorized TCP denial for both Service/direct pod, with DNS, restart/address-change and bypass checks. TLS/authentication is not TCP isolation. If no safe PG-only remedy works, stop production migration; do not silently waive the gate.

Do not run existing restart/dump provisioning verifier on populated production PG. New operator templates/verifiers must be tested to deny Secret dumps, arbitrary exec, scaling/restarts or PVC mutation outside their explicit task.

### T11 — Readiness package and actual cutover runbook

Depends on T9/T10 and independent review. Files: new scoped runbook, inert explicit maintenance Job templates, safe migration verifier/tests, narrow README clarification; prepare but do not apply application deployment patch.

Separate runtime, migrator/import and backup credentials. No runtime migrations/initContainers or admin/migrator/R2 credentials in app. Disable automatic import retry after ambiguous commit. Record safely discovered references, exact artifact/schema/snapshot/target identities, writer freeze and abort commands, measured capacity/timing and independently recoverable key custody.

Independent review must verify test evidence, scope, role/TLS/network boundaries and destructive-action safety. Resolve findings and present **actual production go/no-go**; local green tests do not authorize deployment.

### T12 — Approved production execution

Only after T11 and explicit production approval:
1. Reconfirm all identities/gates; stop on drift.
2. Freeze all DB/file writers and prevent automatic restart, including storage-writing sidecars.
3. Capture final consistent snapshot/storage once; preserve originals.
4. Publish/download/verify protected R2 set, marker last.
5. Independently restore and validate actual recovery material/keys with outbound effects blocked.
6. Apply approved PG schema through migrator only; confirm fresh target.
7. Import **same** immutable snapshot; quarantine on failure/unknown commit.
8. Fully verify data/schema/sequences before startup.
9. Start approved PG artifact with runtime credentials and original storage/encryption material; explicitly record write/mutation boundary.
10. Controlled login/chat/agent/file acceptance, prove no duplicate writers or runtime DDL.
11. Explicitly reopen traffic and record evidence; retain SQLite/storage/R2 artifacts.

Before PG writes **and storage mutation**, rollback may restore original SQLite writer only after proving exclusivity/compatibility. After either boundary, freeze and prefer repair-forward; reverse migration/reconciliation/data-loss decisions need explicit approval. Startup itself can cross that boundary. No post-write simple switchback or continuous-backup claim.

## Supervision protocol and completion evidence

Per task: exact file allowlist → red tests → minimal implementation → green/regressions → independent read-only review → correction/rerun. Parent serializes shared schema/package/harness changes. T4 and T8 can run independently only after prerequisites. No unresolved correctness/security findings integrated; no self-review labelled independent.

Start new OpenCode workers with only `agent`, `description`, `prompt`, optional `background`. Omit `sessionID`/`model`; continue only exact IDs returned by successful subagent calls. If the interface requires optional fields, report/investigate the schema defect instead of fabricating values or using unrelated API IDs as a workaround.

Local completion requires reproducible fixture/tests/reviews. Production completion additionally requires actual consistent R2 recovery, independently recovered keys/data, full PG preservation, approved artifact/app workflows, role/TLS/isolation proof and approved cutover. Never imply unperformed operations passed.

## Outstanding gates, not extra features

- R2 transport choice and safe existing Secret reference/validity.
- Protected custody for archive key and effective application key pair.
- Verified deployed baseline and migration-only artifact.
- Enforced PG-specific isolation; no broad network change.
- Real source schema/values, writer inventory and transaction/storage capacity.

No schedule/retention/RPO/RTO questions remain in this plan.

## T1 execution checkpoint

Native worker creation is blocked: attempted calls incorrectly included a nonexistent `ses_new`. The user rejected that creation method. No further native/API worker creation is being used; T1 was implemented directly by the parent, not by a worker, and **independent code review is outstanding**. This is a workflow deviation, not a completed feedback-loop claim.

The root Jest installation is absent. The planned Jest command failed with MODULE_NOT_FOUND, and `npm test -- --runInBand` failed with `jest: command not found`. Without installing dependencies or altering existing tests, the T1 test supports both Jest and Node's built-in runner. `node --test scripts/database/tests/configuration.test.cjs` first failed all 30 cases with the implementation absent, then passed all 30 after implementation. Scoped Prettier check passed. The existing datasource/Jest regression suite has not run; T1 is not cleared for integration or T2 until that verification and review limitation is resolved.

Only the pure validator and its tests were added for product code. The runtime singleton, actual datasource, Docker, production resources and data were not changed.

## T1/T2 local verification update

The user authorized continued direct work without the rejected worker-creation method. Independent review remains unavailable and is not claimed. The regression blocker was resolved by installing **Jest 29.7.0 only in the approved temporary tools directory**. Root `yarn install --frozen-lockfile --ignore-scripts` rejected the existing lock mismatch; no lock/package upgrade was made to repair it.

- T1 passes all 30 tests under Node and Jest (Jest needs explicit `--testMatch '**/configuration.test.cjs'` because its default match excludes `.cjs`). Existing datasource regression passes 3/3.
- All **95 tracked non-E2E server suites / 1,469 tests** passed using temporary Jest and an explicit tracked-file list. Protected untracked test fixtures were excluded; E2E was not run. The root default test command still lacks a local Jest installation.
- Added derived PG schema/history/client output and explicit maintenance scripts. Seven derivation/parity tests pass; checked-in schema matches every original model/attribute except documented native timestamps. SQLite schema/history are unchanged.
- A Docker fixture using the existing pinned PG image passes real `prisma migrate deploy` twice (second run is a no-op), live schema diff, all 38 model/physical-column/type/nullability checks, runtime application CRUD/FK cascade, generated PG-client reads and ledger DML/DDL denial. PG client generated separately with Prisma 5.3.1; no SQLite client overwrite.
- Combined local T1/T2 suite: **38/38 passed**. This is schema/provider preparation, not completed T2 implementation, data migration or production readiness. Full physical source/default/index reconciliation, reusable source contract/harness, independent review and later tasks remain.

The installed SQLite generated client is locally stale (37 models; missing `workspace_mcp_servers` compared with the checked-in 38-model schema). It was not silently regenerated or used as the authoritative schema. Production-baseline reconciliation and later SQLite generation/verification must account for this before any data import.

No runtime singleton, Docker entrypoint, deployment, production resource, existing SQLite database or R2 object was changed. No native/API subagent creation was attempted during this direct-work update.

## T3 runtime preparation checkpoint

Continued directly after the user's instruction, without further worker creation or production access. Added provider/artifact-bound client selection, immutable schema/migration-checksum metadata generation, read-only PG preflight and startup gating. The checked-in artifact stays SQLite; PG selection requires the explicit PG build and runtime configuration. Docker PG startup performs no generate/migrate and gates both server and collector first.

The original application initialization moved unchanged to `server/app.js`, with `server/index.js` as the dotenv/bootstrap gate. One existing browser-socket test read the old source location; its path was updated to the actual app file after the full regression run reported **94 suites/1,468 tests passed, one failed**. A fresh full run is pending at this checkpoint; the failure is not concealed.

Runtime tests: client-selection Jest **4/4**; serial Node suite **52/52**, including real PG readiness success and rejection of schema drift, ledger write privileges and missing sequence access, actual bootstrap ordering, and Linux entrypoint execution with isolated fake process boundaries. A concurrent Docker test run encountered a connection termination; isolated and then serial runs passed. Use `--test-concurrency=1` for these resource-intensive fixtures, not automatic production retries.

Still outstanding: actual Prisma TLS hostname/CA fixture verification, complete constraint/index/default drift checks, full Docker image build/application smoke, provider concurrency fixes, data tools, R2 recovery and production isolation/cutover. Current checks are not proof of production readiness. Independent review remains outstanding.

## T3/T4 verification update

Fresh tracked regression run after the bootstrap test-path correction passed **95 suites / 1,469 tests**. Real PG compatibility tests then reproduced the recovery insert failure (`42703`, unquoted `createdAt`) and duplicate scheduled claims (two rows instead of one). Added PG-only parent-row transactional locks while preserving SQLite branches. Real PG tests now verify recovery atomic rollback, one winning code set, seen/missing-user behavior, two job callers observably blocked in `pg_stat_activity`, unrelated-job concurrency and terminal-run re-claim behavior.

The two separately generated clients expose distinct `PrismaClientKnownRequestError` classes; a PG error fails `instanceof` against the SQLite namespace. The three model imports using that check now use the selected client namespace. Fresh full regressions after these model changes passed **95 suites / 1,469 tests**. The real PG fixture passed recovery/scheduler checks. Scoped server ESLint passed.

## T5 snapshot primitive started

Added a read-only-source, WAL-aware SQLite backup primitive with exclusive 0600 destination creation, integrity/FK checks, bounded timeout and SHA-256. Nine synthetic tests pass: committed WAL inclusion, uncommitted exclusion, original preservation, deleted high-ID sequence retention, no overwrite, no missing-source creation, direct symlink/source-target rejection, corrupt DB and FK failure.

This primitive is not a production capture command: DB/files writer-freeze verification, storage capture, path-hardening/identity checks, typed export and recovery-set publication are unfinished. No production data was read or copied. Failed snapshots remain incomplete, never reported as a valid recovery set.

## T5–T9 local implementation progress

Continued without asking for repeated approval. Added the versioned physical mapping/FK ordering, typed immutable SQLite export, guarded parameterized PG importer, complete-row preservation comparison, storage archive capture/restore, authenticated encrypted payloads, completion-last publication/recovery protocol and a narrowly scoped pinned AWS-CLI R2 adapter (upload/download/list only, conditional no-overwrite PUT, no delete API). Actual R2 access has not run: adapter tests exercise controlled transport/process boundaries only.

Synthetic integrated rehearsal now uses all 44 existing SQLite migrations and populates **all 38 tables**, then captures DB/storage, encrypts and publishes to a disk/in-memory test transport, independently downloads/restores files and SQLite, exports recovered data, imports into disposable PG, compares all values and checks deleted-high-ID sequences. Wrong hashes/targets, dirty-target retry, FK rollback and intentional data corruption are rejected. This does not yet satisfy independent disaster-recovery-on-another-PG-instance or full app login/chat/agent smoke.

Prisma 5.3.1 actual TLS fixture passed with a valid CA/hostname and rejects wrong CA and hostname under `sslaccept=strict`; initial synthetic leaf certificate lacked required extensions and failed trust until fixed. No permissive TLS fallback was used. Synthetic certificates/keys were fixture-only and deleted with their owned temporary directory.

Latest completed checks before this checkpoint: serial Node **70/70**, Python snapshot/export/storage **27/27**, integrated real PG after expanded all-table fixture and TLS passed. Added `node scripts/database/test.cjs <group>` with explicit tracked regressions and serial Docker fixtures; full consolidated run still pending. Root Jest remains unchanged; `MIGRATION_JEST_PATH` can reference temporary pinned Jest. The runner fails rather than skipping unavailable dependencies.

Remaining safety work: direct-original-snapshot independent verifier (current verifier reads the recovered export, so cannot detect shared export mapping bugs alone), complete schema constraint/index/default reconciliation, mutation/quarantine state persistence, operational CLI/freeze evidence, protected effective SIG key recovery drill, independent target restore and full application smoke, production-capable tooling/image, actual R2 probe and PG isolation remedy/baseline verification. No production backup, secret read, resource mutation or cutover has occurred. Independent reviewer still unavailable; no review completion claimed.

## Continued local hardening and integration

Subsequent work added independent original-SQLite comparison before commit and during verification; tests corrupt both export and target identically and prove this comparator catches the shared bug. Added persistent import-state markers that prevent automatic retry after failed writes/uncertain commit, independent recovery/import into a **second isolated PG instance/storage**, recovered effective application-key decryption using the real EncryptionManager algorithm with unrelated environment persistence blocked, and explicit protected-request CLI/offline capture/export/restore commands.

Runtime/target catalog validation now checks primary keys, declared indexes, FK actions and column defaults in addition to columns/types/nullability/ledger. Deliberate index drop, default change and FK drop are rejected. Runtime PG additionally requires explicit `sslmode=require`, `sslaccept=strict`, an absolute CA path and the preserved effective SIG key pair; wrong/missing CA/hostname and permissive URL settings fail. These checks are local fixture proof, not live-network enforcement.

Consolidated runner completed with **74 Node + 27 Python tests, 95 tracked suites/1,469 regressions, and 4 client-selection tests passing** before the latest TLS/key/empty-payload hardening. Earlier consolidated run had one timing-sensitive `bootWebSockets` stderr assertion fail; isolated rerun passed 6/6 and the subsequent full run passed. Do not omit that historical failure. Fresh consolidated verification after latest hardening is pending.

Added the operator runbook and read-only PG-isolation feasibility assessment. No live Kubernetes/R2 access or additional authorization was inferred. A PG-specific network remedy requires reviewed scoped infrastructure changes; no reliable remedy has been proven yet. Full app/image smoke and independent code review remain outstanding.

## Latest execution evidence and remaining live gates

Local tools now have protected-request CLI commands, strict maintenance connection CA/hostname and exact host/port/role/database binding, full SQLite source catalog comparison against all 44 migrations, persistent quarantine markers, zero-byte encrypted payload handling, PG startup preserved-key enforcement and strict TLS URL checks. Tests intentionally corrupt export and PG identically and verify original-source comparison still rejects them. Source catalog drift tests reject index drops, unknown columns and unexpected views/triggers. Python **32/32** and real integrated PG checks passed individually.

The last all-runner attempt failed on a disposable PG connection termination before regressions; no passing consolidated claim is made for it. Added synthetic container state/log diagnostics and readiness SELECT to distinguish initialization/restart failures from migration bugs. An individual real-PG run after that check passed. Earlier passing consolidated run remains 74 Node / 27 Python / 1,469 tracked regressions / 4 client-selection checks, not evidence for latest unrun modifications.

Migration-only fixture image assembly uses the locally available historical `step3-f43be3da` base and an explicit allowlist, excluding the parked workspaceAgentInvocation change. Its original amd64-on-arm64 Prisma build failed with emulation exit 133. A fixture-only workaround is being tested: generate PG client with existing host Prisma 5.3.1 and use the exact Linux engine extracted from that same baseline image. This is not a production native-build success or deployed-baseline verification. No images were pushed or deployed.

Remaining blocking live gates: independent code review, full app/runtime smoke and production-capable native build/tooling, verified live baseline/Secret references, actual authorized R2 probe/upload, reviewed PG-only network enforcement, freeze/capacity/readiness evidence and explicit cutover go/no-go. These are the only points requiring human action when local preparation reaches them; no repeated approval of completed plan stages is needed.

## Runtime image / environment diagnostics

The migration-only local overlay image built successfully after the fixture-only engine workaround, with an explicit file manifest excluding unrelated invocation code. App smoke first failed because Docker's predefined address pools were exhausted. No existing networks were pruned/deleted; a fixture-only internal subnet was selected after checking overlap. Runtime smoke is running again using that owned network and synthetic DB/users/config only. It is not yet a success claim or production artifact.

Source catalog tests additionally caught over-normalization of string defaults (case changes had been ignored); the normalizer now preserves SQL string literals and the new failure test passes. Latest source-catalog suite **6/6**. No production or R2 operations occurred while these local diagnostics ran.

App smoke progressed through startup, actual HTTP login and persisted chat history on PG in the internal Docker network. Its final agent-model check initially failed because `docker exec` inherited `/app`, outside server dependency resolution; corrected fixture workdir to `/app/server` and rerunning. Those earlier partial checks do not count as full smoke success. Outbound model-map/pricing requests were blocked as intended; no live integrations were reached. Synthetic startup log showed an oversized default Prisma pool, so the runtime contract now requires explicit `connection_limit` below provisioned max 50 and fixtures choose 5; deployment must budget aggregate pools across writers.

The subsequent explicit runtime-image smoke **passed**: startup with PG, real HTTP password login, persisted chat-history read and baseline agent-invocation model read in the internal network. It exercises existing persisted agent behavior, not a real LLM/MCP invocation. The fixture overlay does not include the latest post-build TLS/pool/catalog hardening; rebuilding/native production artifact verification remains necessary. The latest full code test runner is currently running; no new consolidated totals asserted until completion. Scoped server ESLint and `git diff --check` passed.

Implementation is sufficiently advanced to identify the real production blocker rather than ask for plan approval again: historical PG TCP isolation is unproven and live identities/Secret references have not been verified. A scoped read-only operational inspection and a reviewed PG-only enforcement proposal are needed before any real backup/migration/cutover. No authority for production mutation or secret-value retrieval is inferred from local-code approval.

## Authorized read-only cluster inspection and baseline correction

User explicitly authorized live cluster reads. Used the existing `infi-jorhor-dev2` kubeconfig without reading/printing credentials. App/PG pods healthy; both 20 GiB PVCs Bound; PG empty, 17.11/TLS/max 50. Found R2 Secret name `anythingllm-r2-backup-temporary`, no credential values read. App main SQLite about 81 MB, storage about 302 MB; nine internal symlinks under `.npm-bridge` cache. PG PV Retain but app PV Delete: no policy/PVC changes made.

**Live baseline differs from the old annotation and fixture image.** Current digest `fbb74c5b8a58878f700b5f9150d28e3f02eb777b6731857e521a2548444007b1` has 40 models / 46 finished SQLite migrations, including personal-MCP grant/context tables absent from this checkout. Schema/migration hashes match the other personal-MCP worktree, but feature code was not copied. Added PG-only live schema extension, additive PG preservation migration and source-provenance SQL; default SQLite schema/history and other worktree remain untouched. Tests/rehearsal are rerunning for **40** tables; prior 38-table results cannot clear the current live source. New actual-baseline fixture image/rehearsal still needed.

Inspection evidence: `docs/runbooks/2026-10-08-pg-live-inspection.md`. Allowed app TCP reaches PG; existing NetworkPolicy still needs actual denied-client evidence/remedy, not waived. No unauthorized client pods, production writes, backup uploads, secret values, deployment or cutover occurred. Need scoped operational approval only for actual resource/data actions, not repeated plan approval.

Reconciled live-schema local verification completed: **19/19** scoped Node tests including real PG migration/import/independent restore with 40 tables, plus **34/34** Python tests including explicit two-live-migration source catalog checks. App/PG remained Ready 1/1 on final read-only status check. Earlier historical fixture smoke does not prove current live-digest app preservation; candidate must now patch that digest.

Current-live-digest local overlay built. Its first smoke reproduced intermittent fixture connection loss; synthetic PG logs exposed temporary-initdb shutdown, so fixture readiness now waits for PID 1 `postgres` (not merely a successful SELECT during initdb). Corrected smoke running; no current-baseline smoke success asserted yet. This fixes test readiness, not production database behavior or data migration.

Corrected current-live-digest full fixture smoke passed (approximately 115 seconds), preserving 40-table baseline and live invocation code while exercising actual startup/login/chat/agent persistence. Storage recovery now preserves safe internal relative links (created last, never followed during extraction), rejects outside/absolute/chained/excluded targets, and **37 Python tests passed**. No cache silently excluded. Full reconciled all-runner test is running. No production writes, pods/jobs created, Secret values read, backup uploads, deployment or cutover.

Fresh reconciled all-runner completed: **90 Node / 37 Python / 95 tracked suites and 1,469 regressions / 4 client-selection tests passed**. Prepared a credential-free network probe with unit tests (**18 infrastructure tests passed including 5 probe cases**) and read-only dry plan. Actual probe creates exactly two owned temporary pods, checks allowed/denied TCP to Service and direct PG IP, then deletes only owned probes. No secrets/SQL/PG restart/app changes. Exec/DNS errors are inconclusive, not a denial PASS. `--apply-probes` has NOT run; requires scoped approval beyond metadata-read permission. R2 actual probe also not run.

## Authorized network probe execution

User approved the two temporary credential-free TCP probe pods. Invoked the
existing `network_probe.py --apply-probes` against the verified namespace/PG,
with protected evidence path under the approved OpenCode temporary directory.
It is running; verdict and cleanup have not been claimed yet. Authorization is
limited to these probes, not privileged filtering, R2 credentials, SQL, PG/app
restarts, data copying or cutover. Infrastructure unit tests freshly passed 18/18.

Probe completed: **UNENFORCED**, allowed/denied clients both connected to Service
and direct PG IP. Ownership-selector cleanup found zero probe pods, app/PG Ready
1/1; no Secret/SQL or app/PG change. Reviewed PG-only enforcement remains a gate.

Concurrent deployment drift: app digest now
`8a98ca8a0a73057d1bb7077c72a02034e3bcf07a4de21622b3f5656e8dd98d9f` instead of
`fbb74c5b...`. Relevant schema/model/runtime hashes rechecked unchanged, 40 models.
This workflow did not deploy that change; rebuild candidate on the latest digest
and coordinate stable final capture/cutover rather than overwriting concurrent work.

Fresh consolidated verification completed: **89 Node tool tests / 33 Python tests / 95 tracked server suites with 1,469 tests / 4 client-selection tests, all passing**. Log: approved temporary `pg-r2-pre-live-final.log`. Actual app smoke separately passed on the fixture overlay; latest production image is not built/pushed/deployed. Approval sought next is only read-only operational metadata inspection, not repeated plan approval or cutover.

## Urgent pre-holiday continuation — 2026-10-08

User requested completing tests and moving before their holiday; the exact date
and maintenance window remain unspecified. Read-only live metadata reconfirmed
app/PG readiness and digest `8a98ca8a...`; a migration-only amd64 local overlay was
rebuilt on that digest without replacing existing feature source.

Independent scoped reviews found and corrected three gaps: wrong/duplicate URL
schema bypass, SERIAL default/ownership mismatch, and shared export/source
sequence trust that could lose SQLite historical ID high-water marks. Failure
regressions were reproduced; independent correction review found no remaining
blocking finding in the reviewed patches. The new source-sequence tests are
included in the all/import/verify runner, not left as an unregistered test file.

Corrected full verification: **117 Node / 37 Python / 95 tracked server suites
with 1,469 regressions / 4 client-selection tests, all passing, zero Node skips**.
Includes real-PG corruption/rollback checks and actual application smoke on the
corrected latest-live-digest fixture. **18 infrastructure tests** and scoped
formatting/syntax checks passed separately. No running owned fixture containers
remained. Evidence: `docs/runbooks/2026-10-08-pg-pre-cutover-readiness.md`.

No production writes, Secret-value reads, app-data retrieval, image push/deploy,
R2 probe/upload, backup, migration or cutover occurred in this continuation.
Production remains NO-GO on proven PG isolation, real R2 recovery/key custody,
final stable baseline/writer freeze and explicit cutover gates. Deadline urgency
does not authorize privileged filtering or waive those requirements.

## Authorized actual-R2 synthetic probe — 2026-10-08

User explicitly approved existing-R2-Secret use for synthetic upload/download
testing only. Actual probe **PASS** at 22:59 Asia/Bangkok: authenticated encrypted
2 KiB and empty payloads, completion-last publication, downloaded hash/decrypt
checks, separate-process restore with saved synthetic key, existing-prefix
rejection, explicit 412 conditional no-overwrite with original-object checksum
unchanged, and wrong-key authentication failure before plaintext publication.
Four encrypted synthetic objects retained; no deletion/policy edits. Temporary
local credential copy removed, original Secret unchanged, no values printed.

Evidence: `docs/runbooks/2026-10-08-r2-live-synthetic-probe.md`. No application
rows/storage/effective keys, PG changes, writer freeze or real backup/cutover
were included in this authorization. PG isolation remains UNENFORCED; read-only
kernel/tool availability does not authorize installing tools/modules or adding
network privileges. The live-app backup and remaining production gates still
require their scoped go-ahead.

## Operator network-risk acceptance and continuation — 2026-10-08

The user explicitly accepted the unenforced network-isolation risk because this
deployment is internal and instructed migration work to continue. The design,
active runbook and readiness status now record that waiver. Do not spend further
migration work enforcing NetworkPolicy or infer authorization for network
privileges, public exposure or cluster-wide CNI changes. Existing internal
exposure, TLS and least-privilege requirements stay intact.

Fresh read-only checks confirmed context `INFI-JORHOR-Dev2`, namespace
`anythingllm`, app generation 21 with two Ready containers, PG Ready, both 20 GiB
PVCs Bound, and the unchanged app digest `8a98ca8a...`. There are no namespace
Jobs, CronJobs, DaemonSets or HPA in this inventory. Both `anythingllm` and
`mcp-bridge` mount writable application storage, so freeze the entire application
Deployment, not only its HTTP process. PG Service remains ClusterIP-only.

The reviewed local candidate exists as image
`sha256:13223afff08046e5e058f8df0b97c58d8fcc0a0dcecaccb7177bf9981cfa6253`,
`linux/amd64`. It has Python, tar and the PG adapter but deliberately lacks the
full offline CLI. A separate allowlisted maintenance Dockerfile now packages
that CLI on the same runtime, with a help-only default and no production data or
credentials in the build context. Backup/key custody, independent real-data
recovery and actual maintenance-window/cutover approval are not waived.

Continuation result: the isolated maintenance image now builds and passes ten
synthetic operation/packaging checks across 40 models, under UID 1000 with no
network and a read-only root filesystem. It preserves reviewed source history
separately from inherited live migrations and validates PG schema/migration
provenance against the runtime. The context excludes unrelated seed/docs files
as well as fixtures, application storage and credentials. Identity and repeatable
smoke commands are in the operator runbook. Production app-storage metadata is
about 328 MiB used with ample free space; no application data or keys were read.
No production writes, image delivery, writer freeze, actual backup/import or
cutover occurred. Next scoped decision is the actual maintenance window and
independent archive-key custody before protected real-data execution.
