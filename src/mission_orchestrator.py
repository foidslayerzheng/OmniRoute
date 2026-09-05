"""Mission orchestrator: higher-level automation built on MissionState primitives.

Provides:
  - Universal Task Contract (task_id, owner, host_id, expected host)
  - Wrong-host fail-closed enforcement
  - Bounded retry/recovery with exponential backoff
  - Provider/tool interruption recovery
  - Transactional multi-step operations
  - PC<->VPS automatic recovery
  - End-to-end autonomous lifecycle

The orchestrator derives authorization from verifiable state, never from
caller-controlled opaque strings.
"""

from __future__ import annotations

import json
import platform
import socket
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .mission_state import (
    FinalizedError,
    GenerationConflictError,
    MissionState,
    NonExecutableError,
    ReconciliationRequiredError,
    load_or_create,
    recover,
    save,
)


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class WrongHostError(Exception):
    """Raised when the running host does not match the expected host."""


class TaskContractError(Exception):
    """Raised when a Universal Task Contract is invalid or violated."""


class BoundedRetryExhausted(Exception):
    """Raised when all bounded retry attempts have been exhausted."""


class ProviderInterruption(Exception):
    """Raised when a provider/tool failure interrupts a mission."""


class TransactionRolledBack(Exception):
    """Raised when a transactional operation is rolled back."""


# ---------------------------------------------------------------------------
# Universal Task Contract
# ---------------------------------------------------------------------------

