import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeRoutingObservation,
  observationKey,
} from "../../scripts/supervisor/routing/observation.mjs";

test("routing observation preserves unknown metrics as null and has a stable identity", () => {
  const value = normalizeRoutingObservation({
    task_id: "t1",
    correlation_id: "c1",
    task_type: "shell-read",
    executor: "hermes-local",
    provider: null,
    model: null,
    started_at: "2026-09-22T00:00:00.000Z",
    success: true,
  });
  assert.equal(value.latency_ms, null);
  assert.equal(value.estimated_cost, null);
  assert.equal(value.input_tokens, null);
  assert.equal(observationKey(value), "t1\u0000c1");
});

test("routing observation rejects invalid metrics and redacts secrets", () => {
  assert.throws(
    () =>
      normalizeRoutingObservation({
        task_id: "t1",
        correlation_id: "c1",
        task_type: "shell-read",
        executor: "local",
        started_at: "2026-09-22T00:00:00.000Z",
        success: false,
        retries: -1,
      }),
    /expected number to be >=0/i
  );
  const value = normalizeRoutingObservation({
    task_id: "t1",
    correlation_id: "c1",
    task_type: "shell-read",
    executor: "local",
    started_at: "2026-09-22T00:00:00.000Z",
    success: false,
    failure_reason: "api_key=secret-value",
  });
  assert.doesNotMatch(value.failure_reason, /secret-value/);
});
