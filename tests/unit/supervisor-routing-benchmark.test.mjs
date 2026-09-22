import assert from "node:assert/strict";
import test from "node:test";

import { runRoutingBenchmark } from "../../scripts/supervisor/routing/benchmark.mjs";

test("three-mode routing benchmark reports all representative task classes and measurements", async () => {
  const report = await runRoutingBenchmark();
  assert.deepEqual(report.task_classes, [
    "shell-read",
    "coding-edit",
    "test-debug",
    "research",
    "verifier-heavy",
    "failure-retry",
  ]);
  for (const mode of ["baseline", "empirical", "empirical_jev"]) {
    assert.equal(report[mode].tasks, 6);
    assert.ok(report[mode].completion_rate >= 0 && report[mode].completion_rate <= 1);
    assert.ok(report[mode].verifier_pass_rate >= 0 && report[mode].verifier_pass_rate <= 1);
    assert.ok(report[mode].runtime_ms >= 0);
    assert.ok(report[mode].context_bytes >= 0);
    assert.ok(report[mode].routing_overhead_ms >= 0);
  }
});
