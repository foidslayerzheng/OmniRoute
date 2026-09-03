"""Durability regression tests for mission_state module.

Historical regressions:
  1. test_recovery_with_no_evidence_creates_minimal_state
  2. test_concurrent_writer_does_not_corrupt_state
  3. test_stale_generation_cannot_overwrite_finalized_or_higher

These enforce:
  - Monotonic state generation/version
  - Expected-version/CAS write protection
  - Exclusive mutation locking
  - Atomic temp write -> fsync -> rename -> directory fsync
  - Stale writers fail before mutation
  - FINALIZED is terminal
  - Replicas cannot overwrite newer authoritative state
  - Insufficient recovery evidence fails closed
  - Recovery provenance is persisted
"""

import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path

# Import the module under test — must exist as src/mission_state.py
from src.mission_state import (
    MissionState,
    load_or_create,
    save,
    recover,
)


class TestRecoveryWithNoEvidenceCreatesMinimalState(unittest.TestCase):
    """When no authoritative evidence exists, recovery must create a
    RECOVERY_REQUIRED / non-runnable state with generation=1 and
    executable=False.  A reconstructed minimal state must NOT be an
    executable normal mission state.  Only an explicit verified
    reconciliation path may promote it into executable mission state."""

    def test_recovery_with_no_evidence_creates_minimal_state(self):
        with tempfile.TemporaryDirectory() as td:
            state_path = Path(td) / "mission-state.json"
            evidence_dir = Path(td) / "evidence"
            self.assertFalse(evidence_dir.exists())

            ms = recover(state_path, evidence_dir)
            self.assertIsInstance(ms, MissionState)
            self.assertEqual(ms.generation, 1)
            self.assertEqual(ms.state, "RECOVERY_REQUIRED")
            self.assertFalse(ms.is_finalized())
            self.assertFalse(ms.executable)

            # State file must have been persisted
            self.assertTrue(state_path.exists())
            loaded = MissionState.load(state_path)
            self.assertEqual(loaded.generation, 1)
            self.assertEqual(loaded.state, "RECOVERY_REQUIRED")
            self.assertFalse(loaded.executable)

            # Recovery provenance must be recorded
            self.assertIn("recovery_provenance", loaded.metadata)
            prov = loaded.metadata["recovery_provenance"]
            self.assertEqual(prov["evidence_count"], 0)
            self.assertFalse(prov["evidence_dir_existed"])
            self.assertTrue(prov["failure_closed"])
            self.assertIn("recovered_at", prov)

    def test_continuation_fails_closed_from_recovery_required_state(self):
        """A continuation / phase transition from RECOVERY_REQUIRED must fail
        closed.  Only an explicit verified reconciliation may promote it."""
        with tempfile.TemporaryDirectory() as td:
            state_path = Path(td) / "mission-state.json"
            evidence_dir = Path(td) / "evidence"
            evidence_dir.mkdir()

            ms = recover(state_path, evidence_dir)
            self.assertEqual(ms.state, "RECOVERY_REQUIRED")
            self.assertFalse(ms.executable)

            # Attempt to transition state — must raise
            with self.assertRaises(Exception) as ctx:
                ms.continue_mission(next_state="running")
            self.assertIn("recovery_required", str(ctx.exception).lower())

            # Attempt to mark executable directly — must raise
            with self.assertRaises(Exception) as ctx2:
                ms.promote_to_executable(reason="manual override")
            self.assertIn("reconciliation", str(ctx2.exception).lower())

            # Attempt via explicit reconcile with no evidence — must fail closed
            with self.assertRaises(Exception) as ctx3:
                ms.reconcile(evidence_dir, verification_token=None)
            self.assertIn("reconciliation", str(ctx3.exception).lower())

            # On-disk state must remain RECOVERY_REQUIRED / not executable
            final = MissionState.load(state_path)
            self.assertEqual(final.state, "RECOVERY_REQUIRED")
            self.assertFalse(final.executable)

    def test_valid_reconciliation_promotes_to_executable(self):
        """With authoritative evidence + correct token, reconcile promotes to
        executable normal state."""
        with tempfile.TemporaryDirectory() as td:
            state_path = Path(td) / "mission-state.json"
            evidence_dir = Path(td) / "evidence"
            evidence_dir.mkdir()

            # Create authoritative evidence
            evidence = {
                "generation": 3,
                "state": "running",
                "version": "abc123def456",
                "metadata": {},
            }
            (evidence_dir / "authoritative.json").write_text(
                json.dumps(evidence)
            )

            ms = recover(state_path, evidence_dir)
            self.assertEqual(ms.state, "running")
            self.assertTrue(ms.executable)
            self.assertEqual(ms.generation, 3)


