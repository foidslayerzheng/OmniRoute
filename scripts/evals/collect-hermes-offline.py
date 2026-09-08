#!/usr/bin/env python3
"""Run the canonical deterministic Hermes cases and emit machine-readable outcomes."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import pytest

RESULT_MARKER = "@@HERMES_OFFLINE_EVALS@@"


class OutcomeCollector:
    def __init__(self) -> None:
        self.outcomes: dict[str, str] = {}

    def pytest_runtest_logreport(self, report: pytest.TestReport) -> None:
        if report.when == "call":
            self.outcomes[report.nodeid] = "passed" if report.passed else "failed"
        elif report.failed:
            self.outcomes[report.nodeid] = "failed"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--hermes-root", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    expected: dict[str, tuple[str, str]] = {}
    test_files: list[str] = []

    for suite in manifest["suites"]:
        test_file = suite["testFile"]
        test_files.append(test_file)
        for case in suite["cases"]:
            nodeid = f"{test_file}::{case['nodeId']}"
            if nodeid in expected:
                raise ValueError(f"Duplicate pytest node id: {nodeid}")
            expected[nodeid] = (suite["id"], case["id"])

    collector = OutcomeCollector()
    pytest_exit_code = int(
        pytest.main(["-q", *sorted(set(test_files))], plugins=[collector])
    )
    missing = sorted(set(expected) - set(collector.outcomes))
    unexpected = sorted(set(collector.outcomes) - set(expected))
    if missing or unexpected:
        print(
            RESULT_MARKER
            + json.dumps(
                {
                    "error": "Collected pytest cases did not match the manifest",
                    "missing": missing,
                    "unexpected": unexpected,
                    "pytestExitCode": pytest_exit_code,
                },
                separators=(",", ":"),
            )
        )
        return 2

    suites: dict[str, dict[str, str]] = {}
    for nodeid, (suite_id, case_id) in expected.items():
        suites.setdefault(suite_id, {})[case_id] = collector.outcomes[nodeid]

    print(
        RESULT_MARKER
        + json.dumps(
            {"pytestExitCode": pytest_exit_code, "suites": suites},
            separators=(",", ":"),
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
