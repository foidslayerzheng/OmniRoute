"""End-to-end autonomous regression test for MissionOrchestrator.

Proves the system can:
  1. Create a mission with Universal Task Contract
  2. Execute phases autonomously
  3. Survive wrong-host attempts (fail closed)
  4. Survive provider interruptions (recover)
  5. Execute transactional operations (rollback on failure)
  6. Complete and finalize (terminal)
  7. Refuse to restart after finalization
  8. Lose a worker, recover, resume without duplication
"""

import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from src.mission_orchestrator import (
    BoundedRetryExhausted,
    MissionOrchestrator,
    TaskContract,
    TaskContractError,
    WrongHostError,
    TransactionRolledBack,
    get_host_id,
)
from src.mission_state import (
    FinalizedError,
    GenerationConflictError,
    MissionState,
    NonExecutableError,
    ReconciliationRequiredError,
)


class TestUniversalTaskContract(unittest.TestCase):
    """TaskContract must carry verifiable identity, not opaque strings."""

    def test_contract_creation_with_required_fields(self):
        """Contract requires task_id, description, owner, host_id, expected_host."""
        c = TaskContract(
            task_id="task-001",
            description="Test mission",
            owner="louis",
            host_id="vps-1",
            expected_host="vps-1",
        )
        self.assertEqual(c.task_id, "task-001")
        self.assertEqual(c.owner, "louis")
        self.assertTrue(c.verify_host("vps-1"))
        self.assertFalse(c.verify_host("pc-1"))

    def test_contract_rejects_empty_fields(self):
        """Empty task_id, description, owner, host_id, or expected_host
        must raise TaskContractError."""
        for field in ("task_id", "description", "owner", "host_id",
                      "expected_host"):
            kwargs = {
                "task_id": "t", "description": "d", "owner": "o",
                "host_id": "h", "expected_host": "h",
            }
            kwargs[field] = ""
            with self.assertRaises(TaskContractError):
                TaskContract(**kwargs)

    def test_contract_roundtrip(self):
        """Contract survives save/load roundtrip."""
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "contract.json"
            c = TaskContract(
                task_id="task-002",
                description="Roundtrip",
                owner="louis",
                host_id="lois",
                expected_host="lois",
            )
            c.save(path)
            loaded = TaskContract.load(path)
            self.assertEqual(loaded.task_id, "task-002")
            self.assertEqual(loaded.host_id, "lois")
            self.assertTrue(loaded.verify_host("lois"))


class TestWrongHostEnforcement(unittest.TestCase):
    """Mission must refuse to execute on wrong host."""

    def test_wrong_host_rejected_on_startup(self):
        """If expected_host != running host, startup must fail."""
        with tempfile.TemporaryDirectory() as td:
            orch = MissionOrchestrator(
                state_path=Path(td) / "state.json",
                evidence_dir=Path(td) / "evidence",
            )
            # Create mission on current host
            orch.create_mission(
                description="Wrong-host test",
                owner="louis",
            )
            # Tamper: change expected_host in contract
            contract = TaskContract.load(Path(td) / "state.contract.json")
            contract._expected_host = "wrong-host"
            contract.save(Path(td) / "state.contract.json")

            # Startup in new orchestrator — should fail
            orch2 = MissionOrchestrator(
                state_path=Path(td) / "state.json",
                evidence_dir=Path(td) / "evidence",
                contract_path=Path(td) / "state.contract.json",
            )
            with self.assertRaises(WrongHostError):
                orch2.startup()

    def test_wrong_host_rejected_on_startup(self):
        """If expected_host != running host, startup must fail."""
        with tempfile.TemporaryDirectory() as td:
            orch = MissionOrchestrator(
                state_path=Path(td) / "state.json",
                evidence_dir=Path(td) / "evidence",
            )
            # Create mission on current host
            orch.create_mission(
                description="Wrong-host test",
                owner="louis",
            )
            # Tamper: change expected_host in contract
            contract = TaskContract.load(Path(td) / "state.contract.json")
            contract._expected_host = "wrong-host"
            contract.save(Path(td) / "state.contract.json")

            # Startup in new orchestrator — should fail
            orch2 = MissionOrchestrator(
                state_path=Path(td) / "state.json",
                evidence_dir=Path(td) / "evidence",
                contract_path=Path(td) / "state.contract.json",
            )
            with self.assertRaises(WrongHostError):
                orch2.startup()

    def test_wrong_host_rejected_on_phase_transition(self):
        """Phase transitions verify host even after successful startup.
        Simulate host identity change between startup and operation by
        patching get_host_id to return a different value."""
        with tempfile.TemporaryDirectory() as td:
            orch = MissionOrchestrator(
                state_path=Path(td) / "state.json",
                evidence_dir=Path(td) / "evidence",
            )
            orch.create_mission(description="host-check", owner="louis")
            orch.activate()

            # Simulate host identity drift (e.g. container migration)
            with patch("src.mission_orchestrator.get_host_id",
                       return_value="wrong-host"):
                with self.assertRaises(WrongHostError):
                    orch.begin_phase("work")


