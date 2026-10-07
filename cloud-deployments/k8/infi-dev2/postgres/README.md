# Dedicated AnythingLLM PostgreSQL (preparation only)

PostgreSQL 17 single instance in namespace `anythingllm`, a dedicated 20 GiB SSD,
internal TLS/SCRAM connections. **The application still uses SQLite.** These
resources do not migrate data or change its deployment.

## Provision / verify

From repository root:

```bash
python3 -m unittest discover -s cloud-deployments/k8/infi-dev2/postgres/tests -v
python3 cloud-deployments/k8/infi-dev2/postgres/provision.py --kubeconfig "$KUBECONFIG" --dry-run
python3 cloud-deployments/k8/infi-dev2/postgres/provision.py --kubeconfig "$KUBECONFIG" --apply
python3 cloud-deployments/k8/infi-dev2/postgres/verify.py --kubeconfig "$KUBECONFIG" --evidence /path/to/approved/private/pg-evidence.json
```

Verification deliberately restarts **only this PG pod**. Run only while this
database contains no real application tables/data. It uses scoped synthetic
tables and a temporary restore database; logical restore on the same instance is
not an independent disaster-recovery test. Maintenance clients mount credentials;
their output must never print passwords, environment dumps or connection URLs.

Existing resources must carry ownership labels. Partial/unfamiliar resources make
provisioning stop; investigate instead of deleting the PVC or rotating Secrets.
Normal reruns preserve Secrets, but applying changed StatefulSet configuration
can restart PG: inspect manifest changes before rerunning `--apply`.

## Connection contract (do not wire live app yet)

- Host: `anythingllm-postgres.anythingllm.svc.cluster.local`; port `5432`.
- Database: `anythingllm`; owner/migrator `anythingllm_migrator`; runtime `anythingllm_app`.
- Secret `anythingllm-postgres-auth`: `POSTGRES_PASSWORD`, `MIGRATOR_PASSWORD`, `APP_PASSWORD`.
- Secret `anythingllm-postgres-tls`: `ca.crt`, `server.crt`, `server.key`.
- Clients require `sslmode=verify-full` and mounted `ca.crt`. Mount **only CA** in
  application clients, never the server key/admin credential. Transfer credentials
  via approved Secret references, not copied plaintext URLs/chat/Git.
- Internal ClusterIP only; no ingress/public service/tunnel. The ingress
  NetworkPolicy permits same-namespace `app=anythingllm` and explicitly labeled
  `anythingllm-db-maintenance=true` clients. The verifier reports whether a denied
  client can connect; do not claim policy isolation without enforcement evidence.
- Runtime has connection/schema usage and owner-created tables/sequences data
  privileges, not schema creation/superuser/role/database administration.

The official image is immutable by digest, PostgreSQL `17.11-bookworm` at initial
provisioning. Version updates must be planned, tested and backed up. Startup uses
local Unix-socket trust for the dedicated non-root container; network traffic
requires TLS/password. Users who can exec into DB/admin-client pods can administer
the database; protect Kubernetes RBAC accordingly.

## Retention, backup and rollback

20 GiB SSD incurs additional provider storage charges. This is **not HA**; node
loss/volume reattachment causes downtime. PVC and bound PV are retained, but
neither is backup. No VolumeSnapshotClass or scheduled off-cluster backup is
configured by this task.

Before migrating real data: agree recovery targets/retention, configure scheduled
off-cluster backups, perform independent restore, resolve policy limitations,
audit SQLite-specific SQL and prepare a reversible migration/cutover plan.
pgvector is a separate vector-search decision, not the application DB migration.

### Initial VKE verification (2026-10-08)

PostgreSQL 17.11 prepared successfully. TLS/hostname validation, SCRAM wrong-
password rejection, non-TLS rejection, role restrictions, synthetic CRUD and
rollback, persistence after PG pod restart and logical dump/restore passed.
The new 20 GiB SSD is Bound and its PV has Retain reclaim policy; live application
deployment remained unchanged and online.

**NetworkPolicy is not enforced in the tested VKE environment:** an unlabeled
client could reach port 5432. This is not public internet exposure, but workloads
inside the cluster can reach the TLS/authentication boundary. Resolve actual
network isolation and configure off-cluster backups before real data migration.
Do not change cluster-wide networking as part of this provisioning task.

Stop only the new instance when investigating failed provisioning:

```bash
kubectl --kubeconfig "$KUBECONFIG" -n anythingllm scale statefulset/anythingllm-postgres --replicas=0
```

Do not delete PVC/PV/Secrets or modify `anythingllm-storage`, other projects' PG,
or the shared StorageClass. To resume after investigation, restore replicas=1.
The server certificate lasts 365 days, private CA 1825 days. CA signing key is
discarded after bootstrap; renewal requires a planned certificate/CA rotation,
Secret updates and client trust rollout. Set maintenance reminders before real
data migration. No automatic rotation/credential replacement on rerun.