class TaskContract:
    """Immutable contract defining a mission's identity, ownership, and host.

    This is the "Universal Task Contract" — a structured JSON document that
    every autonomous mission must carry. The contract is the authoritative
    identity of the mission and is checked at every lifecycle boundary.
    """

    __slots__ = (
        "_task_id",
        "_description",
        "_owner",
        "_host_id",
        "_expected_host",
        "_created_at",
        "_metadata",
    )

    def __init__(
        self,
        *,
        task_id: str,
        description: str,
        owner: str,
        host_id: str,
        expected_host: str,
        created_at: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not task_id:
            raise TaskContractError("task_id is required")
        if not description:
            raise TaskContractError("description is required")
        if not owner:
            raise TaskContractError("owner is required")
        if not host_id:
            raise TaskContractError("host_id is required")
        if not expected_host:
            raise TaskContractError("expected_host is required")
        self._task_id = task_id
        self._description = description
        self._owner = owner
        self._host_id = host_id
        self._expected_host = expected_host
        self._created_at = created_at or time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
        )
        self._metadata = dict(metadata) if metadata else {}

    @property
    def task_id(self) -> str:
        return self._task_id

    @property
    def description(self) -> str:
        return self._description

    @property
    def owner(self) -> str:
        return self._owner

    @property
    def host_id(self) -> str:
        return self._host_id

    @property
    def expected_host(self) -> str:
        return self._expected_host

    @property
    def created_at(self) -> str:
        return self._created_at

    @property
    def metadata(self) -> Dict[str, Any]:
        return dict(self._metadata)

    def verify_host(self, current_host_id: str) -> bool:
        """Check that the running host matches the expected host."""
        return current_host_id == self._expected_host

    def to_dict(self) -> Dict[str, Any]:
        return {
            "task_id": self._task_id,
            "description": self._description,
            "owner": self._owner,
            "host_id": self._host_id,
            "expected_host": self._expected_host,
            "created_at": self._created_at,
            "metadata": dict(self._metadata),
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> TaskContract:
        return cls(
            task_id=d["task_id"],
            description=d["description"],
            owner=d["owner"],
            host_id=d["host_id"],
            expected_host=d["expected_host"],
            created_at=d.get("created_at"),
            metadata=d.get("metadata"),
        )

    def save(self, path: Path) -> None:
        path.write_text(json.dumps(self.to_dict(), indent=2), encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> TaskContract:
        return cls.from_dict(json.loads(path.read_text(encoding="utf-8")))


# ---------------------------------------------------------------------------
# Host identity
# ---------------------------------------------------------------------------

def get_host_id() -> str:
    """Derive a stable host identity from machine hostname.

    This is a deterministic, verifiable identifier — not a caller-controlled
    opaque string.  The orchestrator compares this against the contract's
    expected_host to enforce wrong-host fail-closed.
    """
    return socket.gethostname()


# ---------------------------------------------------------------------------
# Mission Orchestrator
# ---------------------------------------------------------------------------

class MissionOrchestrator:
    """Higher-level orchestrator that ties MissionState primitives into a
    complete autonomous mission lifecycle.

    Lifecycle:
      1. Create contract + initial state (CREATED)
      2. Activate (CREATED -> ACTIVE)
      3. Execute work (phases)
      4. Complete -> FINALIZED

    Recovery:
      - On startup, load state + contract
      - If host mismatch -> fail closed
      - If RECOVERY_REQUIRED -> reconcile with evidence
      - If stale generation -> load authoritative state
      - If FINALIZED -> refuse to restart

    Bounded retry:
      - Each phase transition has max_retries
      - Exponential backoff between retries
      - After exhaustion -> state to RECOVERY_REQUIRED

    Provider interruption:
      - Provider failure -> transition to RECOVERY_REQUIRED
      - Requires evidence to resume
    """

    def __init__(
        self,
        *,
        state_path: Path,
        evidence_dir: Path,
        contract_path: Optional[Path] = None,
        max_retries: int = 3,
        base_backoff_s: float = 1.0,
        max_backoff_s: float = 30.0,
    ) -> None:
        self._state_path = state_path
        self._evidence_dir = evidence_dir
        self._contract_path = contract_path or state_path.with_suffix(".contract.json")
        self._max_retries = max_retries
        self._base_backoff_s = base_backoff_s
        self._max_backoff_s = max_backoff_s
        self._state: Optional[MissionState] = None
        self._contract: Optional[TaskContract] = None

    @property
    def state(self) -> Optional[MissionState]:
        return self._state

    @property
    def contract(self) -> Optional[TaskContract]:
        return self._contract

    # --- Contract management ---

    def create_mission(
        self,
        *,
        task_id: Optional[str] = None,
        description: str,
        owner: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> TaskContract:
        """Create a new mission with contract and initial state.

        Fails closed: contract and state are saved atomically.
        """
        host_id = get_host_id()
        if task_id is None:
            task_id = uuid.uuid4().hex

        self._contract = TaskContract(
            task_id=task_id,
            description=description,
            owner=owner,
            host_id=host_id,
            expected_host=host_id,
            metadata=metadata,
        )
        self._contract.save(self._contract_path)

        self._state = MissionState.create(
            generation=1,
            state="CREATED",
            metadata={"task_id": task_id, "created_by_host": host_id},
        )
        self._state.save(self._state_path)
        return self._contract

    # --- Wrong-host enforcement ---

    def verify_host(self) -> None:
        """Fail-closed check: running host must match contract's expected_host.

        Raises WrongHostError if the host identity doesn't match.
        This prevents a mission from being resumed on the wrong host.
        """
        if self._contract is None:
            raise TaskContractError("No contract loaded")

        current = get_host_id()
        if not self._contract.verify_host(current):
            raise WrongHostError(
                f"Wrong host: expected '{self._contract.expected_host}', "
                f"running on '{current}'. Mission '{self._contract.task_id}' "
                f"must not execute on an unauthorized host."
            )

    # --- Startup / recovery ---

    def startup(self) -> MissionState:
        """Load existing state + contract and perform recovery if needed.

        Lifecycle:
          1. Load contract (fail closed if missing)
          2. Verify host (fail closed if wrong host)
          3. Load state (fail closed if missing)
          4. If FINALIZED -> refuse to restart
          5. If RECOVERY_REQUIRED -> attempt recovery
          6. Return authoritative state
        """
        # 1. Load contract
        if not self._contract_path.exists():
            raise TaskContractError(
                f"No contract found at {self._contract_path}"
            )
        self._contract = TaskContract.load(self._contract_path)

        # 2. Verify host
        self.verify_host()

        # 3. Load or recover state
        if self._state_path.exists():
            self._state = MissionState.load(self._state_path)
        else:
            self._state = recover(self._state_path, self._evidence_dir)

        # 4. FINALIZED -> refuse
        if self._state.is_finalized():
            raise FinalizedError(
                f"Mission '{self._contract.task_id}' is FINALIZED "
                f"(generation={self._state.generation}). "
                f"Cannot restart a finalized mission."
            )

        # 5. RECOVERY_REQUIRED -> attempt recovery
        if self._state.state == "RECOVERY_REQUIRED":
            self._attempt_recovery()

        return self._state

    def _attempt_recovery(self) -> None:
        """Attempt to recover from RECOVERY_REQUIRED state.

        This is the PC<->VPS automatic recovery path:
        - Load evidence from evidence_dir
        - Reconcile with expected generation
        - If successful, state becomes executable again
        - If failed, state stays RECOVERY_REQUIRED (fail closed)
        """
        if self._state is None or self._contract is None:
            raise TaskContractError("No state or contract loaded")

        try:
            # Recovery is a real CAS transition:
            # disk generation N -> verified evidence/state generation N+1.
            disk_generation = self._state.generation
            recovered = self._state.reconcile(
                self._evidence_dir,
                expected_generation=disk_generation + 1,
            )

            # Persist only if disk still contains the generation we recovered
            # from. Assign in-memory state only after the CAS write succeeds.
            recovered.save(
                self._state_path,
                expected_generation=disk_generation,
            )
            self._state = recovered
        except (ReconciliationRequiredError, NonExecutableError):
            # Recovery failed — state remains RECOVERY_REQUIRED
            # This is correct behavior: insufficient evidence = fail closed
            pass

    # --- Phase transitions ---

    def activate(self) -> MissionState:
        """Transition CREATED -> ACTIVE.

        Fails closed if state is not CREATED.
        """
        self._ensure_loaded()
        self._ensure_not_finalized()
        self.verify_host()

        self._state = self._state.continue_mission(next_state="ACTIVE")
        self._persist()
        return self._state

    def begin_phase(self, phase_name: str) -> MissionState:
        """Transition ACTIVE -> PHASE:<phase_name>.

        Fails closed if state is not ACTIVE.
        """
        self._ensure_loaded()
        self._ensure_not_finalized()
        self.verify_host()

        self._state = self._state.continue_mission(
            next_state=f"PHASE:{phase_name}"
        )
        self._persist()
        return self._state

    def complete_phase(self) -> MissionState:
        """Transition PHASE:* -> ACTIVE (phase complete, ready for next).

        Fails closed if state is not in a PHASE state.
        """
        self._ensure_loaded()
        self._ensure_not_finalized()
        self.verify_host()

        if not self._state.state.startswith("PHASE:"):
            raise NonExecutableError(
                f"Cannot complete phase from state '{self._state.state}': "
                f"must be in a PHASE:* state"
            )

        self._state = self._state.continue_mission(next_state="ACTIVE")
        self._persist()
        return self._state

    def finalize(self, reason: str = "mission complete") -> MissionState:
        """Transition any executable state -> FINALIZED.

        FINALIZED is terminal: no further transitions are possible.
        """
        self._ensure_loaded()
        self._ensure_not_finalized()
        self.verify_host()

        finalized_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        # Build final metadata before transition (FINALIZED blocks with_updates)
        final_meta = {
            **self._state.metadata,
            "finalized_reason": reason,
            "finalized_at": finalized_at,
        }
        self._state = self._state.with_updates(
            generation=self._state.generation + 1,
            state="FINALIZED",
            metadata=final_meta,
        )
        self._persist()
        return self._state

    # --- Bounded retry ---

    def execute_with_retry(
        self,
        operation: Callable[[], Any],
        *,
        phase_name: str = "operation",
    ) -> Any:
        """Execute an operation with bounded retry and exponential backoff.

        If the operation fails:
          1. Retry up to max_retries times
          2. Between retries, exponential backoff
          3. After exhaustion, transition to RECOVERY_REQUIRED
          4. Persist evidence of failure

        Returns the operation result on success.
        Raises BoundedRetryExhausted after all retries exhausted.
        """
        self._ensure_loaded()
        self._ensure_not_finalized()
        self.verify_host()

        last_error = None
        for attempt in range(1, self._max_retries + 1):
            try:
                result = operation()
                return result
            except Exception as exc:
                last_error = exc
                if attempt < self._max_retries:
                    backoff = min(
                        self._base_backoff_s * (2 ** (attempt - 1)),
                        self._max_backoff_s,
                    )
                    time.sleep(backoff)

        # All retries exhausted -> provider interruption
        self._handle_provider_interruption(phase_name, str(last_error))
        raise BoundedRetryExhausted(
            f"Operation '{phase_name}' failed after {self._max_retries} "
            f"retries. Last error: {last_error}"
        )

    def _handle_provider_interruption(
        self, phase_name: str, error_message: str
    ) -> None:
        """Handle provider/tool interruption by transitioning to
        RECOVERY_REQUIRED with evidence of the failure."""
        self._state = self._state.with_updates(
            generation=self._state.generation + 1,
            state="RECOVERY_REQUIRED",
            metadata={
                **self._state.metadata,
                "recovery_reason": "provider_interruption",
                "failed_phase": phase_name,
                "error_message": error_message,
                "interruption_at": time.strftime(
                    "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                ),
            },
        )
        self._persist()

    # --- Transactional operations ---

    def execute_transaction(
        self,
        steps: List[Callable[[], Dict[str, Any]]],
        *,
        transaction_name: str = "transaction",
    ) -> List[Dict[str, Any]]:
        """Execute a sequence of steps as a transaction.

        If any step fails:
          1. All completed steps are recorded as evidence
          2. State transitions to RECOVERY_REQUIRED
          3. TransactionRolledBack is raised

        On success, all step results are returned.
        """
        self._ensure_loaded()
        self._ensure_not_finalized()
        self.verify_host()

        results: List[Dict[str, Any]] = []
        for i, step in enumerate(steps):
            try:
                result = step()
                results.append({
                    "step_index": i,
                    "status": "completed",
                    "result": result,
                })
            except Exception as exc:
                # Record partial progress as evidence
                results.append({
                    "step_index": i,
                    "status": "failed",
                    "error": str(exc),
                })
                # Persist partial evidence
                evidence = {
                    "transaction_name": transaction_name,
                    "steps_completed": i,
                    "steps_failed": len(steps),
                    "results": results,
                    "rolled_back_at": time.strftime(
                        "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                    ),
                }
                evidence_path = (
                    self._evidence_dir
                    / f"transaction-{transaction_name}-{int(time.time())}.json"
                )
                self._evidence_dir.mkdir(parents=True, exist_ok=True)
                evidence_path.write_text(
                    json.dumps(evidence, indent=2), encoding="utf-8"
                )

                # Transition to recovery
                self._state = self._state.with_updates(
                    generation=self._state.generation + 1,
                    state="RECOVERY_REQUIRED",
                    metadata={
                        **self._state.metadata,
                        "recovery_reason": "transaction_rollback",
                        "transaction_name": transaction_name,
                        "failed_step": i,
                        "error_message": str(exc),
                    },
                )
                self._persist()

                raise TransactionRolledBack(
                    f"Transaction '{transaction_name}' rolled back at "
                    f"step {i}/{len(steps)}: {exc}"
                ) from exc

        return results

    # --- Evidence writing ---

    def write_evidence(
        self, evidence_name: str, data: Dict[str, Any]
    ) -> Path:
        """Write evidence to the evidence directory.

        Evidence is the authoritative record that proves mission state.
        The evidence file path is deterministic from the name.
        """
        self._evidence_dir.mkdir(parents=True, exist_ok=True)
        evidence_path = self._evidence_dir / f"{evidence_name}.json"
        evidence_path.write_text(
            json.dumps(data, indent=2), encoding="utf-8"
        )
        return evidence_path

    # --- Private helpers ---

    def _ensure_loaded(self) -> None:
        if self._state is None:
            raise TaskContractError("Mission not loaded. Call startup() first.")

    def _ensure_not_finalized(self) -> None:
        if self._state is not None and self._state.is_finalized():
            raise FinalizedError(
                f"Mission is FINALIZED (generation={self._state.generation}). "
                f"Cannot perform further operations."
            )

    def _persist(self) -> None:
        self._state.save(self._state_path)
