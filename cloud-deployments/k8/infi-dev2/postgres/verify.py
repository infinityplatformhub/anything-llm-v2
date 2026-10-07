#!/usr/bin/env python3
"""Synthetic-only PG verification; no application migration."""
import argparse
import json
import pathlib
import re
import secrets
import subprocess
from provision import Kube, LABELS, NAME, NS, PVC, resources, validate_volume

HOST = NAME + "." + NS + ".svc.cluster.local"


def check_fixture_name(name):
    if not re.fullmatch(r"pg_probe_[a-f0-9]+", name):
        raise RuntimeError("Unsafe synthetic object name")


def verdict(policy_enforced):
    return {"provisioned": True, "databaseChecks": "PASS", "networkPolicy": "ENFORCED" if policy_enforced else "UNENFORCED",
            "offClusterBackup": "NOT_CONFIGURED", "independentDisasterRestore": "NOT_TESTED", "migrationReady": False,
            "applicationMigrated": False}


def client_pod(name, allowed):
    image = next(d for d in resources() if d["kind"] == "StatefulSet")["spec"]["template"]["spec"]["containers"][0]["image"]
    labels = {"app.kubernetes.io/managed-by": LABELS["app.kubernetes.io/managed-by"], "pg-verification-client": "true"}
    if allowed:
        labels["anythingllm-db-maintenance"] = "true"
    spec = {"automountServiceAccountToken": False, "restartPolicy": "Never",
            "securityContext": {"runAsUser": 999, "runAsGroup": 999, "runAsNonRoot": True, "seccompProfile": {"type": "RuntimeDefault"}},
            "containers": [{"name": "client", "image": image, "command": ["sleep", "3600"],
                            "securityContext": {"allowPrivilegeEscalation": False, "capabilities": {"drop": ["ALL"]}},
                            "resources": {"requests": {"cpu": "50m", "memory": "64Mi"}, "limits": {"cpu": "250m", "memory": "256Mi"}}}]}
    if allowed:
        spec["volumes"] = [
            {"name": "auth", "secret": {"secretName": NAME + "-auth", "defaultMode": 292}},
            {"name": "ca", "secret": {"secretName": NAME + "-tls", "items": [{"key": "ca.crt", "path": "ca.crt"}], "defaultMode": 292}},
            {"name": "work", "emptyDir": {"sizeLimit": "64Mi"}}]
        spec["containers"][0]["volumeMounts"] = [{"name": "auth", "mountPath": "/auth", "readOnly": True}, {"name": "ca", "mountPath": "/ca", "readOnly": True}, {"name": "work", "mountPath": "/work"}]
    return {"apiVersion": "v1", "kind": "Pod", "metadata": {"name": name, "namespace": NS, "labels": labels}, "spec": spec}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kubeconfig", required=True)
    parser.add_argument("--evidence", required=True)
    args = parser.parse_args()
    kube = Kube(args.kubeconfig)
    app_before = kube.get("deployment", "anythingllm")["spec"]["template"]
    fixture = "pg_probe_" + secrets.token_hex(5)
    check_fixture_name(fixture)
    clients = ["pg-probe-client-" + fixture[9:], "pg-probe-denied-" + fixture[9:]]
    created = []
    checks = []

    def exec_shell(pod, script):
        return kube.call(["exec", "-i", pod, "--", "bash", "-s"], script)

    def sql(role, statement, db="anythingllm", expect_failure=False, options=""):
        key = {"postgres": "POSTGRES_PASSWORD", "anythingllm_migrator": "MIGRATOR_PASSWORD", "anythingllm_app": "APP_PASSWORD"}[role]
        script = f"""set -euo pipefail
export PGHOST={HOST} PGPORT=5432 PGSSLMODE=verify-full PGSSLROOTCERT=/ca/ca.crt PGCONNECT_TIMEOUT=5
export PGPASSWORD="$(cat /auth/{key})"
set +e
out=$(psql -X -tA -v ON_ERROR_STOP=1 -U {role} -d {db} {options} 2>/work/last-error <<'SQL'
{statement}
SQL
)
code=$?
set -e
"""
        if expect_failure:
            script += 'test "$code" -ne 0\nprintf "NEGATIVE_REJECTED\\n"\n'
        else:
            script += 'test "$code" -eq 0\nprintf "%s\\n" "$out"\n'
        return exec_shell(clients[0], script).strip()

    def cleanup_sql():
        sql("postgres", f"DROP DATABASE IF EXISTS {fixture} WITH (FORCE);", db="postgres")
        sql("anythingllm_migrator", f"DROP TABLE IF EXISTS public.{fixture};")

    try:
        for name, allowed in zip(clients, [True, False]):
            if kube.get("pod", name):
                raise RuntimeError("Client name collision")
            kube.call(["create", "-f", "-"], json.dumps(client_pod(name, allowed)))
            created.append(name)
            kube.call(["wait", "--for=condition=Ready", "pod/" + name, "--timeout=180s"], timeout=200)
        version = int(sql("postgres", "SHOW server_version_num;", db="postgres"))
        assert 170000 <= version < 180000
        assert sql("anythingllm_app", "SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid();") == "t"
        assert sql("postgres", "SELECT rolname FROM pg_roles WHERE rolname IN ('anythingllm_migrator','anythingllm_app') AND (rolsuper OR rolcreatedb OR rolcreaterole);", db="postgres") == ""
        assert sql("postgres", "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='anythingllm';", db="postgres") == "anythingllm_migrator"
        # Dedicated database must be empty before an intentional pod restart.
        assert sql("postgres", "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema');") == "0"
        for statement in [f"CREATE DATABASE {fixture};", "CREATE ROLE pg_probe_forbidden;", f"CREATE TABLE public.{fixture}(id int);"]:
            sql("anythingllm_app", statement, expect_failure=True)
        checks.append("version-owner-restricted-roles-tls-verified")
        print("PG_CHECK_PASS version-owner-restricted-roles-tls-verified", flush=True)
        # Error output is discarded; it can contain connection details.
        negative = f"""set -euo pipefail
export PGHOST={HOST} PGPORT=5432 PGUSER=anythingllm_app PGDATABASE=anythingllm PGCONNECT_TIMEOUT=5 PGSSLMODE=verify-full PGSSLROOTCERT=/ca/ca.crt
export PGPASSWORD=incorrect-probe-password
if psql -X -c 'SELECT 1' >/dev/null 2>&1; then exit 1; fi
echo BAD_PASSWORD_REJECTED
export PGPASSWORD="$(cat /auth/APP_PASSWORD)"
if PGSSLMODE=disable psql -X -c 'SELECT 1' >/dev/null 2>&1; then exit 1; fi
echo PLAINTEXT_REJECTED
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout /work/unrelated.key -out /work/unrelated-ca.crt -subj '/CN=Unrelated probe CA' >/dev/null 2>&1
if PGSSLROOTCERT=/work/unrelated-ca.crt psql -X -c 'SELECT 1' >/dev/null 2>&1; then exit 1; fi
rm /work/unrelated.key /work/unrelated-ca.crt
ip=$(getent ahostsv4 "$PGHOST" | awk 'NR==1 {{print $1}}')
if PGHOST=wrong-host.invalid PGHOSTADDR="$ip" psql -X -c 'SELECT 1' >/dev/null 2>&1; then exit 1; fi
echo AUTH_TLS_NEGATIVES_PASS
"""
        exec_shell(clients[0], negative)
        checks.append("bad-password-plaintext-bad-ca-wrong-hostname-rejected")
        print("PG_CHECK_PASS auth-tls-negatives", flush=True)
        sql("anythingllm_migrator", f"CREATE TABLE public.{fixture}(id integer PRIMARY KEY, value text NOT NULL); INSERT INTO public.{fixture} VALUES (1,'persistent-fixture');")
        sql("anythingllm_app", f"BEGIN; INSERT INTO public.{fixture} VALUES(2,'rollback'); ROLLBACK; INSERT INTO public.{fixture} VALUES(3,'temporary'); UPDATE public.{fixture} SET value='updated' WHERE id=3; DELETE FROM public.{fixture} WHERE id=3;")
        assert sql("anythingllm_app", f"SELECT id || ':' || value FROM public.{fixture};") == "1:persistent-fixture"
        checks.append("runtime-data-permissions-and-transaction-rollback")
        print("PG_CHECK_PASS runtime-data-permissions", flush=True)
        pod = kube.get("pod", NAME + "-0")
        assert pod["metadata"]["labels"]["app.kubernetes.io/name"] == NAME
        kube.call(["delete", "pod", NAME + "-0", "--wait=true", "--timeout=120s"])
        kube.call(["rollout", "status", "statefulset/" + NAME, "--timeout=300s"], timeout=320)
        assert sql("anythingllm_app", f"SELECT id || ':' || value FROM public.{fixture};") == "1:persistent-fixture"
        checks.append("ssd-data-survives-dedicated-pod-restart")
        print("PG_CHECK_PASS persistence-after-restart", flush=True)
        sql("postgres", f"CREATE DATABASE {fixture};", db="postgres")
        restore = f"""set -euo pipefail
export PGHOST={HOST} PGPORT=5432 PGSSLMODE=verify-full PGSSLROOTCERT=/ca/ca.crt PGCONNECT_TIMEOUT=5
export PGPASSWORD="$(cat /auth/POSTGRES_PASSWORD)"
pg_dump -U postgres -d anythingllm -Fc -f /work/fixture.dump 2>/work/dump-error
pg_restore -U postgres -d {fixture} --exit-on-error /work/fixture.dump 2>/work/restore-error
rm /work/fixture.dump
echo LOGICAL_RESTORE_PASS
"""
        exec_shell(clients[0], restore)
        assert sql("postgres", f"SELECT id || ':' || value FROM public.{fixture};", db=fixture) == "1:persistent-fixture"
        checks.append("pg-dump-restore-content-compared")
        print("PG_CHECK_PASS logical-restore", flush=True)
        denied = exec_shell(clients[1], f"set -e; getent ahostsv4 {HOST} >/dev/null; if timeout 8 bash -c 'exec 3<>/dev/tcp/{HOST}/5432' >/dev/null 2>&1; then echo CONNECTED; else echo BLOCKED; fi").strip()
        assert sql("anythingllm_app", "SELECT 1;") == "1"
        policy_enforced = denied == "BLOCKED"
        cleanup_sql()
        assert sql("postgres", "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema');") == "0"
        pvc = kube.get("pvc", PVC)
        pv = kube.get("pv", pvc["spec"]["volumeName"])
        validate_volume(pvc, pv)
        assert pv["spec"]["persistentVolumeReclaimPolicy"] == "Retain"
        assert kube.get("service", NAME)["spec"]["type"] == "ClusterIP"
        assert kube.get("deployment", "anythingllm")["spec"]["template"] == app_before
        ping = subprocess.check_output(["curl", "--fail", "--silent", "--show-error", "https://workspace.approof.studio/api/ping"], text=True, timeout=20)
        assert json.loads(ping)["online"]
        result = verdict(policy_enforced)
        result.update({"checks": checks, "versionNumber": version, "applicationUnchanged": True, "pvReclaimPolicy": "Retain", "fixtureRowsRemaining": 0})
        evidence = pathlib.Path(args.evidence)
        evidence.write_text(json.dumps(result, indent=2))
        print("PG_VERIFY_RESULT " + json.dumps(result))
    finally:
        cleanup_failed = False
        # If a test failed, attempt narrowly named DB/table cleanup while client exists.
        if clients[0] in created:
            try:
                cleanup_sql()
            except (RuntimeError, subprocess.TimeoutExpired):
                cleanup_failed = True
                print("PG_FIXTURE_CLEANUP_INCOMPLETE name=" + fixture)
        for name in created:
            obj = kube.get("pod", name)
            if obj and obj["metadata"].get("labels", {}).get("pg-verification-client") == "true":
                kube.call(["delete", "pod", name, "--wait=true", "--timeout=60s"])
        if cleanup_failed:
            raise RuntimeError("Synthetic cleanup incomplete; do not claim verification complete")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, AssertionError, subprocess.TimeoutExpired) as error:
        raise SystemExit("PG verification failed: " + str(error))
