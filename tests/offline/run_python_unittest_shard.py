#!/usr/bin/env python3
"""Run one unittest shard and record counts out-of-band from shard stdout."""

import json
import os
import runpy
import sys
import unittest


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: run_python_unittest_shard.py REPORT SHARD")
    report_path, shard_path = sys.argv[1:]
    original_run = unittest.TextTestRunner.run

    def recording_run(runner, suite):
        result = original_run(runner, suite)
        skipped = len(result.skipped)
        record = {
            "total_tests": result.testsRun,
            "executed_tests": max(0, result.testsRun - skipped),
            "skipped_tests": skipped,
        }
        temporary = f"{report_path}.tmp-{os.getpid()}"
        with open(temporary, "x", encoding="utf-8") as handle:
            json.dump(record, handle, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, report_path)
        return result

    unittest.TextTestRunner.run = recording_run
    sys.argv = [shard_path]
    runpy.run_path(shard_path, run_name="__main__")


if __name__ == "__main__":
    main()