class TestBoundedRetry(unittest.TestCase):
    """Operations must retry with bounded exponential backoff."""

    def test_operation_succeeds_on_first_try(self):
        """Successful operation returns immediately."""
        with tempfile.TemporaryDirectory() as td:
            orch = MissionOrchestrator(
                state_path=Path(td) / "state.json",
                evidence_dir=Path(td) / "evidence",
            )
            orch.create_mission(description="retry-test", owner="louis")
            orch.activate()

            result = orch.execute_with_retry(lambda: "success")
            self.assertEqual(result, "success")

    def test_operation_retries_on_failure(self):
        """Failing operation retries up to max_retries, then transitions
        to RECOVERY_REQUIRED."""
        call_count = [0]

        def flaky():
            call_count[0] += 1
            raise RuntimeError(f"Failure #{call_count[0]}")

        with tempfile.TemporaryDirectory() as td:
            orch = MissionOrchestrator(
                state_path=Path(td) / "state.json",
                evidence_dir=Path(td) / "evidence",
                max_retries=3,
                base_backoff_s=0.01,
            )
            orch.create_mission(description="retry-exhaust", owner="louis")
            orch.activate()

            with self.assertRaises(BoundedRetryExhausted):
                orch.execute_with_retry(flaky)

            # All 3 attempts should have been made
            self.assertEqual(call_count[0], 3)
            # State should now be RECOVERY_REQUIRED
            self.assertEqual(orch.state.state, "RECOVERY_REQUIRED")

    def test_bounded_retry_recovery_persists_evidence(self):
        """After retry exhaustion, evidence of interruption is persisted."""
        def always_fail():
            raise RuntimeError("provider down")

        with tempfile.TemporaryDirectory() as td:
            evidence_dir = Path(td) / "evidence"
            orch = MissionOrchestrator(
                state_path=Path(td) / "state.json",
                evidence_dir=evidence_dir,
                max_retries=2,
                base_backoff_s=0.01,
            )
            orch.create_mission(description="evidence-test", owner="louis")
            orch.activate()

            with self.assertRaises(BoundedRetryExhausted):
                orch.execute_with_retry(always_fail)

            # Evidence of interruption should be in metadata
            meta = orch.state.metadata
            self.assertEqual(meta["recovery_reason"], "provider_interruption")
            self.assertEqual(meta["failed_phase"], "operation")
            self.assertIn("error_message", meta)


