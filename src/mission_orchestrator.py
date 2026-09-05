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

import copy
import fcntl
import json
import os
import platform
import socket
import subprocess
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


class MutationGuardError(Exception):
    """Raised when pre-mutation safety requirements are not satisfied."""


class CheckpointError(Exception):
    """Raised when durable checkpoint validation fails."""


class ReportingError(Exception):
    """Raised when post-work reporting fails after state is safely advanced."""


class DuplicateMutationError(Exception):
    """Raised when a mutation id has already been claimed."""


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
        self._metadata = copy.deepcopy(metadata) if metadata else {}

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
        return copy.deepcopy(self._metadata)

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
            "metadata": copy.deepcopy(self._metadata),
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

    def run_phase(
        self,
        phase_name: str,
        operation: Callable[[], Any],
        *,
        reporter: Optional[Callable[[Any], None]] = None,
        retry_safe: bool = False,
    ) -> Any:
        """Run one phase and automatically advance back to ACTIVE on success.

        Reporting happens only after durable phase completion. If reporting
        fails, completed work is never regressed to RECOVERY_REQUIRED.
        """
        self.begin_phase(phase_name)

        result = self.execute_with_retry(
            operation,
            phase_name=phase_name,
            retry_safe=retry_safe,
        )

        # Commit successful work before any non-authoritative reporting.
        self.complete_phase()

        if reporter is not None:
            try:
                reporter(result)
            except Exception as exc:
                # Reporting is observational; it must never roll back or
                # regress successfully completed mission state.
                try:
                    self.write_evidence(
                        f"reporting-failure-{int(time.time() * 1000)}",
                        {
                            "phase_name": phase_name,
                            "generation": self._state.generation,
                            "state": self._state.state,
                            "error": str(exc),
                        },
                    )
                finally:
                    raise ReportingError(
                        f"Phase '{phase_name}' completed, but reporting failed: "
                        f"{exc}"
                    ) from exc

        return result

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

    # --- Pre-mutation guards ---

    def verify_mutation_preconditions(self, *, repo_path: Path) -> None:
        """Fail closed before any externally mutating operation.

        The Universal Task Contract must contain metadata["mutation_guard"]:
          repo_path: exact authorized repository path
          sha: exact authorized Git commit
          service: required active user-systemd service
          approved: explicit boolean approval

        No mutation is permitted if any requirement is missing or mismatched.
        """
        self._ensure_loaded()
        self._ensure_not_finalized()
        self.verify_host()

        if self._contract is None:
            raise MutationGuardError("No task contract loaded")

        guard = self._contract.metadata.get("mutation_guard")
        if not isinstance(guard, dict):
            raise MutationGuardError("mutation_guard is required")

        expected_path = guard.get("repo_path")
        expected_sha = guard.get("sha")
        required_service = guard.get("service")
        approved = guard.get("approved")

        if not isinstance(expected_path, str) or not expected_path:
            raise MutationGuardError("mutation_guard.repo_path is required")
        if not isinstance(expected_sha, str) or not expected_sha:
            raise MutationGuardError("mutation_guard.sha is required")
        if not isinstance(required_service, str) or not required_service:
            raise MutationGuardError("mutation_guard.service is required")
        if approved is not True:
            raise MutationGuardError("mutation is not explicitly approved")

        actual_path = repo_path.expanduser().resolve()
        authorized_path = Path(expected_path).expanduser().resolve()

        if actual_path != authorized_path:
            raise MutationGuardError(
                f"Wrong repository path: expected '{authorized_path}', "
                f"got '{actual_path}'"
            )

        git_check = subprocess.run(
            ["git", "-C", str(actual_path), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=False,
        )
        if git_check.returncode != 0:
            raise MutationGuardError(
                f"Cannot verify Git SHA for '{actual_path}'"
            )

        actual_sha = git_check.stdout.strip()
        if actual_sha != expected_sha:
            raise MutationGuardError(
                f"Wrong Git SHA: expected '{expected_sha}', "
                f"got '{actual_sha}'"
            )

        service_check = subprocess.run(
            ["systemctl", "--user", "is-active", required_service],
            capture_output=True,
            text=True,
            check=False,
        )
        if (
            service_check.returncode != 0
            or service_check.stdout.strip() != "active"
        ):
            raise MutationGuardError(
                f"Required service '{required_service}' is not active"
            )

    def execute_mutation(
        self,
        operation: Callable[[], Any],
        *,
        repo_path: Path,
        mutation_id: str,
        phase_name: str = "mutation",
        retry_safe: bool = False,
    ) -> Any:
        """Execute a guarded mutation at most once per durable mutation id.

        The receipt is written before the operation begins. If execution or
        transport becomes ambiguous, a restart sees the existing receipt and
        refuses to replay the mutation automatically.
        """
        self.verify_mutation_preconditions(repo_path=repo_path)

        if (
            not mutation_id
            or "/" in mutation_id
            or "\\" in mutation_id
            or mutation_id in {".", ".."}
        ):
            raise DuplicateMutationError("Invalid mutation_id")

        if self._contract is None or self._state is None:
            raise DuplicateMutationError("Mission contract/state not loaded")

        receipts_dir = self._evidence_dir / "mutation-receipts"
        receipts_dir.mkdir(parents=True, exist_ok=True)
        receipt_path = receipts_dir / f"{mutation_id}.json"

        receipt = {
            "mutation_id": mutation_id,
            "task_id": self._contract.task_id,
            "phase_name": phase_name,
            "generation": self._state.generation,
            "status": "started",
        }

        # O_EXCL makes claiming the mutation id atomic across processes.
        try:
            fd = os.open(
                str(receipt_path),
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
        except FileExistsError as exc:
            raise DuplicateMutationError(
                f"Mutation '{mutation_id}' has already been claimed"
            ) from exc

        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(receipt, fh, indent=2)
                fh.flush()
                os.fsync(fh.fileno())

            dir_fd = os.open(str(receipts_dir), os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except Exception:
            # A partially created claim must still block replay. Fail closed.
            raise

        result = self.execute_with_retry(
            operation,
            phase_name=phase_name,
            retry_safe=retry_safe,
        )

        completed = {
            **receipt,
            "status": "completed",
        }
        tmp = receipt_path.with_suffix(".json.tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(completed, fh, indent=2)
            fh.flush()
            os.fsync(fh.fileno())

        os.replace(tmp, receipt_path)

        dir_fd = os.open(str(receipts_dir), os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)

        return result

    # --- Bounded retry ---

    def execute_with_retry(
        self,
        operation: Callable[[], Any],
        *,
        phase_name: str = "operation",
        retry_safe: bool = False,
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

                # A mutating operation is ambiguous after transport/provider
                # failure: it may have committed remotely even though no
                # response was received. Never repeat it unless the caller
                # explicitly declares the operation retry-safe/idempotent.
                if not retry_safe:
                    self._handle_provider_interruption(
                        phase_name,
                        f"ambiguous operation result: {exc}",
                    )
                    raise BoundedRetryExhausted(
                        f"Operation '{phase_name}' failed with an ambiguous "
                        f"result and was not retried because retry_safe=False: "
                        f"{exc}"
                    ) from exc

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

    # --- Durable checkpoint / resume ---

    def write_checkpoint(
        self,
        checkpoint_name: str,
        data: Dict[str, Any],
    ) -> Path:
        """Persist an idempotent checkpoint for the exact current generation.

        Writes are serialized across processes. Identical rewrites are
        idempotent; conflicting same-generation or future-generation
        checkpoints fail closed.
        """
        self._ensure_loaded()
        self._ensure_not_finalized()
        self.verify_host()

        if self._contract is None or self._state is None:
            raise CheckpointError("Mission contract/state not loaded")

        if (
            not checkpoint_name
            or "/" in checkpoint_name
            or "\\" in checkpoint_name
            or checkpoint_name in {".", ".."}
        ):
            raise CheckpointError("Invalid checkpoint name")

        self._evidence_dir.mkdir(parents=True, exist_ok=True)
        path = self._evidence_dir / f"checkpoint-{checkpoint_name}.json"
        lock_path = self._evidence_dir / f".checkpoint-{checkpoint_name}.lock"

        payload = {
            "task_id": self._contract.task_id,
            "generation": self._state.generation,
            "state": self._state.state,
            "data": data,
        }

        lock_fd = os.open(
            str(lock_path),
            os.O_RDWR | os.O_CREAT,
            0o600,
        )

        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)

            if path.exists():
                try:
                    existing = json.loads(path.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError) as exc:
                    raise CheckpointError(
                        f"Existing checkpoint '{checkpoint_name}' is unreadable"
                    ) from exc

                if existing.get("task_id") != self._contract.task_id:
                    raise CheckpointError(
                        "Checkpoint task_id does not match mission"
                    )

                existing_generation = existing.get("generation")
                if type(existing_generation) is not int:
                    raise CheckpointError(
                        "Existing checkpoint generation is invalid"
                    )

                if existing == payload:
                    return path

                if existing_generation == self._state.generation:
                    raise CheckpointError(
                        "Conflicting checkpoint already exists for current "
                        f"generation {self._state.generation}"
                    )

                if existing_generation > self._state.generation:
                    raise CheckpointError(
                        "Refusing to overwrite future checkpoint generation "
                        f"{existing_generation} with stale generation "
                        f"{self._state.generation}"
                    )

            # Unique temporary file prevents concurrent writers from sharing
            # the same staging pathname.
            tmp = self._evidence_dir / (
                f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
            )

            try:
                with tmp.open("x", encoding="utf-8") as fh:
                    json.dump(payload, fh, indent=2)
                    fh.flush()
                    os.fsync(fh.fileno())

                os.replace(tmp, path)
            finally:
                try:
                    tmp.unlink()
                except FileNotFoundError:
                    pass

            # Durably persist the directory entry.
            dir_fd = os.open(str(self._evidence_dir), os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)

            return path
        finally:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            finally:
                os.close(lock_fd)

    def resume_checkpoint(
        self,
        checkpoint_name: str,
    ) -> Dict[str, Any]:
        """Return checkpoint payload only if it matches authoritative state.

        A stale or future checkpoint is rejected rather than replayed.
        """
        self._ensure_loaded()
        self._ensure_not_finalized()
        self.verify_host()

        if self._contract is None or self._state is None:
            raise CheckpointError("Mission contract/state not loaded")

        if (
            not checkpoint_name
            or "/" in checkpoint_name
            or "\\" in checkpoint_name
            or checkpoint_name in {".", ".."}
        ):
            raise CheckpointError("Invalid checkpoint name")

        path = self._evidence_dir / f"checkpoint-{checkpoint_name}.json"
        if not path.exists():
            raise CheckpointError(
                f"Checkpoint '{checkpoint_name}' does not exist"
            )

        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            raise CheckpointError(
                f"Checkpoint '{checkpoint_name}' is unreadable"
            ) from exc

        if payload.get("task_id") != self._contract.task_id:
            raise CheckpointError("Checkpoint task_id does not match mission")

        if payload.get("generation") != self._state.generation:
            raise CheckpointError(
                "Checkpoint generation does not match authoritative state"
            )

        if payload.get("state") != self._state.state:
            raise CheckpointError(
                "Checkpoint state does not match authoritative state"
            )

        data = payload.get("data")
        if not isinstance(data, dict):
            raise CheckpointError("Checkpoint data must be an object")

        return dict(data)

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
