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
        self.fake.write_text(f"""#!/bin/sh
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


class SshRetryConfigBoundsTests(unittest.TestCase):
    """RED→GREEN tests for bounded SSH retry configuration.
    Validates that malformed/out-of-bounds configs fail closed immediately."""

    def _run(self, attempts="3", initial="1", cap="8", command="true"):
        """Run ssh_retry_run with given config and a harmless command."""
        env = os.environ | {
            "SSH_RETRY_ATTEMPTS": attempts,
            "SSH_RETRY_INITIAL_DELAY": initial,
            "SSH_RETRY_MAX_DELAY": cap,
        }
        cmd = f". {HELPER!s}; ssh_retry_run -- {command}"
        return subprocess.run(["bash", "-c", cmd], env=env, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    # --- Attempts bounds ---

    def test_zero_attempts_fails_closed(self):
        result = self._run(attempts="0")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be >= 1", result.stderr)

    def test_negative_attempts_fails_closed(self):
        result = self._run(attempts="-3")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be a non-negative integer", result.stderr)

    def test_non_integer_attempts_fails_closed(self):
        result = self._run(attempts="abc")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be a non-negative integer", result.stderr)

    def test_float_attempts_fails_closed(self):
        result = self._run(attempts="2.5")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be a non-negative integer", result.stderr)

    def test_excessive_attempts_fails_closed(self):
        result = self._run(attempts="11")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be <= 10", result.stderr)

    def test_empty_attempts_fails_closed(self):
        result = self._run(attempts="")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be a non-negative integer", result.stderr)

    def test_attempts_at_ceiling_succeeds(self):
        result = self._run(attempts="10", command="true")
        self.assertEqual(result.returncode, 0)

    # --- Initial delay bounds ---

    def test_non_integer_delay_fails_closed(self):
        result = self._run(initial="abc")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be a non-negative integer", result.stderr)

    def test_negative_delay_fails_closed(self):
        result = self._run(initial="-1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be a non-negative integer", result.stderr)

    def test_zero_delay_allowed(self):
        result = self._run(initial="0", command="true")
        self.assertEqual(result.returncode, 0)

    def test_float_delay_fails_closed(self):
        result = self._run(initial="1.5")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be a non-negative integer", result.stderr)

    # --- Max delay bounds ---

    def test_zero_cap_fails_closed(self):
        result = self._run(cap="0")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be >= 1", result.stderr)

    def test_negative_cap_fails_closed(self):
        result = self._run(cap="-5")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be a positive integer", result.stderr)

    def test_non_integer_cap_fails_closed(self):
        result = self._run(cap="abc")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be a positive integer", result.stderr)

    def test_excessive_cap_fails_closed(self):
        result = self._run(cap="61")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be <= 60", result.stderr)

    def test_cap_at_ceiling_succeeds(self):
        result = self._run(cap="60", command="true")
        self.assertEqual(result.returncode, 0)

    # --- Termination guarantee within finite budget ---

    def test_terminates_within_max_attempts(self):
        """Prove the loop terminates: 5 transient failures with attempts=5
        produces exactly 5 invocations and does not loop forever."""
        case = SshRetryTests()
        case.setUp()
        try:
            result = case.run_case(
                "255,255,255,255,255",
                "Connection timed out|Connection timed out|Connection timed out|Connection timed out|Connection timed out",
                attempts="5", initial="0", cap="1"
            )
            self.assertEqual(result.returncode, 255)
            # 5 attempts, 4 sleeps between them
            self.assertEqual(result.stderr.count("ssh-attempt="), 5)
        finally:
            case.tearDown()

    def test_single_attempt_no_sleep(self):
        """With attempts=1, transient failure produces exactly 1 invocation, no sleep."""
        tmpdir = tempfile.TemporaryDirectory()
        d = Path(tmpdir.name)
        count = d / "count"
        sleeps = d / "sleeps"
        fake = d / "fake"
        sleep_cmd = d / "sleep"
        sleep_cmd.write_text("#!/bin/sh\nprintf '%s\\n' \"$1\" >>\"$SLEEPS\"\n")
        sleep_cmd.chmod(0o700)
        fake.write_text(f"""#!/bin/sh
n=0; test ! -f "{count}" || n=$(cat "{count}"); n=$((n+1)); printf '%s' "$n" >"{count}"
printf 'Connection timed out\\n' >&2; exit 255
""")
        fake.chmod(0o700)
        env = os.environ | {
            "COUNT": str(count), "SLEEPS": str(sleeps),
            "STATUSES": "255", "MESSAGES": "Connection timed out",
            "SSH_RETRY_ATTEMPTS": "1", "SSH_RETRY_INITIAL_DELAY": "1",
            "SSH_RETRY_MAX_DELAY": "8", "SSH_RETRY_SLEEP_CMD": str(sleep_cmd),
        }
        cmd = f". {HELPER!s}; ssh_retry_run -- {fake!s}"
        result = subprocess.run(["bash", "-c", cmd], env=env, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(result.returncode, 255)
        self.assertEqual(count.read_text(), "1")
        self.assertFalse(sleeps.exists())
        tmpdir.cleanup()


if __name__ == "__main__":
    unittest.main(verbosity=2)
