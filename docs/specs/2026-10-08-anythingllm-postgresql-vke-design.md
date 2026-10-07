# Dedicated PostgreSQL preparation on VKE

## Intent and scope

Prepare a dedicated single-instance PostgreSQL database for a future AnythingLLM
application-database migration. The user selected VKE and single instance.
Do not migrate data, connect production AnythingLLM to PostgreSQL, change its
image/environment/PVC, or configure pgvector as part of provisioning.
The separately built agent-finalization image must not be deployed as part of
this task. Existing production remains at Step 3 (`f43be3da`).

## Architecture

- Namespace: existing `anythingllm`.
- Dedicated StatefulSet `anythingllm-postgres`, one replica, PostgreSQL 17 official
  Debian image pinned to an inspected immutable digest before deployment.
- Service `anythingllm-postgres`, ClusterIP TCP 5432; no external IP, NodePort,
  LoadBalancer, ingress, tunnel, or public DNS exposure.
- Dedicated 20 GiB ReadWriteOnce SSD PVC, using existing `ebs-ssd`; never reuse
  `anythingllm-storage`. Additional SSD incurs provider charges.
- StatefulSet PVC retention: Retain on scale-down/deletion. The existing
  StorageClass has reclaimPolicy Delete, so the new bound PV must also be
  explicitly changed to Retain, without modifying the shared StorageClass.
  Do not delete PVC/PV during cleanup or rollback.
- Initial requests: 250m CPU / 512 MiB RAM; limits: 1 CPU / 1 GiB RAM.
  Initial PostgreSQL tuning: shared_buffers 128 MiB and max_connections 50.
- Startup/readiness via pg_isready; conservative liveness. Startup must allow
  initialization/recovery without a premature restart loop. Graceful stop 60s.
- Persistent data in a PGDATA subdirectory to avoid filesystem lost+found.

Single instance is explicitly not HA or point-in-time recovery. Pod/node loss
may cause downtime while the SSD reattaches. PVC/PV protection is not backup.

## Security and credentials

- Generate distinct random credentials for administrator, migrator and runtime
  application roles. Credentials and TLS private key belong in Kubernetes
  Secrets only, never manifests, Git, logs, CLI argument strings or evidence.
- Database `anythingllm` with a dedicated migration owner; runtime role is not
  superuser, cannot create roles/databases, and is not the migration owner.
  Grant only connection/schema/data privileges needed when schema is introduced;
  no application migrations are executed now.
- Use SCRAM password authentication and internal TLS with a generated private CA
  and server certificate for the service DNS names. Verify CA and hostname from
  the test client; avoid treating ClusterIP as transport encryption.
- Attempt a narrowly scoped ingress NetworkPolicy allowing the existing
  AnythingLLM pod label and explicitly labeled database-maintenance clients.
  VKE's network policy enforcement has NOT been established from daemonset
  inventory. Verify a denied client cannot connect; if enforcement is absent,
  report that limitation rather than claim NetworkPolicy provides isolation.
- Internal service DNS does not itself prevent other cluster workloads from
  reaching the port. TLS, strong passwords and least privilege remain required.
- No use of other projects' PostgreSQL instances or secrets.

## Verification and backup gate

1. Server-side manifest validation before applying new namespaced resources.
2. Bound dedicated PVC; new PV Retain policy; pod ready without restart loops.
3. Confirm server version, database/roles, non-superuser runtime, TLS verified
   client connection through Service DNS, and bad-password rejection.
4. Use synthetic fixture rows for transaction/write/read tests from a temporary
   client. Verify persistence across a deliberate PG pod restart before any
   application data is stored. This must not restart the AnythingLLM pod.
5. Dump the synthetic database with pg_dump and restore into a temporary database
   on this instance; compare content, then drop only the temporary fixture DB and
   remove synthetic rows. This proves logical restore, not independent recovery
   from loss of the instance.
6. Evidence records object names, image digest, readiness, tests, resource scope
   and limitations without credentials. Confirm production app/ping unchanged.

No automatic backup destination is approved/configured yet. Do not introduce an
object-storage dependency or store persistent backups on the same SSD as the
database. Scheduled off-cluster backups, retention, recovery objectives and an
independent restore drill must be agreed and implemented BEFORE migrating real
production data. An empty prepared database can be provisioned before that gate.

## Delivery and rollback

Store resource manifests and concise operator instructions under
`cloud-deployments/k8/infi-dev2/postgres/`, following repository conventions.
Keep bootstrap/secrets outside committed content. Scripts must be safe on rerun:
never replace existing database credentials or reinitialize an existing PVC.
Detect existing resource names and reconcile carefully instead of overwriting
unfamiliar resources.

Rollback during initial provisioning means stop the new StatefulSet only;
retain storage and secrets for investigation. Do not alter AnythingLLM or any
other project's database. No production data migration or cutover is authorized
by approval of this provisioning design.

## Observed cluster prerequisites

2026-10-08 read-only checks: two amd64 nodes; measured memory usage approximately
52–55%; existing ebs-ssd supports volume expansion and WaitForFirstConsumer,
reclaimPolicy Delete. Namespace has no listed quotas/limits/network policies.
Snapshot controller exists, but no VolumeSnapshotClass is configured. Existing
PostgreSQL workloads belong to other projects and are not shared by this design.

## Approval gates

User reviews this written design, then a written implementation/verification
plan before resource creation. Provider charges, single-instance downtime and
the off-cluster-backup-before-migration requirement are explicit trade-offs.
