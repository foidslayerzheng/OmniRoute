#!/usr/bin/env python3
"""Fail-closed promotion gate for offline agent/prompt optimization candidates.

The gate compares baseline and candidate metric JSON files. It emits a decision
artifact only. It never edits prompts, routing policy, services, or production.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ALIASES = {
    "successRate": ("successRate", "success_rate", "accuracy", "reward"),
    "avgLatencyMs": ("avgLatencyMs", "avg_latency_ms", "latencyMs", "latency_ms"),
    "avgCostUsd": ("avgCostUsd", "avg_cost_usd", "costUsd", "cost_usd", "cost"),
    "securityFailures": ("securityFailures", "security_failures", "securityRegressions", "security_regressions"),
    "browserSuccessRate": ("browserSuccessRate", "browser_success_rate"),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-success-drop", type=float, default=0.0)
    parser.add_argument("--max-latency-increase", type=float, default=0.05, help="relative increase, default 5%%")
    parser.add_argument("--max-cost-increase", type=float, default=0.05, help="relative increase, default 5%%")
    parser.add_argument("--max-browser-success-drop", type=float, default=0.0)
    parser.add_argument("--max-security-failures-increase", type=float, default=0.0)
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    metrics = value.get("metrics")
    return metrics if isinstance(metrics, dict) else value


def metric(data: dict[str, Any], canonical: str) -> float | None:
    for key in ALIASES[canonical]:
        value = data.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            return float(value)
        if isinstance(value, str):
            try:
                parsed = float(value)
            except ValueError:
                continue
            if math.isfinite(parsed):
                return parsed
    return None


def relative_increase(baseline: float, candidate: float) -> float:
    if baseline == 0:
        return 0.0 if candidate <= 0 else math.inf
    return (candidate - baseline) / abs(baseline)


def main() -> int:
    args = parse_args()
    try:
        baseline = load_json(args.baseline)
        candidate = load_json(args.candidate)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"[candidate-gate] invalid input: {exc}", file=sys.stderr)
        return 2

    regressions: list[str] = []
    checks: dict[str, Any] = {}

    b_success = metric(baseline, "successRate")
    c_success = metric(candidate, "successRate")
    if b_success is None or c_success is None:
        regressions.append("successRate is required for baseline and candidate")
    else:
        drop = b_success - c_success
        checks["successRate"] = {"baseline": b_success, "candidate": c_success, "drop": drop}
        if drop > args.max_success_drop:
            regressions.append(f"successRate drop {drop:.6f} exceeds {args.max_success_drop:.6f}")

    for canonical, threshold, label in (
        ("avgLatencyMs", args.max_latency_increase, "latency"),
        ("avgCostUsd", args.max_cost_increase, "cost"),
    ):
        base = metric(baseline, canonical)
        cand = metric(candidate, canonical)
        if base is None and cand is None:
            continue
        if base is None or cand is None:
            regressions.append(f"{canonical} must be present in both inputs when used")
            continue
        increase = relative_increase(base, cand)
        checks[canonical] = {"baseline": base, "candidate": cand, "relativeIncrease": increase}
        if increase > threshold:
            regressions.append(f"{label} relative increase {increase:.6f} exceeds {threshold:.6f}")

    b_security = metric(baseline, "securityFailures")
    c_security = metric(candidate, "securityFailures")
    if b_security is not None or c_security is not None:
        if b_security is None or c_security is None:
            regressions.append("securityFailures must be present in both inputs when used")
        else:
            increase = c_security - b_security
            checks["securityFailures"] = {"baseline": b_security, "candidate": c_security, "increase": increase}
            if increase > args.max_security_failures_increase:
                regressions.append(
                    f"securityFailures increase {increase:.6f} exceeds {args.max_security_failures_increase:.6f}"
                )

    b_browser = metric(baseline, "browserSuccessRate")
    c_browser = metric(candidate, "browserSuccessRate")
    if b_browser is not None or c_browser is not None:
        if b_browser is None or c_browser is None:
            regressions.append("browserSuccessRate must be present in both inputs when used")
        else:
            drop = b_browser - c_browser
            checks["browserSuccessRate"] = {"baseline": b_browser, "candidate": c_browser, "drop": drop}
            if drop > args.max_browser_success_drop:
                regressions.append(
                    f"browserSuccessRate drop {drop:.6f} exceeds {args.max_browser_success_drop:.6f}"
                )

    allowed = not regressions
    artifact = {
        "schemaVersion": 1,
        "kind": "jarvis-optimization-candidate-gate",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "promotionAllowed": allowed,
        "checks": checks,
        "thresholds": {
            "maxSuccessDrop": args.max_success_drop,
            "maxLatencyIncrease": args.max_latency_increase,
            "maxCostIncrease": args.max_cost_increase,
            "maxBrowserSuccessDrop": args.max_browser_success_drop,
            "maxSecurityFailuresIncrease": args.max_security_failures_increase,
        },
        "regressions": regressions,
        "note": "This artifact is advisory. The script has no production write path and cannot promote a candidate.",
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"promotionAllowed": allowed, "regressions": regressions, "output": str(output)}))
    return 0 if allowed else 1


if __name__ == "__main__":
    raise SystemExit(main())
