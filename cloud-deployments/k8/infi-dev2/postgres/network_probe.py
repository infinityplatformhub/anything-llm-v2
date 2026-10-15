"""Explicitly authorized temporary TCP probes only; no SQL/secrets/restarts."""
import argparse
import json
from pathlib import Path
import re
import secrets
import subprocess

NS = "anythingllm"
IMAGE = "postgres:17-bookworm@sha256:66aafa11cf15800a3c94763f7e11d1e7b2e37e5e84bc4ce027cb6e1e4bfaf4df"
OWNER = "anythingllm-migration-network-probe"


def probe_pod(name, allowed, node):
    if not re.fullmatch(r"pg-network-probe-[a-f0-9]{12}", name):
        raise ValueError("Unsafe network probe name")
    labels = {"app.kubernetes.io/managed-by": OWNER}
    if allowed:
        labels["anythingllm-db-maintenance"] = "true"
    return {"apiVersion": "v1", "kind": "Pod", "metadata": {"name": name, "namespace": NS, "labels": labels}, "spec": {
        "nodeName": node, "automountServiceAccountToken": False, "restartPolicy": "Never",
        "securityContext": {"runAsUser": 999, "runAsGroup": 999, "runAsNonRoot": True, "seccompProfile": {"type": "RuntimeDefault"}},
        "containers": [{"name": "probe", "image": IMAGE, "command": ["sleep", "600"],
            "securityContext": {"allowPrivilegeEscalation": False, "capabilities": {"drop": ["ALL"]}},
            "resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"cpu": "100m", "memory": "64Mi"}}}],
    }}


def assess(checks):
    expected = {"allowedService", "allowedPod", "deniedService", "deniedPod"}
    if set(checks) != expected or any(type(value) is not bool for value in checks.values()):
        raise ValueError("Incomplete network controls")
    if not checks["allowedService"] or not checks["allowedPod"]:
        return "INCONCLUSIVE"
    return "UNENFORCED" if checks["deniedService"] or checks["deniedPod"] else "DENIED_IN_THIS_PROBE"


def parse_tcp_result(status, output):
    if status != 0 or output.strip() not in ("TCP_CONNECTED", "TCP_BLOCKED"):
        raise ValueError("TCP probe execution/DNS failed; denial is inconclusive")
    return output.strip() == "TCP_CONNECTED"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kubeconfig", required=True)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--apply-probes", action="store_true", help="Requires explicit authority to create two credential-free temporary probe pods")
    args = parser.parse_args()
    prefix = ["kubectl", "--kubeconfig", args.kubeconfig, "-n", NS]
    def call(arguments, payload=None, check=True):
        return subprocess.run(prefix + arguments, input=payload, capture_output=True, text=True, timeout=180, check=check)
    pg = json.loads(call(["get", "pod", "anythingllm-postgres-0", "-o", "json"]).stdout)
    app = json.loads(call(["get", "pod", "-l", "app=anythingllm", "-o", "json"]).stdout)
    if len(app["items"]) != 1 or pg["status"]["phase"] != "Running":
        raise RuntimeError("Target identity/readiness is ambiguous")
    node = app["items"][0]["spec"]["nodeName"]
    pod_ip = pg["status"]["podIP"]
    service = "anythingllm-postgres.anythingllm.svc.cluster.local"
    if not re.fullmatch(r"\d+\.\d+\.\d+\.\d+", pod_ip):
        raise RuntimeError("Unsupported PG address")
    names = ["pg-network-probe-" + secrets.token_hex(6) for _ in range(2)]
    pods = [probe_pod(names[0], True, node), probe_pod(names[1], False, node)]
    if not args.apply_probes:
        print(json.dumps({"plan": "two credential-free temporary pods; TCP only", "pods": pods, "targets": [service, pod_ip]}, indent=2))
        return
    created = []
    try:
        for pod in pods:
            call(["create", "-f", "-"], json.dumps(pod))
            created.append(pod["metadata"]["name"])
            call(["wait", "--for=condition=Ready", "pod/" + created[-1], "--timeout=120s"])
        checks = {}
        for name, label in zip(names, ["allowed", "denied"]):
            for host, target in [(service, "Service"), (pod_ip, "Pod")]:
                script = 'getent hosts "$1" >/dev/null || { echo DNS_FAILED; exit 2; }; if timeout 3 bash -c \'exec 3<>/dev/tcp/"$1"/5432\' _ "$1" 2>/dev/null; then echo TCP_CONNECTED; else echo TCP_BLOCKED; fi'
                result = call(["exec", name, "--", "bash", "-c", script, "_", host], check=False)
                checks[label + target] = parse_tcp_result(result.returncode, result.stdout)
        evidence = {"checks": checks, "verdict": assess(checks), "pgPodIP": pod_ip, "probeNode": node,
                    "limitation": "Same-namespace single-node probes only; not proof of restart/other-node/RBAC isolation", "secretsMounted": False, "sqlExecuted": False}
        path = Path(args.evidence)
        with path.open("x") as output:
            json.dump(evidence, output, indent=2)
        path.chmod(0o600)
        print(json.dumps(evidence))
    finally:
        for name in created:
            pod = json.loads(call(["get", "pod", name, "-o", "json"]).stdout)
            if pod["metadata"]["labels"].get("app.kubernetes.io/managed-by") != OWNER:
                raise RuntimeError("Refusing to delete an unfamiliar pod")
            call(["delete", "pod", name, "--wait=true", "--timeout=60s"])


if __name__ == "__main__":
    main()
