import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HARNESS = ROOT / "tests/offline/run_broad_offline_shards.sh"


class OfflineHarnessBehaviorTests(unittest.TestCase):
    def run_harness(self, shards, fixture_sources, *, extra_env=None, timeout=45, cwd=ROOT):
        created = []
        with tempfile.TemporaryDirectory(prefix="offline-harness-test-") as td:
            temp = Path(td)
            result_dir = temp / "results"
            shard_list = temp / "shards.txt"
            for relative, source in fixture_sources.items():
                path = ROOT / relative
                self.assertFalse(path.exists(), f"fixture path unexpectedly exists: {relative}")
                path.write_text(textwrap.dedent(source))
                created.append(path)
            shard_list.write_text("".join(f"{item}\n" for item in shards))
            env = os.environ.copy()
            env.update(
                {
                    "OFFLINE_SHARD_LIST_FILE": str(shard_list),
                    "OFFLINE_RESULTS_DIR": str(result_dir),
                    "OFFLINE_SKIP_FOCUSED": "1",
                }
            )
            if extra_env:
                env.update(extra_env)
            try:
                result = subprocess.run(
                    ["bash", str(HARNESS)],
                    cwd=cwd,
                    env=env,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    timeout=timeout,
                )
                manifest = []
                manifest_path = result_dir / "manifest.jsonl"
                if manifest_path.exists():
                    manifest = [json.loads(line) for line in manifest_path.read_text().splitlines() if line]
                outputs = {
                    path.name: path.read_text(errors="replace")
                    for path in result_dir.glob("*.log")
                } if result_dir.exists() else {}
                return result, manifest, outputs
            finally:
                for path in created:
                    path.unlink(missing_ok=True)

    def test_canary_only_proves_controls_without_starting_shards(self):
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

    def test_shard_gets_fresh_home_and_no_provider_or_machine_state(self):
        relative = "tests/offline/.harness-fixture-home.py"
        source = """
            import os, pathlib, unittest
            class Isolation(unittest.TestCase):
                def test_isolated(self):
                    home = pathlib.Path.home()
                    self.assertIn('offline-home-', home.name)
                    self.assertFalse((home / '.machine-sentinel').exists())
                    forbidden = ('OPENAI', 'ANTHROPIC', 'GEMINI', 'GOOGLE_API', 'AWS_SECRET', 'AZURE')
                    self.assertFalse(any(any(tag in key.upper() for tag in forbidden) for key in os.environ))
            if __name__ == '__main__': unittest.main()
        """
        result, manifest, outputs = self.run_harness(
            [relative], {relative: source},
            extra_env={"OPENAI_API_KEY": "synthetic-must-not-propagate"},
        )
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(len(manifest), 1)
        self.assertEqual(manifest[0]["status"], "PASS")
        self.assertEqual(manifest[0]["executed_tests"], 1)
        self.assertEqual(manifest[0]["skipped_tests"], 0)
        self.assertTrue(outputs)

    def test_manifest_records_exact_path_command_exit_duration_counts_and_output(self):
        relative = "tests/offline/.harness-fixture-record.py"
        source = """
            import unittest
            class Recorded(unittest.TestCase):
                def test_one(self): print('PRESERVED-SHARD-OUTPUT')
                @unittest.skip('fixture skip')
                def test_skip(self): pass
            if __name__ == '__main__': unittest.main(verbosity=2)
        """
        result, manifest, outputs = self.run_harness([relative], {relative: source})
        self.assertEqual(result.returncode, 0, result.stdout)
        record = manifest[0]
        self.assertEqual(record["path"], relative)
        self.assertEqual(record["exit_status"], 0)
        self.assertEqual(record["total_tests"], 2)
        self.assertEqual(record["executed_tests"], 1)
        self.assertEqual(record["skipped_tests"], 1)
        self.assertIsInstance(record["duration_ms"], int)
        self.assertGreaterEqual(record["duration_ms"], 0)
        self.assertLess(record["duration_ms"], 45_000)
        self.assertIn(relative, record["command"])
        self.assertIn("PRESERVED-SHARD-OUTPUT", "\n".join(outputs.values()))

    def test_empty_explicit_shard_list_fails_closed(self):
        result, manifest, _ = self.run_harness([], {})
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("zero shards", result.stdout.lower())
        self.assertFalse(manifest)

    def test_nonpositive_or_invalid_timeout_fails_before_shards(self):
        relative = "tests/offline/.harness-fixture-timeout.py"
        source = "import unittest\nif __name__ == '__main__': unittest.main()\n"
        for value in ("0", "-1", "not-a-duration"):
            with self.subTest(value=value):
                result, manifest, _ = self.run_harness(
                    [relative], {relative: source},
                    extra_env={"OFFLINE_SHARD_TIMEOUT_SECONDS": value},
                )
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn("OFFLINE_SHARD_TIMEOUT_SECONDS", result.stdout)
                self.assertFalse(manifest)

    def test_exit_zero_with_zero_tests_fails_closed(self):
        relative = "tests/offline/.harness-fixture-zero.py"
        result, manifest, _ = self.run_harness([relative], {relative: "print('no tests here')\n"})
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(manifest[0]["status"], "FAIL_ZERO_TESTS")
        self.assertEqual(manifest[0]["executed_tests"], 0)

    def test_python_output_cannot_forge_test_accounting(self):
        relative = "tests/offline/.harness-fixture-forged-count.py"
        source = "print('Ran 1 test')\n"
        result, manifest, _ = self.run_harness([relative], {relative: source})
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(manifest[0]["status"], "FAIL_ZERO_TESTS")
        self.assertEqual(manifest[0]["total_tests"], 0)
        self.assertEqual(manifest[0]["executed_tests"], 0)

    def test_exit_zero_with_only_skips_fails_closed(self):
        relative = "tests/offline/.harness-fixture-skips.py"
        source = """
            import unittest
            class Skips(unittest.TestCase):
                @unittest.skip('offline-inapplicable')
                def test_skip(self): pass
            if __name__ == '__main__': unittest.main()
        """
        result, manifest, _ = self.run_harness([relative], {relative: source})
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(manifest[0]["status"], "FAIL_ONLY_SKIPPED")
        self.assertEqual(manifest[0]["executed_tests"], 0)
        self.assertEqual(manifest[0]["skipped_tests"], 1)

    def test_rejects_absolute_parent_and_ambiguous_basename_paths(self):
        for invalid in ("/tmp/not-a-shard.py", "../outside.py", "test_ssh_retry.py"):
            with self.subTest(invalid=invalid):
                result, manifest, _ = self.run_harness([invalid], {})
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertFalse(manifest)
                self.assertIn("exact repo-relative path", result.stdout)

    def test_rejects_symlink_shard_that_resolves_outside_repository(self):
        relative = "tests/offline/.harness-fixture-escape.py"
        with tempfile.TemporaryDirectory(prefix="offline-harness-outside-") as td:
            outside = Path(td) / "outside.py"
            outside.write_text("raise SystemExit('must not execute')\n")
            link = ROOT / relative
            link.symlink_to(outside)
            try:
                result, manifest, _ = self.run_harness([relative], {})
            finally:
                link.unlink(missing_ok=True)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("symlink", result.stdout.lower())
        self.assertFalse(manifest)

    def test_existing_manifest_symlink_is_rejected_without_truncating_target(self):
        with tempfile.TemporaryDirectory(prefix="offline-harness-results-") as td:
            temp = Path(td)
            results = temp / "results"
            results.mkdir()
            target = temp / "sentinel.txt"
            target.write_text("PRESERVE-ME")
            (results / "manifest.jsonl").symlink_to(target)
            shard_list = temp / "shards.txt"
            shard_list.write_text("")
            env = os.environ.copy()
            env.update({
                "OFFLINE_SHARD_LIST_FILE": str(shard_list),
                "OFFLINE_RESULTS_DIR": str(results),
                "OFFLINE_SKIP_FOCUSED": "1",
            })
            result = subprocess.run(
                ["bash", str(HARNESS)], cwd=ROOT, env=env, text=True,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30,
            )
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertEqual(target.read_text(), "PRESERVE-ME")

    def test_missing_canary_dependency_is_tooling_error_not_network_block(self):
        env = os.environ.copy()
        env["OFFLINE_CANARY_ONLY"] = "1"
        env["OFFLINE_PREFLIGHT_EXTRA_TOOL"] = "definitely-missing-offline-tool"
        result = subprocess.run(
            ["bash", str(HARNESS)], cwd=ROOT, env=env, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30,
        )
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("PREFLIGHT FAILURE", result.stdout)
        self.assertIn("definitely-missing-offline-tool", result.stdout)
        self.assertNotIn("definitely-missing-offline-tool: BLOCKED", result.stdout)

    def test_node_runtime_resolves_before_fresh_home_replaces_caller_home(self):
        node = Path.home() / ".hermes/node/bin/node"
        if not node.is_file():
            self.skipTest(f"Hermes node runtime unavailable: {node}")
        result, manifest, _ = self.run_harness(
            ["tests/unit/evals-route.test.ts"], {}
        )
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(manifest[0]["status"], "PASS")
        self.assertIn(str(node), manifest[0]["command"])

    def test_node_loader_resolves_from_repo_outside_caller_working_directory(self):
        node = Path.home() / ".hermes/node/bin/node"
        if not node.is_file():
            self.skipTest(f"Hermes node runtime unavailable: {node}")
        with tempfile.TemporaryDirectory(prefix="offline-harness-cwd-") as cwd:
            result, manifest, _ = self.run_harness(
                ["tests/unit/evals-route.test.ts"], {}, cwd=cwd
            )
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(manifest[0]["status"], "PASS")


if __name__ == "__main__":
    unittest.main(verbosity=2)
