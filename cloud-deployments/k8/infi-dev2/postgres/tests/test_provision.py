import importlib.util
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class ProvisionTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("pg_provision", ROOT / "provision.py")
        self.p = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.p)

    def test_dry_run_never_mutates(self):
        calls = []
        self.p.preflight(lambda kind, name: None)
        self.p.send_resources(lambda args, payload: calls.append(args), [{"kind": "Secret"}], dry_run=True)
        self.assertTrue(all("--dry-run=server" in a for a in calls))
        self.assertFalse(any("delete" in a or "patch" in a for a in calls))

    def test_existing_unfamiliar_resource_aborts(self):
        with self.assertRaises(RuntimeError):
            self.p.preflight(lambda kind, name: {"metadata": {"labels": {}}})

    def test_partial_secret_state_aborts(self):
        with self.assertRaises(RuntimeError):
            self.p.preflight(lambda kind, name: {"metadata": {"labels": self.p.LABELS}} if name.endswith("auth") else None)

    def test_rerun_preserves_passwords(self):
        self.assertEqual(self.p.preflight(lambda kind, name: {"metadata": {"labels": self.p.LABELS}}), "existing")
        calls = []
        self.p.send_resources(lambda args, payload: calls.append((args, payload)), [{"kind": "Secret"}, {"kind": "Service"}], existing=True)
        self.assertEqual(len(calls), 1)
        self.assertNotIn("Secret", calls[0][1])

    def test_pv_patch_targets_only_owned_claim(self):
        pvc = {"metadata": {"name": self.p.PVC, "namespace": self.p.NS, "uid": "own-uid", "labels": self.p.LABELS}, "spec": {"volumeName": "own-pv"}}
        pv = {"metadata": {"name": "own-pv"}, "spec": {"claimRef": {"namespace": self.p.NS, "name": self.p.PVC, "uid": "own-uid"}}}
        self.assertEqual(self.p.validate_volume(pvc, pv), "own-pv")
        pv["spec"]["claimRef"]["uid"] = "another-uid"
        with self.assertRaises(RuntimeError):
            self.p.validate_volume(pvc, pv)

    def test_no_secrets_in_commands_or_output(self):
        calls = []
        secret = {"kind": "Secret", "stringData": {"password": "sensitive-sentinel"}}
        self.p.send_resources(lambda args, payload: calls.append((args, payload)), [secret])
        self.assertNotIn("sensitive-sentinel", repr(calls[0][0]))
        self.assertIn("sensitive-sentinel", calls[0][1])

    def test_manifest_has_no_public_service_or_application_storage(self):
        docs = self.p.resources()
        service = next(d for d in docs if d["kind"] == "Service")
        self.assertEqual(service["spec"]["type"], "ClusterIP")
        stateful = next(d for d in docs if d["kind"] == "StatefulSet")
        self.assertEqual(stateful["spec"]["replicas"], 1)
        self.assertNotIn('"claimName": "anythingllm-storage"', repr(docs))
        self.assertEqual(stateful["spec"]["persistentVolumeClaimRetentionPolicy"], {"whenDeleted": "Retain", "whenScaled": "Retain"})

    def test_bootstrap_never_puts_password_in_psql_arguments(self):
        config = next(d for d in self.p.resources() if d["kind"] == "ConfigMap")
        script = config["data"]["10-bootstrap.sh"]
        self.assertIn("\\getenv", script)
        self.assertNotIn("--set migrator_password=", script)
        self.assertNotIn("-v app_password=", script)
        self.assertIn("hostnossl all all 0.0.0.0/0 reject", config["data"]["pg_hba.conf"])

    def test_client_mounts_ca_only_not_server_private_key(self):
        v = self.verifier()
        client = v.client_pod("pg-probe-client-123", allowed=True)
        ca = next(volume for volume in client["spec"]["volumes"] if volume["name"] == "ca")
        self.assertEqual(ca["secret"]["items"], [{"key": "ca.crt", "path": "ca.crt"}])

    def verifier(self):
        spec = importlib.util.spec_from_file_location("pg_verify", ROOT / "verify.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_verify_cleanup_is_scoped(self):
        v = self.verifier()
        with self.assertRaises(RuntimeError):
            v.check_fixture_name("anythingllm")
        v.check_fixture_name("pg_probe_123abc")
        with self.assertRaises(RuntimeError):
            v.check_fixture_name("pg_probe_123'; DROP DATABASE anythingllm;")

    def test_verifier_never_prints_credentials(self):
        v = self.verifier()
        pod = v.client_pod("pg-probe-client-123", allowed=True)
        self.assertNotIn("stringData", repr(pod))
        self.assertFalse(pod["spec"]["automountServiceAccountToken"])
        for env in pod["spec"]["containers"][0].get("env", []):
            self.assertNotIn("PASSWORD", env["name"])

    def test_policy_unsupported_is_reported(self):
        v = self.verifier()
        result = v.verdict(policy_enforced=False)
        self.assertFalse(result["migrationReady"])
        self.assertEqual(result["networkPolicy"], "UNENFORCED")

    def test_missing_backup_destination_blocks_migration_claim(self):
        v = self.verifier()
        result = v.verdict(policy_enforced=True)
        self.assertFalse(result["migrationReady"])
        self.assertEqual(result["offClusterBackup"], "NOT_CONFIGURED")


if __name__ == "__main__":
    unittest.main()
