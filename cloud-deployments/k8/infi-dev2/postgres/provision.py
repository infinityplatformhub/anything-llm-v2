#!/usr/bin/env python3
"""Guarded dedicated PG provisioning. Never prints kubectl payloads/Secrets."""
import argparse
import base64
import json
import os
import pathlib
import secrets
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent
NS = "anythingllm"
NAME = "anythingllm-postgres"
PVC = NAME + "-data"
LABELS = {"app.kubernetes.io/name": NAME, "app.kubernetes.io/managed-by": "anythingllm-pg-provision"}
OBJECTS = [("secret", NAME + "-auth"), ("secret", NAME + "-tls"), ("pvc", PVC),
           ("service", NAME), ("configmap", NAME + "-config"),
           ("statefulset", NAME), ("networkpolicy", NAME)]


def resources():
    # JSON is a YAML subset; stdlib parsing avoids installing dependencies.
    return json.loads((ROOT / "postgres.yaml").read_text())["items"]


def preflight(get):
    found = [get(kind, name) for kind, name in OBJECTS]
    for obj in found:
        if obj is not None and any(obj.get("metadata", {}).get("labels", {}).get(k) != v for k, v in LABELS.items()):
            raise RuntimeError("Conflicting resource ownership; refusing to overwrite")
    if any(found) and not all(found):
        raise RuntimeError("Partial provisioning state; investigate before retry, preserve credentials/storage")
    return "existing" if all(found) else "new"


def send_resources(call, docs, dry_run=False, existing=False):
    for doc in docs:
        if existing and doc["kind"] == "Secret":
            continue
        # Secret create never rotates existing credentials; stdin is not logged.
        args = ["create" if doc["kind"] == "Secret" else "apply", "-f", "-"]
        if dry_run:
            args.append("--dry-run=server")
        call(args, json.dumps(doc))


def validate_volume(pvc, pv):
    metadata = pvc["metadata"]
    ref = pv["spec"].get("claimRef", {})
    if (metadata["name"] != PVC or metadata["namespace"] != NS
            or any(metadata.get("labels", {}).get(k) != v for k, v in LABELS.items())
            or ref.get("name") != PVC or ref.get("namespace") != NS
            or ref.get("uid") != metadata["uid"]
            or pv["metadata"]["name"] != pvc["spec"]["volumeName"]):
        raise RuntimeError("Bound volume identity mismatch; no PV modified")
    return pv["metadata"]["name"]


class Kube:
    def __init__(self, kubeconfig):
        self.prefix = ["kubectl", "--kubeconfig", kubeconfig, "-n", NS]

    def call(self, args, payload=None, timeout=120):
        result = subprocess.run(self.prefix + args, input=payload, text=True, capture_output=True, timeout=timeout)
        if result.returncode:
            # kubectl errors may echo Secret manifests or literal values.
            raise RuntimeError("kubectl operation failed: " + " ".join(args[:2]) + "; inspect resource state without dumping Secrets")
        return result.stdout

    def get(self, kind, name):
        result = self.call(["get", kind, name, "--ignore-not-found", "-o", "json"])
        return json.loads(result) if result.strip() else None


def secret_docs():
    auth = {"POSTGRES_PASSWORD": secrets.token_hex(32), "MIGRATOR_PASSWORD": secrets.token_hex(32), "APP_PASSWORD": secrets.token_hex(32)}
    with tempfile.TemporaryDirectory(prefix="anythingllm-pg-tls-") as tmp:
        tmp = pathlib.Path(tmp)
        def openssl(*args):
            result = subprocess.run(["openssl", *args], cwd=tmp, capture_output=True)
            if result.returncode:
                raise RuntimeError("TLS certificate generation failed")
        old = os.umask(0o077)
        try:
            openssl("req", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "1825", "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=AnythingLLM PostgreSQL private CA")
            openssl("req", "-newkey", "rsa:3072", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=anythingllm-postgres.anythingllm.svc.cluster.local")
            names = [NAME, NAME + "." + NS, NAME + "." + NS + ".svc", NAME + "." + NS + ".svc.cluster.local"]
            (tmp / "extensions").write_text("subjectAltName=" + ",".join("DNS:" + n for n in names) + "\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n")
            openssl("x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "365", "-sha256", "-extfile", "extensions")
            tls = {n: base64.b64encode((tmp / n).read_bytes()).decode() for n in ["ca.crt", "server.crt", "server.key"]}
        finally:
            os.umask(old)
    def document(name):
        return {"apiVersion": "v1", "kind": "Secret", "metadata": {"name": name, "namespace": NS, "labels": LABELS}, "type": "Opaque"}
    a, t = document(NAME + "-auth"), document(NAME + "-tls")
    a["stringData"], t["data"] = auth, tls
    return [a, t]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kubeconfig", required=True)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--dry-run", action="store_true")
    group.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    kube = Kube(args.kubeconfig)
    state = preflight(kube.get)
    kube.get("namespace", NS)
    storage = kube.get("storageclass", "ebs-ssd")
    if not storage:
        raise RuntimeError("Missing ebs-ssd")
    docs = ([] if state == "existing" else secret_docs()) + resources()
    send_resources(kube.call, docs, dry_run=args.dry_run, existing=state == "existing")
    if args.dry_run:
        print("PG_DRY_RUN_OK state=" + state + " no resources mutated")
        return
    kube.call(["rollout", "status", "statefulset/" + NAME, "--timeout=600s"], timeout=620)
    pvc = kube.get("pvc", PVC)
    if pvc["status"]["phase"] != "Bound":
        raise RuntimeError("PVC not bound")
    pv = kube.get("pv", pvc["spec"]["volumeName"])
    name = validate_volume(pvc, pv)
    kube.call(["patch", "pv", name, "--type=merge", "-p", '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'])
    if kube.get("pv", name)["spec"]["persistentVolumeReclaimPolicy"] != "Retain":
        raise RuntimeError("PV retention verification failed")
    print("PG_PROVISION_READY namespace=" + NS + " service=" + NAME + " pvc=" + PVC + " pv=" + name + " reclaim=Retain")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.TimeoutExpired) as error:
        raise SystemExit(str(error))
