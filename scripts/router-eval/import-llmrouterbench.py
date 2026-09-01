#!/usr/bin/env python3
"""Convert LLMRouterBench records into OmniRoute RouterObservation NDJSON.

This adapter is intentionally offline-only. It does not change OmniRoute routing.
It converts model/router evaluation records into the existing router-eval corpus
shape so the repository's normal regression tooling remains authoritative.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="LLMRouterBench JSON or JSONL input")
    parser.add_argument("--output", required=True, help="RouterObservation NDJSON output")
    parser.add_argument(
        "--success-threshold",
        type=float,
        default=0.5,
        help="score >= threshold counts as success (default: 0.5)",
    )
    parser.add_argument(
        "--config-id",
        default=None,
        help="force one configId; otherwise router/config/model fields are used",
    )
    parser.add_argument(
        "--timestamp",
        default=None,
        help="fallback ISO timestamp; defaults to current UTC time",
    )
    return parser.parse_args()


def _records_from_json(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, list):
        for item in value:
            if isinstance(item, dict):
                yield item
        return
    if isinstance(value, dict):
        records = value.get("records")
        if isinstance(records, list):
            for item in records:
                if isinstance(item, dict):
                    merged = dict(item)
                    for key in ("dataset_id", "split", "model_name"):
                        if key not in merged and key in value:
                            merged[key] = value[key]
                    yield merged
            return
        yield value


def read_records(path: Path) -> list[dict[str, Any]]:
    text = path.read_text(encoding="utf-8")
    stripped = text.lstrip()
    if not stripped:
        return []
    if stripped[0] in "[{":
        try:
            return list(_records_from_json(json.loads(text)))
        except json.JSONDecodeError:
            pass

    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid JSONL at line {line_number}: {exc}") from exc
        records.extend(_records_from_json(value))
    return records


def first_string(record: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, (int, float)):
            return str(value)
    return None


def first_number(record: dict[str, Any], *keys: str, default: float = 0.0) -> float:
    for key in keys:
        value = record.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            try:
                return float(value)
            except ValueError:
                continue
    return default


def build_sample_id(record: dict[str, Any], index: int) -> str:
    explicit = first_string(record, "sample_id", "sampleId", "id")
    if explicit:
        return explicit
    dataset = first_string(record, "dataset_id", "dataset", "benchmark") or "dataset"
    split = first_string(record, "split") or "unknown"
    record_index = first_string(record, "record_index", "index") or str(index)
    return f"llmrouterbench:{dataset}:{split}:{record_index}"


def to_observation(
    record: dict[str, Any], index: int, success_threshold: float, forced_config_id: str | None, fallback_timestamp: str
) -> dict[str, Any]:
    model = first_string(record, "selected_model", "selectedModel", "model_name", "model")
    expected_model = first_string(record, "expected_model", "expectedModel", "requested_model")
    config_id = forced_config_id or first_string(
        record,
        "config_id",
        "configId",
        "router_name",
        "router",
        "routing_algorithm",
    )
    if not config_id:
        config_id = f"best-single:{model or 'unknown-model'}"

    score = first_number(record, "score", "reward", "accuracy", default=0.0)
    explicit_success = record.get("success")
    if isinstance(explicit_success, bool):
        success = explicit_success
    else:
        success = score >= success_threshold

    latency_ms = first_number(record, "latency_ms", "latencyMs", "duration_ms", "durationMs", default=0.0)
    cost_usd = first_number(record, "cost", "cost_usd", "costUsd", default=0.0)
    timestamp = first_string(record, "timestamp", "created_at", "createdAt") or fallback_timestamp

    prompt = record.get("prompt")
    origin_query = record.get("origin_query")
    route_input: dict[str, Any] = {
        "origin_query": origin_query if origin_query is not None else prompt,
        "prompt": prompt if prompt is not None else origin_query,
        "dataset_id": record.get("dataset_id"),
        "split": record.get("split"),
    }

    metadata = {
        "source": "LLMRouterBench",
        "datasetId": record.get("dataset_id"),
        "split": record.get("split"),
        "recordIndex": record.get("record_index", record.get("index", index)),
        "score": score,
        "groundTruth": record.get("ground_truth"),
        "promptTokens": record.get("prompt_tokens"),
        "completionTokens": record.get("completion_tokens"),
    }

    return {
        "sampleId": build_sample_id(record, index),
        "routeInput": route_input,
        "configId": config_id,
        "selectedModel": model,
        "expectedModel": expected_model,
        "latencyMs": latency_ms,
        "costUsd": cost_usd,
        "success": success,
        "timestamp": timestamp,
        "metadata": metadata,
    }


def main() -> int:
    args = parse_args()
    input_path = Path(args.input).resolve()
    output_path = Path(args.output).resolve()
    if not input_path.is_file():
        print(f"[llmrouterbench] input missing: {input_path}", file=sys.stderr)
        return 2

    fallback_timestamp = args.timestamp or datetime.now(timezone.utc).isoformat()
    try:
        records = read_records(input_path)
    except (OSError, ValueError) as exc:
        print(f"[llmrouterbench] failed to read input: {exc}", file=sys.stderr)
        return 2

    observations = [
        to_observation(record, index, args.success_threshold, args.config_id, fallback_timestamp)
        for index, record in enumerate(records)
    ]
    if not observations:
        print("[llmrouterbench] no records found", file=sys.stderr)
        return 2

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        for observation in observations:
            handle.write(json.dumps(observation, ensure_ascii=False, separators=(",", ":")) + "\n")

    successes = sum(1 for observation in observations if observation["success"])
    configs = len({observation["configId"] for observation in observations})
    print(
        json.dumps(
            {
                "inputRecords": len(records),
                "outputObservations": len(observations),
                "successes": successes,
                "configs": configs,
                "output": str(output_path),
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
