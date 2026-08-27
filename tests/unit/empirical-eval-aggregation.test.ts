import test from "node:test";
import assert from "node:assert/strict";
import type { PersistedEvalRun } from "../../src/lib/db/evals.ts";
import {
  MIN_EMPIRICAL_EVAL_SAMPLES,
  aggregateEmpiricalEvalRuns,
  buildEmpiricalShadowScorecard,
  normalizeEmpiricalEvalRuns,
} from "../../src/lib/evals/empiricalAggregation.ts";

function run(overrides: Partial<PersistedEvalRun> = {}): PersistedEvalRun {
  return {
    id: "run-1",
    runGroupId: null,
    suiteId: "suite-1",
    suiteName: "Suite 1",
    target: { type: "model", id: "model-b", key: "model:model-b", label: "Model B" },
    avgLatencyMs: 0,
    summary: { total: 1, passed: 1, failed: 0, passRate: 100 },
    results: [],
    outputs: {},
    createdAt: "2026-08-24T12:00:00.000Z",
    ...overrides,
  } as PersistedEvalRun;
}

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { caseId: "case-1", passed: true, durationMs: 80, ...overrides };
}

test("normalizes telemetry-rich deterministic records without conflating evidence streams", () => {
  const [record] = normalizeEmpiricalEvalRuns([
    run({ results: [result({ telemetry: {
      tags: ["coding"], transportSuccess: false, selectedModel: "model-b", provider: "provider-b",
      latencyMs: 50, retryCount: 2,
      fallbackCount: 1, httpStatus: 503, costUsd: 0.02, costStatus: "reported",
    } })] }),
  ]);
  assert.deepEqual(record, {
    schemaVersion: 1, evidenceStream: "deterministic_eval", model: "model-b",
    taskClass: "coding", suiteId: "suite-1", caseId: "case-1", sourceRunId: "run-1",
    observedAt: "2026-08-24T12:00:00.000Z", evalPassed: true, transportSuccess: false,
    latencyMs: 50, retryCount: 2, fallbackCount: 1, failureClass: "5xx",
    costUsd: 0.02, costStatus: "reported",
  });
});

test("excludes only explicit pre-dispatch transport failures from model evidence", () => {
  const records = normalizeEmpiricalEvalRuns([run({ results: [
    result({ caseId: "pre-dispatch-404", passed: false, telemetry: {
      transportSuccess: false, selectedModel: null, provider: null, httpStatus: 404,
    } }),
    result({ caseId: "dispatched-503", passed: false, telemetry: {
      transportSuccess: false, selectedModel: "model-b", provider: "provider-b", httpStatus: 503,
    } }),
    result({ caseId: "success", passed: true, telemetry: {
      transportSuccess: true, selectedModel: "model-b", provider: "provider-b", httpStatus: 200,
    } }),
    result({ caseId: "legacy", passed: false }),
  ] })]);

  assert.deepEqual(records.map((record) => record.caseId), ["dispatched-503", "success", "legacy"]);
  assert.equal(records[0].evalPassed, false);
  assert.equal(records[0].transportSuccess, false);
  assert.equal(records[0].failureClass, "5xx");
  assert.equal(records[1].evalPassed, true);
  assert.equal(records[1].transportSuccess, true);
  assert.equal(records[2].evalPassed, false);
  assert.equal(records[2].transportSuccess, null);
});

test("accepts legacy records and preserves unknown values as null", () => {
  const [record] = normalizeEmpiricalEvalRuns([run({ results: [result({ durationMs: undefined })] })]);
  assert.equal(record.taskClass, null);
  assert.equal(record.transportSuccess, null);
  assert.equal(record.latencyMs, null);
  assert.equal(record.retryCount, null);
  assert.equal(record.fallbackCount, null);
  assert.equal(record.costUsd, null);
  assert.equal(record.costStatus, null);
});

test("derives task class only from one unambiguous canonical tag", () => {
  const records = normalizeEmpiricalEvalRuns([run({ results: [
    result({ caseId: "one", telemetry: { tags: ["safety", "reasoning"] } }),
    result({ caseId: "none", telemetry: { tags: ["safety"] } }),
    result({ caseId: "many", telemetry: { tags: ["coding", "reasoning"] } }),
  ] })]);
  assert.deepEqual(records.map((entry) => entry.taskClass), ["reasoning", null, null]);
});

test("normalizes latency, counts, bounded failures, and trusted costs", () => {
  const records = normalizeEmpiricalEvalRuns([run({ results: [
    result({ caseId: "preferred", durationMs: 90, telemetry: { latencyMs: 40 } }),
    result({ caseId: "fallback", durationMs: 70 }),
    result({ caseId: "429", telemetry: { httpStatus: 429 } }),
    result({ caseId: "success", telemetry: { transportSuccess: true } }),
    result({ caseId: "unknown", telemetry: { transportSuccess: false, selectedModel: "model-b", provider: "provider-b", httpStatus: 400 } }),
    result({ caseId: "positive", telemetry: { costUsd: 0.3, costStatus: "reported" } }),
    result({ caseId: "free", telemetry: { costUsd: 0, costStatus: "free_route" } }),
    result({ caseId: "cache", telemetry: { costUsd: 0, costStatus: "cache_hit_zero" } }),
    result({ caseId: "unknown-cost", telemetry: { costUsd: 0, costStatus: "unknown" } }),
  ] })]);
  const byCase = new Map(records.map((entry) => [entry.caseId, entry]));
  assert.equal(byCase.get("preferred")?.latencyMs, 40);
  assert.equal(byCase.get("fallback")?.latencyMs, 70);
  assert.equal(byCase.get("429")?.failureClass, "429");
  assert.equal(byCase.get("success")?.failureClass, "none");
  assert.equal(byCase.get("unknown")?.failureClass, null);
  assert.equal(byCase.get("positive")?.costUsd, 0.3);
  assert.equal(byCase.get("free")?.costUsd, 0);
  assert.equal(byCase.get("cache")?.costUsd, 0);
  assert.equal(byCase.get("unknown-cost")?.costUsd, null);
});

