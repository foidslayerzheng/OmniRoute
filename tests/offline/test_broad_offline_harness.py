import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HARNESS = ROOT / "tests/offline/run_broad_offline_shards.sh"


class OfflineHarnessContractTests(unittest.TestCase):
    def test_canary_only_proves_all_required_controls_without_starting_shards(self):
        env = os.environ.copy()
        env["OFFLINE_CANARY_ONLY"] = "1"
        result = subprocess.run(
            ["bash", str(HARNESS)], cwd=ROOT, env=env, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout)
        for proof in (
            "CANARY literal-external-ip: BLOCKED",
            "CANARY external-dns: BLOCKED",
            "CANARY provider-https: BLOCKED",
            "CANARY independent-udp: BLOCKED",
            "CANARY provider-credentials: ABSENT",
            "CANARY local-command: PASS",
            "CANARY-ONLY COMPLETE — no shards started",
        ):
            self.assertIn(proof, result.stdout)
        self.assertNotIn("Running focused offline tests", result.stdout)
        self.assertNotIn("Running broad offline shards", result.stdout)

    def test_child_environment_uses_required_runtime_but_no_provider_credentials(self):
        text = HARNESS.read_text()
        self.assertIn("PATH=", text)
        self.assertIn("HOME=", text)
        self.assertNotIn("API_KEY=REDACTED", text)
        self.assertNotIn("API_TOKEN=REDACTED", text)

    def test_timeouts_execute_inside_namespace(self):
        text = HARNESS.read_text()
        self.assertNotIn("timeout 30 run_in_ns", text)
        self.assertNotIn("timeout 60 run_in_ns", text)
        self.assertIn("run_in_ns timeout", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
