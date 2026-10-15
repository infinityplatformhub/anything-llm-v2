# PG-specific isolation feasibility — local assessment

Status: enforcement remains unproven. On 2026-10-08 the user explicitly accepted
this internal-deployment risk and requested migration continuation; this is no
longer a production cutover gate for that migration. No network change or
enforcement claim follows. Sources: provisioning manifest/README and approved
migration design, including its operator amendment.

The existing NetworkPolicy selects the dedicated PG pod and allows application
and maintenance labels, but historical verification found unauthorized TCP
reachability. Reapplying that YAML, TLS/SCRAM, `pg_hba.conf`, an internal Service
or namespace separation do not prove TCP isolation.

## Smallest candidate to evaluate

A filter inside the **dedicated PG pod's network namespace**, installed before PG
readiness, could protect both Service-routed and direct pod access without changing
cluster CNI. It would require narrowly scoped `NET_ADMIN` rather than the current
PG container's dropped capabilities. This is a **proposal requiring specific
review/approval**, not a change made in this task.

It is not safe to simply allow current application pod IPs:
- Service routing/SNAT may alter source addresses; allow node IPs can admit other
  workloads on that node.
- Application/maintenance addresses change on restart; stale rules cause outage,
  broad fallback creates a bypass. Labels are not packet identities.
- IPv6 and established connections require explicit handling.
- A privileged updater must prove source identity and fail closed, and cannot
  casually accept arbitrary labels from unauthorized workloads.
- A proxy without an isolated backend only moves the listener, leaving bypass.

A fixed allowlist might be viable for a controlled, temporary migration window
but is not enough to claim the running application's isolation persists across
address changes. Do not invent a controller/sidecar privilege project under the
migration scope. If topology/source identity cannot support a verified PG-only
remedy, report the gate as blocked and request a specific alternative boundary.

## Required non-destructive evidence

1. Read-only metadata: actual topology/source-NAT, PG Service/pod addresses,
   app/maintenance identities and RBAC governing workload labels. No Secret values.
2. Disposable rehearsal of the proposed filter with current kernel/capabilities.
   Prove installation occurs before readiness and fails closed.
3. Simultaneous controls: allowed app/maintenance TLS success; unauthorized
   same-namespace and other-namespace TCP denial to both Service and direct pod;
   DNS/readiness positive controls exclude unreachable/unready false success.
4. Restart/address changes and IPv6 where present; no public or bypass listener.
5. Explicit review/go-ahead before scoped resource mutation or PG restart. Never
   run the old provisioning restart/dump verifier on migrated application data.

No cluster-wide CNI installation/configuration is authorized. Enforcement remains
unresolved. The explicit operator amendment in the migration design supersedes
the earlier requirement to stop cutover on this finding; it does not waive the
other recovery, key-custody, freeze or cutover requirements.

## Read-only topology and authorized probe update

Live pod metadata identifies Flannel v0.28.5 in `kube-flannel`. Flannel's upstream
README explicitly states that `flanneld` does not natively enforce NetworkPolicy;
policy enforcement requires an additional controller/integration. This explains
why the presence of the existing NetworkPolicy alone cannot establish protection.
It does not prove which managed VKE components exist outside the inspected pod
inventory.

Source: https://github.com/flannel-io/flannel/blob/master/README.md (read 2026-10-08).
Do not install its suggested cluster-wide controller under this migration task.

The user authorized exactly two credential-free temporary TCP probe pods.
`network_probe.py --apply-probes` is running against the already identified PG
Service/pod address with allowed/denied controls. No SQL, credential mounts,
network filter change or PG/app restart is included. Wait for actual verdict and
owned-pod cleanup evidence before reporting whether the policy is enforced.

Approved actual probe completed: **UNENFORCED**. All four TCP checks connected.
All owned probe pods were deleted and cleanup checked; no Secret/SQL or app/PG
change. PG-specific enforcement still needs reviewed authorization. Reapplying
the policy, TLS authentication or a proxy with a reachable backend is not a fix.
Do not infer NET_ADMIN/RBAC/restart or cluster-controller permission from this probe.