test("aggregates each evidence dimension using known samples only", () => {
  const groups = aggregateEmpiricalEvalRuns([run({ results: [
    result({ caseId: "a", passed: true, telemetry: { tags: ["coding"], transportSuccess: true, latencyMs: 10, retryCount: 0, fallbackCount: 2, costUsd: 0.1, costStatus: "reported" } }),
    result({ caseId: "b", passed: false, telemetry: { tags: ["coding"], transportSuccess: false, selectedModel: "model-b", provider: "provider-b", latencyMs: 20, retryCount: 2, fallbackCount: 0, httpStatus: 503, costUsd: 0.3, costStatus: "reported" } }),
    result({ caseId: "c", passed: true, telemetry: { tags: ["coding"], latencyMs: 30 } }),
    result({ caseId: "d", passed: false, telemetry: { tags: ["coding"], latencyMs: 40 } }),
    result({ caseId: "e", passed: true, telemetry: { tags: ["coding"], latencyMs: 100 } }),
  ] })]);
  assert.equal(groups.length, 1);
  const group = groups[0];
  assert.deepEqual(group.deterministicEval, { sampleCount: 5, passCount: 3, failCount: 2, passRate: 0.6 });
  assert.deepEqual(group.transport, { knownSampleCount: 2, successCount: 1, failureCount: 1, successRate: 0.5 });
  assert.deepEqual(group.latency, { knownSampleCount: 5, avgMs: 40, p50Ms: 30, p95Ms: 100 });
  assert.deepEqual(group.retries, { knownSampleCount: 2, avgRetries: 1 });
  assert.deepEqual(group.fallbacks, { knownSampleCount: 2, avgFallbacks: 1 });
  assert.deepEqual(group.failures.countsByClass, { "5xx": 1, none: 1 });
  assert.deepEqual(group.cost, { knownSampleCount: 2, avgUsd: 0.2 });
  assert.deepEqual(group.coverage, { transportKnown: 0.4, retryKnown: 0.4, fallbackKnown: 0.4, costKnown: 0.4 });
});

test("returns null metrics when no samples are known and computes freshness", () => {
  const [group] = aggregateEmpiricalEvalRuns([
    run({ id: "older", createdAt: "2026-01-01T00:00:00.000Z", results: [result()] }),
    run({ id: "newer", createdAt: "2026-02-01T00:00:00.000Z", results: [result({ caseId: "b" })] }),
  ]);
  assert.deepEqual(group.latency, { knownSampleCount: 2, avgMs: 80, p50Ms: 80, p95Ms: 80 });
  assert.deepEqual(group.retries, { knownSampleCount: 0, avgRetries: null });
  assert.deepEqual(group.cost, { knownSampleCount: 0, avgUsd: null });
  assert.deepEqual(group.freshness, { oldestObservedAt: "2026-01-01T00:00:00.000Z", newestObservedAt: "2026-02-01T00:00:00.000Z" });
});

test("orders groups by model then classified task with unclassified last", () => {
  const groups = aggregateEmpiricalEvalRuns([
    run({ id: "z0", target: { type: "model", id: "model-z", key: "model:model-z", label: "Z" }, results: [result()] }),
    run({ id: "a0", target: { type: "model", id: "model-a", key: "model:model-a", label: "A" }, results: [result()] }),
    run({ id: "a1", target: { type: "model", id: "model-a", key: "model:model-a", label: "A" }, results: [result({ telemetry: { tags: ["coding"] } })] }),
  ]);
  assert.deepEqual(groups.map(({ model, taskClass }) => [model, taskClass]), [["model-a", "coding"], ["model-a", null], ["model-z", null]]);
});

test("shadow scorecard uses a five-sample diagnostic guard only", () => {
  assert.equal(MIN_EMPIRICAL_EVAL_SAMPLES, 5);
  const records = Array.from({ length: 5 }, (_, index) => result({ caseId: `c${index}`, telemetry: { tags: ["coding"] } }));
  const below = buildEmpiricalShadowScorecard([run({ results: records.slice(0, 4) })]);
  assert.equal(below[0].eligibleForFutureEmpiricalRouting, false);
  assert.ok(below[0].reasons.includes("insufficient_deterministic_eval_samples"));
  const eligible = buildEmpiricalShadowScorecard([run({ results: records })]);
  assert.equal(eligible[0].eligibleForFutureEmpiricalRouting, true);
  assert.deepEqual(eligible[0].reasons, []);
  const unclassified = buildEmpiricalShadowScorecard([run({ results: records.map((entry) => ({ ...entry, telemetry: {} })) })]);
  assert.equal(unclassified[0].eligibleForFutureEmpiricalRouting, false);
  assert.ok(unclassified[0].reasons.includes("unclassified_task"));
});