class TestTransactionalOperations(unittest.TestCase):
    """Multi-step transactions must rollback atomically on failure."""

    def test_successful_transaction(self):
        """All steps complete, results returned."""
        with tempfile.TemporaryDirectory() as td:
            orch = MissionOrchestrator(
                state_path=Path(td) / "state.json",
                evidence_dir=Path(td) / "evidence",
            )
            orch.create_mission(description="txn-test", owner="louis")
            orch.activate()

            results = orch.execute_transaction([
                lambda: {"step": "a", "value": 1},
                lambda: {"step": "b", "value": 2},
                lambda: {"step": "c", "value": 3},
            ], transaction_name="success-txn")

            self.assertEqual(len(results), 3)
            self.assertTrue(all(r["status"] == "completed" for r in results))
            self.assertEqual(orch.state.state, "ACTIVE")

    def test_failed_transaction_rolls_back(self):
        """Middle step failure records evidence and transitions to
        RECOVERY_REQUIRED."""
        call_count = [0]

        def step_ok():
            call_count[0] += 1
            return {"ok": True}

        def step_fail():
            call_count[0] += 1
            raise ValueError("step 2 failed")

        with tempfile.TemporaryDirectory() as td:
            evidence_dir = Path(td) / "evidence"
            orch = MissionOrchestrator(
                state_path=Path(td) / "state.json",
                evidence_dir=evidence_dir,
            )
            orch.create_mission(description="txn-rollback", owner="louis")
            orch.activate()

            with self.assertRaises(TransactionRolledBack) as ctx:
                orch.execute_transaction([
                    step_ok,
                    step_fail,
                    step_ok,
                ], transaction_name="fail-txn")

            # Step 0 completed, step 1 failed
            self.assertEqual(call_count[0], 2)
            # State is RECOVERY_REQUIRED
            self.assertEqual(orch.state.state, "RECOVERY_REQUIRED")

            # Evidence file was written
            evidence_files = list(evidence_dir.glob("transaction-fail-txn-*.json"))
            self.assertEqual(len(evidence_files), 1)
            evidence = json.loads(evidence_files[0].read_text())
            self.assertEqual(evidence["transaction_name"], "fail-txn")
            self.assertEqual(evidence["steps_completed"], 1)


class TestFinalizedTerminal(unittest.TestCase):
    """FINALIZED must be truly terminal — no transitions possible."""

    def test_finalize_prevents_further_transitions(self):
        """After finalize(), no operation can proceed."""
        with tempfile.TemporaryDirectory() as td:
            orch = MissionOrchestrator(
                state_path=Path(td) / "state.json",
                evidence_dir=Path(td) / "evidence",
            )
            orch.create_mission(description="finalize-test", owner="louis")
            orch.activate()
            orch.finalize(reason="done")

            self.assertTrue(orch.state.is_finalized())

            # Cannot begin phase
            with self.assertRaises(FinalizedError):
                orch.begin_phase("work")

            # Cannot execute transaction
            with self.assertRaises(FinalizedError):
                orch.execute_transaction([lambda: {}])

            # Cannot retry
            with self.assertRaises(FinalizedError):
                orch.execute_with_retry(lambda: "x")

    def test_finalize_prevents_restart(self):
        """After finalize(), startup() refuses to restart."""
        with tempfile.TemporaryDirectory() as td:
            orch = MissionOrchestrator(
                state_path=Path(td) / "state.json",
                evidence_dir=Path(td) / "evidence",
            )
            orch.create_mission(description="no-restart", owner="louis")
            orch.activate()
            orch.finalize(reason="complete")

            # New orchestrator cannot restart
            orch2 = MissionOrchestrator(
                state_path=Path(td) / "state.json",
                evidence_dir=Path(td) / "evidence",
                contract_path=Path(td) / "state.contract.json",
            )
            with self.assertRaises(FinalizedError):
                orch2.startup()


class TestStaleStatePrevention(unittest.TestCase):
    """Stale/older generation state must not overwrite newer state."""

    def test_stale_generation_save_rejected(self):
        """Saving state with generation <= on-disk generation must fail."""
        with tempfile.TemporaryDirectory() as td:
            state_path = Path(td) / "state.json"

            # Write generation=5
            ms = MissionState(generation=5, state="ACTIVE", version="v1")
            ms.save(state_path)

            # Try to write generation=3 (stale)
            stale = MissionState(generation=3, state="ACTIVE", version="v2")
            with self.assertRaises(GenerationConflictError):
                stale.save(state_path)

            # Original must be unchanged
            loaded = MissionState.load(state_path)
            self.assertEqual(loaded.generation, 5)


