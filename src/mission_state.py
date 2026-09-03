"""Durable mission state with monotonic generation, CAS writes, exclusive
locking, and FINALIZED-is-terminal semantics.

Durability properties enforced:
  - Monotonic state generation/version
  - Expected-version / compare-and-swap (CAS) write protection
  - Exclusive mutation locking via fcntl.flock
  - Atomic temp-write → fsync → rename → directory-fsync
  - Stale writers fail before mutation
  - FINALIZED is terminal (no further state transitions allowed)
  - Replicas cannot overwrite newer authoritative state
  - Insufficient recovery evidence fails closed
  - Recovery provenance is persisted
"""

from __future__ import annotations

import copy
import fcntl
import json
import os
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional


class FinalizedError(Exception):
    """Raised when a mutation targets a FINALIZED state."""


class GenerationConflictError(Exception):
    """Raised on CAS failure: expected generation does not match on-disk."""


class NonExecutableError(Exception):
    """Raised when an operation requires an executable mission state but the
    current state is non-executable (e.g. RECOVERY_REQUIRED or FINALIZED)."""


class ReconciliationRequiredError(Exception):
    """Raised when a promotion to executable state is attempted without a
    verified reconciliation through evidence."""


class MissionState:
    """Immutable-style value object for mission state. Mutations return a new
    instance; persistence requires explicit save()."""

    __slots__ = ("_generation", "_state", "_version", "_metadata")

    # States that are not executable (cannot be continued/promoted without
    # explicit verified reconciliation).
    _NON_EXECUTABLE_STATES = frozenset({"RECOVERY_REQUIRED", "FINALIZED"})

    def __init__(
        self,
        *,
        generation: int,
        state: str,
        version: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        if generation < 1:
            raise ValueError("generation must be >= 1")
        self._generation = generation
        self._state = state
        self._version = version
        self._metadata = dict(metadata) if metadata else {}

    # --- read accessors ---

    @property
    def generation(self) -> int:
        return self._generation

    @property
    def state(self) -> str:
        return self._state

    @property
    def version(self) -> str:
        return self._version

    @property
    def metadata(self) -> Dict[str, Any]:
        return dict(self._metadata)

    @property
    def executable(self) -> bool:
        """True when the mission state is runnable (not RECOVERY_REQUIRED
        and not FINALIZED)."""
        return self._state not in self._NON_EXECUTABLE_STATES

    def is_finalized(self) -> bool:
        return self._state == "FINALIZED"

    # --- continuation / phase transitions (fail-closed guards) ---

    def continue_mission(self, *, next_state: str) -> "MissionState":
        """Transition to next_state.  Fails closed if the current state is
        non-executable (RECOVERY_REQUIRED or FINALIZED)."""
        if self._state == "RECOVERY_REQUIRED":
            raise NonExecutableError(
                "Cannot continue from RECOVERY_REQUIRED state: "
                "authoritative evidence was unavailable during recovery. "
                "A verified reconciliation is required before any "
                "phase transition."
            )
        if self.is_finalized():
            raise FinalizedError(
                "Cannot continue a FINALIZED mission state"
            )
        return self.with_updates(
            generation=self._generation + 1,
            state=next_state,
        )

    def promote_to_executable(self, *, reason: str) -> "MissionState":
        """Explicitly promote to an executable state.  Must go through the
        reconciliation path — direct promotion is forbidden."""
        if self._state == "RECOVERY_REQUIRED":
            raise ReconciliationRequiredError(
                "Cannot promote RECOVERY_REQUIRED to executable directly: "
                "requires a verified reconciliation with authoritative "
                "evidence.  Reason rejected: " + reason
            )
        if self.is_finalized():
            raise FinalizedError(
                "Cannot promote a FINALIZED mission state"
            )
        # Already executable — no-op return
        return self

    def reconcile(
        self,
        evidence_dir: Path,
        *,
        expected_generation: int,
        expected_version: Optional[str] = None,
    ) -> "MissionState":
        """Verify authoritative evidence against concrete preconditions, then
        promote RECOVERY_REQUIRED to the recovered state.

        Authorization is derived from verifiable checks, NOT from opaque
        caller-supplied strings:

          - evidence_dir must contain valid JSON evidence files
          - highest-generation evidence must match expected_generation
          - evidence version must match expected_version (if provided)
          - evidence must contain all required structural fields
          - evidence target state must not be FINALIZED (terminal)
          - this mission state must be RECOVERY_REQUIRED

        Fails closed on any precondition mismatch.
        """
        # --- Verifiable authorization checks ---

        # FINALIZED is terminal — cannot reconcile into or from it
        if self.is_finalized():
            raise FinalizedError(
                "Cannot reconcile a FINALIZED mission state — "
                "FINALIZED is terminal"
            )

        if self._state != "RECOVERY_REQUIRED":
            raise NonExecutableError(
                "reconcile() is only applicable to RECOVERY_REQUIRED state"
            )

        # Require at least one evidence file
        evidence_files = sorted(
            evidence_dir.glob("*.json")
        ) if evidence_dir.exists() else []
        if not evidence_files:
            raise ReconciliationRequiredError(
                "Reconciliation failed: no authoritative evidence files "
                "found in " + str(evidence_dir)
            )

        # Load highest-generation evidence
        best_gen = -1
        best_data = None
        for ef in evidence_files:
            try:
                data = json.loads(ef.read_text(encoding="utf-8"))
                gen = data.get("generation", 0)
                if gen > best_gen:
                    best_gen = gen
                    best_data = data
            except (json.JSONDecodeError, KeyError):
                continue

        if best_data is None:
            raise ReconciliationRequiredError(
                "Reconciliation failed: no valid evidence found"
            )

        # --- Verifiable authorization checks ---

        # 1. Evidence generation must match expected generation
        if best_gen != expected_generation:
            raise ReconciliationRequiredError(
                f"Reconciliation failed: evidence generation {best_gen} "
                f"does not match expected generation {expected_generation}"
            )

        # 2. Evidence version must match expected version (if provided)
        if expected_version is not None:
            evidence_version = best_data.get("version")
            if evidence_version != expected_version:
                raise ReconciliationRequiredError(
                    f"Reconciliation failed: evidence version "
                    f"{evidence_version!r} does not match expected version "
                    f"{expected_version!r}"
                )

        # 3. Evidence must have required structural fields
        for field in ("generation", "state"):
            if field not in best_data:
                raise ReconciliationRequiredError(
                    f"Reconciliation failed: evidence missing required "
                    f"field '{field}'"
                )

        # 4. Evidence target state must not be FINALIZED (terminal)
        target_state = best_data["state"]
        if target_state == "FINALIZED":
            raise ReconciliationRequiredError(
                "Reconciliation failed: evidence targets FINALIZED state, "
                "which is terminal and cannot be reconciled into"
            )

        # Promote from RECOVERY_REQUIRED to the evidence state
        promoted = self.with_updates(
            generation=best_data["generation"],
            state=best_data["state"],
            metadata={
                "reconciled_from": "RECOVERY_REQUIRED",
                "reconciliation_verified_generation": best_gen,
                "reconciliation_verified_version": best_data.get("version"),
                "reconciliation_timestamp": time.strftime(
                    "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                ),
            },
        )
        return promoted

    # --- value-object mutation ---

    def with_updates(
        self,
        *,
        generation: Optional[int] = None,
        state: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> "MissionState":
        """Return a *new* MissionState with the requested fields changed.
        Refuses to transition away from FINALIZED."""
        if self.is_finalized():
            raise FinalizedError(
                "Cannot modify a FINALIZED mission state"
            )
        new_gen = generation if generation is not None else self._generation
        new_state = state if state is not None else self._state
        new_meta = dict(self._metadata)
        if metadata:
            new_meta.update(metadata)
        return MissionState(
            generation=new_gen,
            state=new_state,
            version=self._version,
            metadata=new_meta,
        )

    # --- persistence ---

    def _to_dict(self) -> Dict[str, Any]:
        return {
            "generation": self._generation,
            "state": self._state,
            "version": self._version,
            "metadata": copy.deepcopy(self._metadata),
        }

    @classmethod
    def _from_dict(cls, d: Dict[str, Any]) -> "MissionState":
        return cls(
            generation=d["generation"],
            state=d["state"],
            version=d["version"],
            metadata=d.get("metadata", {}),
        )

    @classmethod
    def create(
        cls,
        *,
        generation: int = 1,
        state: str = "created",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> "MissionState":
        return cls(
            generation=generation,
            state=state,
            version=uuid.uuid4().hex,
            metadata=metadata,
        )

    @classmethod
    def load(cls, path: Path) -> "MissionState":
        """Load authoritative state from disk."""
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
        return cls._from_dict(data)

    def save(
        self,
        path: Path,
        *,
        expected_generation: Optional[int] = None,
    ) -> None:
        """Persist state atomically with CAS and exclusive locking.

        Steps:
          1. Acquire exclusive flock on a lockfile adjacent to `path`.
          2. If expected_generation is set, read current on-disk state and
             reject if it differs (CAS check).
          3. Reject mutation if on-disk state is FINALIZED.
          4. Reject mutation if our generation is stale (<= on-disk gen).
          5. Write to temp file → fsync → rename → fsync parent dir.
        """
        lock_path = path.with_suffix(".lock")
        lock_path.touch(exist_ok=True)

        with open(lock_path, "r+") as lock_fh:
            try:
                fcntl.flock(lock_fh, fcntl.LOCK_EX)
            except OSError:
                raise RuntimeError("Could not acquire exclusive lock")

            try:
                # --- CAS + FINALIZED gate ---
                if path.exists():
                    current = self.load(path)
                    if expected_generation is not None:
                        if current.generation != expected_generation:
                            raise GenerationConflictError(
                                f"Expected generation {expected_generation}, "
                                f"found {current.generation}"
                            )
                    if current.is_finalized():
                        raise FinalizedError(
                            f"Cannot overwrite FINALIZED state at generation "
                            f"{current.generation} with generation "
                            f"{self._generation}"
                        )
                    if self._generation <= current.generation:
                        raise GenerationConflictError(
                            f"Stale generation {self._generation} <= "
                            f"on-disk {current.generation}"
                        )

                # --- Atomic write ---
                path.parent.mkdir(parents=True, exist_ok=True)
                fd, tmp = tempfile.mkstemp(
                    dir=path.parent, suffix=".tmp", prefix="state-"
                )
                try:
                    data = json.dumps(self._to_dict(), sort_keys=True, indent=2)
                    os.write(fd, data.encode("utf-8"))
                    os.fsync(fd)
                finally:
                    os.close(fd)

                os.rename(tmp, path)
                # fsync parent directory for durability
                dir_fd = os.open(str(path.parent), os.O_RDONLY)
                try:
                    os.fsync(dir_fd)
                finally:
                    os.close(dir_fd)
            finally:
                fcntl.flock(lock_fh, fcntl.LOCK_UN)


def load_or_create(
    state_path: Path,
    evidence_dir: Path,
) -> MissionState:
    """Load existing state or create initial state with CAS and locking."""
    lock_path = state_path.with_suffix(".lock")
    lock_path.touch(exist_ok=True)

    with open(lock_path, "r+") as lock_fh:
        fcntl.flock(lock_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            if state_path.exists():
                return MissionState.load(state_path)
            ms = MissionState.create(generation=1, state="created")
            ms.save(state_path)
            return ms
        finally:
            fcntl.flock(lock_fh, fcntl.LOCK_UN)


def save(state_path: Path, mission_state: MissionState) -> None:
    """Convenience: save a MissionState with CAS based on its own generation."""
    mission_state.save(state_path, expected_generation=mission_state.generation)


def recover(
    state_path: Path,
    evidence_dir: Path,
) -> MissionState:
    """Recover authoritative state from disk + evidence directory.

    Properties:
      - If evidence_dir does not exist or is empty, creates minimal state
        (generation=1, state='RECOVERY_REQUIRED', executable=False) with
        provenance indicating authoritative evidence was unavailable.
      - If evidence exists, loads the highest-generation evidence and
        validates it; the recovered state is executable.
      - Insufficient evidence fails closed (RECOVERY_REQUIRED).
      - Recovery provenance is always persisted in metadata.
      - Normal continuation/phase transition must fail closed from
        RECOVERY_REQUIRED; only a verified reconciliation may promote it.
    """
    provenance = {
        "recovered_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "evidence_dir_existed": evidence_dir.exists(),
        "evidence_count": 0,
        "evidence_files": [],
        "failure_closed": False,
    }

    evidence_files = []
    if evidence_dir.exists():
        evidence_files = sorted(evidence_dir.glob("*.json"))

    provenance["evidence_count"] = len(evidence_files)
    provenance["evidence_files"] = [f.name for f in evidence_files]

    if not evidence_files:
        provenance["failure_closed"] = True
        ms = MissionState.create(
            generation=1,
            state="RECOVERY_REQUIRED",
            metadata={"recovery_provenance": provenance},
        )
        ms.save(state_path)
        return ms

    # Load highest-generation evidence
    best_gen = -1
    best_data = None
    for ef in evidence_files:
        try:
            data = json.loads(ef.read_text(encoding="utf-8"))
            gen = data.get("generation", 0)
            if gen > best_gen:
                best_gen = gen
                best_data = data
        except (json.JSONDecodeError, KeyError):
            continue  # Skip corrupt evidence files

    if best_data is None:
        provenance["failure_closed"] = True
        ms = MissionState.create(
            generation=1,
            state="RECOVERY_REQUIRED",
            metadata={"recovery_provenance": provenance},
        )
        ms.save(state_path)
        return ms

    # Recover from evidence with provenance
    meta = best_data.get("metadata", {})
    meta["recovery_provenance"] = provenance
    ms = MissionState(
        generation=best_data["generation"],
        state=best_data["state"],
        version=best_data.get("version", uuid.uuid4().hex),
        metadata=meta,
    )
    ms.save(state_path)
    return ms
