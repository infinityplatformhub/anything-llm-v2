import importlib.util
from pathlib import Path
import unittest


def module():
    spec = importlib.util.spec_from_file_location("network_probe", Path(__file__).parents[1] / "network_probe.py")
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


class NetworkProbeTests(unittest.TestCase):
    def test_probes_mount_no_secrets_and_use_no_service_account_token(self):
        for allowed in [True, False]:
            pod = module().probe_pod("pg-network-probe-abcdef123456", allowed, "172.16.0.22")
            self.assertFalse(pod["spec"]["automountServiceAccountToken"])
            self.assertNotIn("volumes", pod["spec"])
            container = pod["spec"]["containers"][0]
            self.assertNotIn("env", container)
            self.assertNotIn("volumeMounts", container)
            self.assertEqual(container["securityContext"]["capabilities"]["drop"], ["ALL"])
            self.assertEqual(pod["metadata"]["labels"].get("anythingllm-db-maintenance"), "true" if allowed else None)

    def test_refuses_unfamiliar_probe_names(self):
        with self.assertRaises(ValueError):
            module().probe_pod("anythingllm-postgres-0", False, "172.16.0.22")

    def test_reachability_is_not_isolation_success(self):
        checks = {"allowedService": True, "allowedPod": True, "deniedService": True, "deniedPod": True}
        self.assertEqual(module().assess(checks), "UNENFORCED")
        checks.update(deniedService=False, deniedPod=False)
        self.assertEqual(module().assess(checks), "DENIED_IN_THIS_PROBE")
        checks["allowedPod"] = False
        self.assertEqual(module().assess(checks), "INCONCLUSIVE")

    def test_requires_all_positive_and_negative_controls(self):
        with self.assertRaises(ValueError):
            module().assess({"deniedService": False})

    def test_exec_failure_or_dns_failure_is_not_tcp_denial(self):
        for status, output in [(1, ""), (0, ""), (0, "DNS_FAILED\n"), (0, "UNEXPECTED\n")]:
            with self.assertRaises(ValueError):
                module().parse_tcp_result(status, output)
        self.assertTrue(module().parse_tcp_result(0, "TCP_CONNECTED\n"))
        self.assertFalse(module().parse_tcp_result(0, "TCP_BLOCKED\n"))


if __name__ == "__main__":
    unittest.main()
