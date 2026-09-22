import assert from "node:assert/strict";
import test from "node:test";

import { runAdmissionBenchmark, runMockBenchmark } from "../../scripts/supervisor/benchmark.mjs";

test("six-task benchmark measures sequential and parallel scheduler runs", async () => {
  const measured = await runMockBenchmark({ delayMs: 30 });
  assert.equal(measured.dispatch_count, 12);
  assert.equal(measured.retries, 0);
  assert.equal(measured.verifier_count, 12);
  assert.equal(measured.cache_hits, 0);
  assert.ok(measured.parallel_ms < measured.sequential_ms);
  assert.equal(measured.speedup, measured.sequential_ms / measured.parallel_ms);
});

test("endpoint admission benchmark trades queued timeout failures for serialized completion", async () => {
  const measured = await runAdmissionBenchmark({ workMs: 30, inferenceTimeoutMs: 50 });
  assert.equal(measured.old.completed, 1);
  assert.equal(measured.old.timed_out, 2);
  assert.equal(measured.new.completed, 3);
  assert.equal(measured.new.timed_out, 0);
  assert.equal(measured.new.maximum_active, 1);
});
