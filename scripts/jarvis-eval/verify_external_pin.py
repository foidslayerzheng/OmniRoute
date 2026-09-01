#!/usr/bin/env python3
"""Verify a cloned external evaluation dependency is exactly at its reviewed pin."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-dir", required=True)
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--expect", action="append", default=[], help="required relative path; may repeat")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.repo_dir).resolve()
    if not root.is_dir():
        print(f"[external-pin] missing checkout: {root}", file=sys.stderr)
        return 2
    try:
        head = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"[external-pin] cannot resolve HEAD: {exc}", file=sys.stderr)
        return 2

    missing = [relative for relative in args.expect if not (root / relative).exists()]
    ok = head == args.expected_sha and not missing
    print(json.dumps({"head": head, "expected": args.expected_sha, "missing": missing, "ok": ok}, sort_keys=True))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