class TestConcurrentWriterDoesNotCorruptState(unittest.TestCase):
    """Two writers concurrently incrementing generation must not corrupt the
    state file. Each writer must use exclusive locking and CAS — exactly one
    succeeds per generation step, and the final file must contain a valid
    monotonic sequence with no data loss."""

    def test_concurrent_writer_does_not_corrupt_state(self):
        with tempfile.TemporaryDirectory() as td:
            state_path = Path(td) / "mission-state.json"
            evidence_dir = Path(td) / "evidence"
            evidence_dir.mkdir()
            # Seed with initial state
            ms = MissionState.create(generation=1, state="created")
            ms.save(state_path)

            NUM_WRITERS = 8
            INCREMENTS = 5
            errors = []

            def writer(worker_id):
                try:
                    for i in range(INCREMENTS):
                        for attempt in range(20):  # bounded retry
                            loaded = MissionState.load(state_path)
                            new_gen = loaded.generation + 1
                            new_ms = loaded.with_updates(
                                generation=new_gen,
                                metadata={"worker": worker_id, "step": i},
                            )
                            try:
                                new_ms.save(state_path, expected_generation=loaded.generation)
                                break
                            except Exception:
                                time.sleep(0.001)
                except Exception as e:
                    errors.append(e)

            threads = [threading.Thread(target=writer, args=(w,)) for w in range(NUM_WRITERS)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=30)

            self.assertEqual(errors, [], f"Writer errors: {errors}")

            # Final state must be readable and have correct generation
            final = MissionState.load(state_path)
            expected_gen = 1 + NUM_WRITERS * INCREMENTS
            self.assertEqual(final.generation, expected_gen)
            # File must not be corrupted JSON
            raw = json.loads(state_path.read_text())
            self.assertEqual(raw["generation"], expected_gen)
            self.assertIn("version", raw)


class TestStaleGenerationCannotOverwriteFinalizedOrHigher(unittest.TestCase):
    """A writer holding an older generation must not be able to save over a
    state that has advanced to a higher generation, especially FINALIZED.
    This preserves the invariant from historical evidence where a stale
    phase=0 writer tried to overwrite a FINALIZED state."""

    def test_stale_generation_cannot_overwrite_finalized_or_higher(self):
        with tempfile.TemporaryDirectory() as td:
            state_path = Path(td) / "mission-state.json"
            evidence_dir = Path(td) / "evidence"
            evidence_dir.mkdir()

            # Create and finalize a state at generation 5
            ms5 = MissionState.create(generation=5, state="running")
            for i in range(5):
                ms5 = ms5.with_updates(generation=i + 1, state="running" if i < 4 else "FINALIZED")
            ms5.save(state_path)
            self.assertTrue(ms5.is_finalized())

            # A stale writer reads an old copy at generation 3
            stale_ms = MissionState.create(generation=3, state="created")

            # Attempt 1: CAS write with expected_generation=3 must fail
            with self.assertRaises(Exception) as ctx:
                stale_ms.save(state_path, expected_generation=3)
            self.assertIn("generation", str(ctx.exception).lower())

            # Attempt 2: Directly writing generation=4 over FINALIZED must fail
            stale_ms_v2 = stale_ms.with_updates(generation=4)
            with self.assertRaises(Exception) as ctx2:
                stale_ms_v2.save(state_path, expected_generation=3)
            self.assertIn("generation", str(ctx2.exception).lower())

            # The on-disk state must remain unchanged
            final = MissionState.load(state_path)
            self.assertEqual(final.generation, 5)
            self.assertTrue(final.is_finalized())
            self.assertEqual(final.state, "FINALIZED")

    def test_higher_generation_cannot_overwrite_finalized(self):
        """Even a legitimately higher-generation writer must not overwrite
        FINALIZED state — FINALIZED is terminal."""
        with tempfile.TemporaryDirectory() as td:
            state_path = Path(td) / "mission-state.json"
            evidence_dir = Path(td) / "evidence"
            evidence_dir.mkdir()

            ms = MissionState.create(generation=1, state="FINALIZED")
            ms.save(state_path)
            self.assertTrue(ms.is_finalized())

            # A writer with generation=99 tries to overwrite FINALIZED
            high_ms = MissionState.create(generation=99, state="running")
            with self.assertRaises(Exception) as ctx:
                high_ms.save(state_path, expected_generation=1)
            self.assertIn("finalized", str(ctx.exception).lower())

            # State unchanged
            final = MissionState.load(state_path)
            self.assertTrue(final.is_finalized())


if __name__ == "__main__":
    unittest.main(verbosity=2)
