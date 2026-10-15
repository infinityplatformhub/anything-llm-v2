# Authorized live R2 synthetic probe — 2026-10-08

Result: **PASS**, 22:58:21–22:59:23 Asia/Bangkok on 2026-10-08.
This is actual R2 transport/recovery proof for synthetic payloads, **not a
production application backup or completed PostgreSQL migration**.

## Authorization and isolation of data

The user explicitly approved using the existing R2 Secret to upload/download
synthetic test data, without accessing application data. Only
`anythingllm/anythingllm-r2-backup-temporary` was read; its values never appeared
in tool output, logs, repository files or CLI arguments. A newly created 0600
credential file in an owned 0700 temporary directory was mounted read-only into
the pinned AWS CLI container and removed after the probe. The original Kubernetes
Secret was not changed or deleted.

No application database rows, storage files or effective application encryption
keys were retrieved. No application/PG resources, network controls, credentials,
PVCs or databases were changed. The receipt's `productionDataAccessed:false`
refers to application rows/storage, not the explicitly authorized R2 credentials.

## Execution and observed checks

- Used existing `scripts/database/{r2.cjs,publication.cjs,recovery-set.cjs}` with
  AWS CLI 2.17.49, pinned image
  `amazon/aws-cli@sha256:139b443e972ace68c8a6404b3558d2033903d7468efce71b6431dd126c6a6371`.
  Confirmed `PutObject.IfNoneMatch` support locally before credential use.
- Target was the approved bucket `anything-llm-backup`, restricted to new prefix
  `synthetic-probes/20261008-49968678-c4bc-4369-b1b1-f169e4be3a83`.
- Uploaded two authenticated-encrypted payloads: 2,048 random synthetic bytes
  and a zero-byte fixture, followed by encrypted manifest and completion marker.
  Downloaded SHA-256 checks and decrypt/compare passed before publication completed.
- A separate process restored from actual R2 into a fresh directory using only
  saved synthetic-key/credential references; both plaintext hashes matched.
- Existing-prefix publication was rejected. An explicit conditional PUT of
  different encrypted bytes returned **412 PreconditionFailed**; subsequent
  download confirmed the original ciphertext remained unchanged.
- A wrong synthetic recovery key failed authentication before plaintext
  completion-marker publication.
- Executed 5 prefix-scoped LISTs, 5 PUT attempts (4 successful, 1 expected
  conditional rejection), and 10 GETs, including 4 independent-process GETs.
  All commands were restricted to LIST/PUT/GET under the owned prefix. No remote
  deletion, bucket/policy modification or broad bucket listing was performed.
- Four encrypted synthetic objects remain intentionally retained. They are not
  production recovery objects and were not automatically cleaned up.

Protected evidence and synthetic key are under
`$TMPDIR/opencode/pg-r2-authorized-synthetic-20261008-o7eLxm/`;
`redacted-evidence.json` is the original receipt. No R2 credentials remain there.
Production-key custody, real-data backup/independent recovery, bucket publication
policy and production execution tooling still require their own verification.

## Remaining migration blocker

Subsequent operator amendment: the user explicitly accepted the internal-network
isolation risk and requested migration continuation. The finding below remains
valid but is no longer a cutover blocker. See the operator amendment in
`docs/specs/2026-10-08-sqlite-postgresql-r2-migration-design.md`; application-data
backup, key custody, independent recovery and maintenance/cutover gates remain.

PG TCP isolation remains **UNENFORCED**. A read-only PG-container check found
kernel `5.4.250-10-velinux1u4-amd64`, no observed loaded WireGuard module, and no
`ip`, `wg`, `iptables` or `nft` executable in the current PG image. This does not
prove kernel features unavailable; it does prove a ready in-image firewall cannot
simply be invoked. No module/tool installation, privilege addition, restart,
filter/controller deployment or cluster-wide CNI change was attempted.

R2-test approval does not authorize production app capture/upload, writer freeze,
effective app-key retrieval, privileged network changes or cutover. Those remain
the separately gated actions in the approved migration plan.
