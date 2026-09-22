import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { EndpointAdmissionGate } from "./endpointAdmissionGate.mjs";
import { ResourceLockManager } from "./resourceLocks.mjs";
import { SupervisorScheduler } from "./scheduler.mjs";

function benchmarkTasks() {
  const make = (id, overrides = {}) => ({
    task_id: id,
    description: `Run ${id}`,
    depends_on: [],
    resources: [],
    can_parallelize: true,
    acceptance_criteria: [
      { id: `${id}-proof`, description: `${id} proof`, required_evidence: [id], status: "pending" },
    ],
    verifiers: [{ verifier_id: `verify-${id}` }],
    max_attempts: 3,
    requires_approval: false,
    ...overrides,
  });
  return [
    make("independent-a"),
    make("conflict-a", { resources: [{ id: "path:/tmp/benchmark-shared", mode: "write" }] }),
    make("independent-b"),
    make("conflict-b", { resources: [{ id: "path:/tmp/benchmark-shared", mode: "write" }] }),
    make("independent-c"),
    make("dependent", { depends_on: ["independent-a"] }),
  ];
}

function adapterFactory(delayMs) {
  return (lane) => ({
    async send_task(task) {
      return task;
    },
    async wait_for_result() {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return JSON.stringify({
        status: "COMPLETE",
        task: lane.description,
        evidence: [{ type: "other", source: lane.task_id, summary: lane.task_id }],
        changes: [],
        tests: ["NOT_RUN"],
        blocker: null,
        next_action: "none",
        requires_approval: false,
      });
    },
  });
}

function verifierHarness() {
  return {
    count: 0,
    async run(spec) {
      this.count += 1;
      return {
        verifier_id: spec.verifier_id,
        status: "PASS",
        evidence: [],
        reason: "fixture pass",
        retryable: false,
        cache_hit: false,
      };
    },
  };
}

async function measuredRun(root, missionId, concurrency, delayMs) {
  const verifier = verifierHarness();
  const scheduler = new SupervisorScheduler({
    root,
    missionId,
    adapterFactory: adapterFactory(delayMs),
    lockManager: new ResourceLockManager(root),
    verifierHarness: verifier,
    maxConcurrency: concurrency,
  });
  await scheduler.initialize({
    goal: "benchmark",
    tasks: benchmarkTasks(),
    max_concurrency: concurrency,
  });
  const started = performance.now();
  const state = await scheduler.run();
  const elapsed = performance.now() - started;
  return { elapsed, state };
}

export async function runMockBenchmark({ delayMs = 80 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervisor-benchmark-"));
  const sequential = await measuredRun(root, "sequential", 1, delayMs);
  const parallel = await measuredRun(root, "parallel", 3, delayMs);
  return {
    sequential_ms: sequential.elapsed,
    parallel_ms: parallel.elapsed,
    speedup: sequential.elapsed / parallel.elapsed,
    dispatch_count: sequential.state.metrics.dispatch_count + parallel.state.metrics.dispatch_count,
    retries: sequential.state.metrics.retries + parallel.state.metrics.retries,
    verifier_count: sequential.state.metrics.verifier_count + parallel.state.metrics.verifier_count,
    cache_hits:
      sequential.state.metrics.evidence_cache_hits + parallel.state.metrics.evidence_cache_hits,
    sequential_metrics: sequential.state.metrics,
    parallel_metrics: parallel.state.metrics,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runAdmissionBenchmark({ workMs = 80, inferenceTimeoutMs = 150 } = {}) {
  let serverTail = Promise.resolve();
  const oldStarted = performance.now();
  const oldResults = await Promise.all(
    Array.from({ length: 3 }, async () => {
      const completion = serverTail.then(() => delay(workMs));
      serverTail = completion;
      return Promise.race([
        completion.then(() => "completed"),
        delay(inferenceTimeoutMs).then(() => "timed_out"),
      ]);
    })
  );
  const oldElapsed = performance.now() - oldStarted;

  const root = await mkdtemp(path.join(os.tmpdir(), "supervisor-admission-benchmark-"));
  let active = 0;
  let maximumActive = 0;
  const newStarted = performance.now();
  const newResults = await Promise.all(
    Array.from({ length: 3 }, async (_, index) => {
      const gate = new EndpointAdmissionGate({
        root,
        endpointKey: "http://127.0.0.1:8080/v1",
        capacity: 1,
        queueTimeoutMs: workMs * 5,
      });
      const lease = await gate.acquire({
        task_id: `task-${index}`,
        attempt_id: `attempt-${index}`,
      });
      try {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        return await Promise.race([
          delay(workMs).then(() => "completed"),
          delay(inferenceTimeoutMs).then(() => "timed_out"),
        ]);
      } finally {
        active -= 1;
        await lease.release();
      }
    })
  );
  const newElapsed = performance.now() - newStarted;
  const summarize = (results, elapsedMs, maximum = null) => ({
    completed: results.filter((result) => result === "completed").length,
    timed_out: results.filter((result) => result === "timed_out").length,
    elapsed_ms: elapsedMs,
    ...(maximum === null ? {} : { maximum_active: maximum }),
  });
  return {
    old: summarize(oldResults, oldElapsed),
    new: summarize(newResults, newElapsed, maximumActive),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(
    `${JSON.stringify(
      { scheduler: await runMockBenchmark(), admission: await runAdmissionBenchmark() },
      null,
      2
    )}\n`
  );
}