class TestEndToEndAutonomousRegression(unittest.TestCase):
    """Full end-to-end: create -> activate -> phase work -> provider
    interruption -> recovery -> resume -> finalize.

    Proves the system can lose a worker/provider, recover, resume
    without duplication, finish, and finalize without Louis.
    """

    def test_full_autonomous_lifecycle_with_recovery(self):
        """Simulates: create mission, do work, hit provider failure,
        recover, resume, finalize."""
        with tempfile.TemporaryDirectory() as td:
            state_path = Path(td) / "state.json"
            evidence_dir = Path(td) / "evidence"
            contract_path = Path(td) / "contract.json"

            # === PHASE 1: Create mission ===
            orch = MissionOrchestrator(
                state_path=state_path,
                evidence_dir=evidence_dir,
                contract_path=contract_path,
                max_retries=2,
                base_backoff_s=0.01,
            )
            contract = orch.create_mission(
                description="End-to-end autonomous lifecycle",
                owner="louis",
            )
            self.assertEqual(orch.state.state, "CREATED")
            self.assertEqual(orch.state.generation, 1)
            self.assertFalse(orch.state.is_finalized())

            # === PHASE 2: Activate ===
            orch.activate()
            self.assertEqual(orch.state.state, "ACTIVE")
            self.assertEqual(orch.state.generation, 2)
            self.assertTrue(orch.state.executable)

            # === PHASE 3: Begin work phase ===
            orch.begin_phase("data-collection")
            self.assertEqual(orch.state.state, "PHASE:data-collection")
            self.assertEqual(orch.state.generation, 3)

            # === PHASE 4: Complete work phase ===
            orch.complete_phase()
            self.assertEqual(orch.state.state, "ACTIVE")
            self.assertEqual(orch.state.generation, 4)

            # === PHASE 5: Provider interruption during next phase ===
            orch.begin_phase("analysis")
            self.assertEqual(orch.state.state, "PHASE:analysis")
            self.assertEqual(orch.state.generation, 5)

            # Simulate provider failure
            with self.assertRaises(BoundedRetryExhausted):
                orch.execute_with_retry(
                    lambda: (_ for _ in ()).throw(
                        ConnectionError("API timeout")
                    ),
                    phase_name="analysis",
                )

            # State should now be RECOVERY_REQUIRED
            self.assertEqual(orch.state.state, "RECOVERY_REQUIRED")
            self.assertFalse(orch.state.executable)

            # Verify evidence was written
            meta = orch.state.metadata
            self.assertEqual(meta["recovery_reason"], "provider_interruption")
            self.assertEqual(meta["failed_phase"], "analysis")

            # === PHASE 6: Recovery — write evidence and reconcile ===
            # Simulate PC writing evidence that VPS can pick up
            # Fixture setup: create directory boundary before fixture writes
            evidence_dir.mkdir(parents=True, exist_ok=True)
            # The evidence must have a higher generation to reconcile
            # if we use the CAS check 'generation > disk_generation'.
            evidence_data = {
                "generation": orch.state.generation + 1,
                "state": "ACTIVE",
                "version": orch.state.version,
                "task_id": contract.task_id,
                "recovered_from": "provider_interruption",
                "recovered_at": time.strftime(
                    "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                ),
            }
            evidence_path = evidence_dir / "authoritative.json"
            evidence_path.write_text(
                json.dumps(evidence_data), encoding="utf-8"
            )

            # === PHASE 7: Restart from disk (simulate VPS restart) ===
            orch2 = MissionOrchestrator(
                state_path=state_path,
                evidence_dir=evidence_dir,
                contract_path=contract_path,
            )
            recovered = orch2.startup()

            # After recovery, state should be ACTIVE (reconciled)
            self.assertEqual(recovered.state, "ACTIVE")
            self.assertTrue(recovered.executable)

            # === PHASE 8: Resume work without duplication ===
            orch2.begin_phase("report-generation")
            self.assertEqual(orch2.state.state, "PHASE:report-generation")
            # Generation must have advanced (no stale overwrite)
            self.assertGreater(orch2.state.generation, 5)

            orch2.complete_phase()
            self.assertEqual(orch2.state.state, "ACTIVE")

            # === PHASE 9: Finalize ===
            orch2.finalize(reason="all phases complete")
            self.assertTrue(orch2.state.is_finalized())
            self.assertFalse(orch2.state.executable)

            # === PHASE 10: Verify finalization is permanent ===
            orch3 = MissionOrchestrator(
                state_path=state_path,
                evidence_dir=evidence_dir,
                contract_path=contract_path,
            )
            with self.assertRaises(FinalizedError):
                orch3.startup()

            # Final state on disk must be FINALIZED
            final = MissionState.load(state_path)
            self.assertTrue(final.is_finalized())
            self.assertEqual(final.metadata["finalized_reason"],
                           "all phases complete")


if __name__ == "__main__":
    unittest.main(verbosity=2)
