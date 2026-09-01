#!/usr/bin/env python3
"""Read-only capability scan of a pinned Hermes upstream checkout."""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CAPABILITIES: dict[str, tuple[str, ...]] = {
    "verification_completion_contracts": (
        r"completion contract",
        r"verification contract",
        r"evidence[- ]based verification",
        r"/goal\b",
    ),
    "parallel_subagents": (r"subagents?", r"fan[- ]?out", r"parallel agent"),
    "worktree_workers": (r"worktree"),
    "mixture_of_agents": (r"mixture[- ]of[- ]agents", r"mixture of agents", r"\bmoa\b"),
    "prompt_injection_defenses": (r"prompt injection", r"indirect injection", r"tool poisoning"),
    "persistent_bot_mode": (r"bot mode", r"persistent bot"),
}

TEXT_SUFFIXES = {".py", ".md", ".toml", ".yaml", ".yml", ".json", ".js", ".mjs", ".ts", ".tsx"}
SKIP_PARTS = {".git", "node_modules", ".venv", "venv", "dist", "build"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream-dir", required=True, help="pinned, read-only Hermes checkout")
    parser.add_argument("--upstream-ref", required=True, help="commit/tag being audited")
    parser.add_argument("--current-ref", default=None, help="currently deployed Hermes ref, if known")
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-evidence", type=int, default=8)
    return parser.parse_args()


def iter_text_files(root: Path):
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        if any(part in SKIP_PARTS for part in path.parts):
            continue
        try:
            if path.stat().st_size > 2_000_000:
                continue
        except OSError:
            continue
        yield path


def scan(root: Path, max_evidence: int) -> dict[str, Any]:
    compiled = {name: tuple(re.compile(pattern, re.IGNORECASE) for pattern in patterns) for name, patterns in CAPABILITIES.items()}
    evidence: dict[str, list[dict[str, Any]]] = {name: [] for name in CAPABILITIES}
    scanned_files = 0
    for path in iter_text_files(root):
        scanned_files += 1
        try:
            lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError:
            continue
        for line_number, line in enumerate(lines, start=1):
            for capability, patterns in compiled.items():
                bucket = evidence[capability]
                if len(bucket) >= max_evidence:
                    continue
                if any(pattern.search(line) for pattern in patterns):
                    bucket.append(
                        {
                            "path": str(path.relative_to(root)),
                            "line": line_number,
                            "excerpt": line.strip()[:240],
                        }
                    )
    return {
        "scannedFiles": scanned_files,
        "capabilities": {
            capability: {"found": bool(items), "evidence": items}
            for capability, items in evidence.items()
        },
    }


def main() -> int:
    args = parse_args()
    root = Path(args.upstream_dir).resolve()
    if not root.is_dir():
        print(f"[hermes-audit] upstream directory missing: {root}", file=sys.stderr)
        return 2

    result = scan(root, max(1, args.max_evidence))
    artifact = {
        "schemaVersion": 1,
        "kind": "hermes-upstream-capability-audit",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "upstreamRef": args.upstream_ref,
        "currentRef": args.current_ref,
        "sameRef": bool(args.current_ref and args.current_ref == args.upstream_ref),
        **result,
        "safety": {
            "readOnly": True,
            "upgradeExecuted": False,
            "deploymentChanged": False,
        },
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    found = sum(1 for capability in artifact["capabilities"].values() if capability["found"])
    print(json.dumps({"capabilitiesFound": found, "scannedFiles": artifact["scannedFiles"], "output": str(output)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
