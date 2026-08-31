import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts/automation/ssh-retry.sh"


class SshRetryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.count = self.dir / "count"
        self.sleeps = self.dir / "sleeps"
        self.fake = self.dir / "fake"
        self.sleep = self.dir / "sleep"
        self.sleep.write_text("#!/bin/sh\nprintf '%s\\n' \"$1\" >>\"$SLEEPS\"\n")
        self.sleep.chmod(0o700)

    def tearDown(self):
        self.tmp.cleanup()

    def run_case(self, statuses, messages, attempts="3", initial="1", cap="8"):
        self.fake.write_text("""#!/bin/sh
n=0; test ! -f "$COUNT" || n=$(cat "$COUNT"); n=$((n+1)); printf '%s' "$n" >"$COUNT"
status=$(printf '%s' "$STATUSES" | cut -d, -f"$n"); msg=$(printf '%s' "$MESSAGES" | cut -d'|' -f"$n")
printf '%s\\n' "$msg" >&2; exit "$status"
""")
        self.fake.chmod(0o700)
        env = os.environ | {
            "COUNT": str(self.count), "SLEEPS": str(self.sleeps),
            "STATUSES": statuses, "MESSAGES": messages,
            "SSH_RETRY_ATTEMPTS": attempts, "SSH_RETRY_INITIAL_DELAY": initial,
            "SSH_RETRY_MAX_DELAY": cap, "SSH_RETRY_SLEEP_CMD": str(self.sleep),
        }
        command = f". {HELPER!s}; ssh_retry_run -- {self.fake!s}"
        return subprocess.run(["bash", "-c", command], env=env, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def test_transient_failures_retry_with_bounded_exponential_backoff(self):
        result = self.run_case("255,255,0", "Connection timed out|Connection reset by peer|ok")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.count.read_text(), "3")
        self.assertEqual(self.sleeps.read_text().splitlines(), ["1", "2"])

    def test_backoff_is_capped_and_attempts_are_bounded(self):
        result = self.run_case("255,255,255,255", "Connection refused|Connection refused|Connection refused|Connection refused", attempts="4", initial="3", cap="4")
        self.assertEqual(result.returncode, 255)
        self.assertEqual(self.count.read_text(), "4")
        self.assertEqual(self.sleeps.read_text().splitlines(), ["3", "4", "4"])

    def test_auth_and_host_key_errors_are_permanent(self):
        for message in ("Permission denied (publickey).", "Host key verification failed."):
            with self.subTest(message=message):
                self.count.unlink(missing_ok=True); self.sleeps.unlink(missing_ok=True)
                result = self.run_case("255", message)
                self.assertEqual(result.returncode, 255)
                self.assertEqual(self.count.read_text(), "1")
                self.assertFalse(self.sleeps.exists())

    def test_unknown_255_fails_closed_without_retry(self):
        result = self.run_case("255", "unrecognized ssh failure")
        self.assertEqual(result.returncode, 255)
        self.assertEqual(self.count.read_text(), "1")
        self.assertIn("classification=permanent_unknown", result.stderr)

    def test_remote_command_failure_is_not_retried(self):
        result = self.run_case("23", "remote command failed")
        self.assertEqual(result.returncode, 23)
        self.assertEqual(self.count.read_text(), "1")
        self.assertIn("classification=permanent_remote_command", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
