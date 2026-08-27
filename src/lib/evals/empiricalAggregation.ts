import type { PersistedEvalRun } from "../db/evals.ts";

export const MIN_EMPIRICAL_EVAL_SAMPLES = 5;

export const CANONICAL_EMPIRICAL_TASK_CLASSES = [
  "simple/general",
  "coding",
  "reasoning",
  "research/analysis",
  "long-context",
  "low-latency/background",
  "agent/tool",
  "local/private",
] as const;

export type EmpiricalTaskClass = (typeof CANONICAL_EMPIRICAL_TASK_CLASSES)[number];
export type EmpiricalEvidenceStream = "deterministic_eval" | "live_runtime";
export type EmpiricalFailureClass = "429" | "5xx" | "none";

export interface EmpiricalEvaluationRecord {
  schemaVersion: 1;
  evidenceStream: EmpiricalEvidenceStream;
  model: string;
  taskClass: EmpiricalTaskClass | null;
  suiteId: string | null;
  caseId: string | null;
  sourceRunId: string | null;
  observedAt: string | null;
  evalPassed: boolean | null;
  transportSuccess: boolean | null;
  latencyMs: number | null;
  retryCount: number | null;
  fallbackCount: number | null;
  failureClass: EmpiricalFailureClass | null;
  costUsd: number | null;
  costStatus: string | null;
}

export interface EmpiricalEvaluationGroup {
  model: string;
  taskClass: EmpiricalTaskClass | null;
  sampleCount: number;
  deterministicEval: { sampleCount: number; passCount: number; failCount: number; passRate: number | null };
  transport: { knownSampleCount: number; successCount: number; failureCount: number; successRate: number | null };
  latency: { knownSampleCount: number; avgMs: number | null; p50Ms: number | null; p95Ms: number | null };
  retries: { knownSampleCount: number; avgRetries: number | null };
  fallbacks: { knownSampleCount: number; avgFallbacks: number | null };
  failures: { countsByClass: Partial<Record<EmpiricalFailureClass, number>> };
  cost: { knownSampleCount: number; avgUsd: number | null };
  freshness: { newestObservedAt: string | null; oldestObservedAt: string | null };
  coverage: { transportKnown: number; retryKnown: number; fallbackKnown: number; costKnown: number };
}

export interface EmpiricalShadowScorecardEntry {
  model: string;
  taskClass: EmpiricalTaskClass | null;
  eligibleForFutureEmpiricalRouting: boolean;
  reasons: string[];
  evidence: EmpiricalEvaluationGroup;
}

type UnknownRecord = Record<string, unknown>;
const CANONICAL_TASK_CLASS_SET = new Set<string>(CANONICAL_EMPIRICAL_TASK_CLASSES);
const TRUSTED_COST_STATUSES = new Set(["reported", "cache_hit_zero", "free_route"]);

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNonNegativeFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function asNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function deriveTaskClass(result: UnknownRecord, telemetry: UnknownRecord | null): EmpiricalTaskClass | null {
  const tagsValue = telemetry?.tags ?? result.tags;
  if (!Array.isArray(tagsValue)) return null;
  const canonical = [...new Set(tagsValue.filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter((tag) => CANONICAL_TASK_CLASS_SET.has(tag)))] as EmpiricalTaskClass[];
  return canonical.length === 1 ? canonical[0] : null;
}

function deriveFailureClass(telemetry: UnknownRecord | null): EmpiricalFailureClass | null {
  const status = asNonNegativeInteger(telemetry?.httpStatus);
  if (status === 429) return "429";
  if (status !== null && status >= 500) return "5xx";
  if (telemetry?.transportSuccess === true) return "none";
  return null;
}

function modelForRun(run: PersistedEvalRun): string | null {
  if (run.target.type !== "model") return null;
  return asNullableString(run.target.id);
}

export function normalizeEmpiricalEvalRuns(runs: readonly PersistedEvalRun[]): EmpiricalEvaluationRecord[] {
  const records: EmpiricalEvaluationRecord[] = [];
  for (const run of runs) {
    const model = modelForRun(run);
    if (!model) continue;
    for (const rawResult of run.results) {
      const result = asRecord(rawResult);
      if (!result) continue;
      const telemetry = asRecord(result.telemetry);
      if (
        telemetry?.transportSuccess === false
        && asNullableString(telemetry.selectedModel) === null
        && asNullableString(telemetry.provider) === null
      ) continue;
      const transportSuccess = typeof telemetry?.transportSuccess === "boolean"
        ? telemetry.transportSuccess
        : null;
      const telemetryLatency = asNonNegativeFinite(telemetry?.latencyMs);
      const durationLatency = asNonNegativeFinite(result.durationMs);
      const costStatus = asNullableString(telemetry?.costStatus);
      const candidateCost = asNonNegativeFinite(telemetry?.costUsd);
      records.push({
        schemaVersion: 1,
        evidenceStream: "deterministic_eval",
        model,
        taskClass: deriveTaskClass(result, telemetry),
        suiteId: asNullableString(run.suiteId),
        caseId: asNullableString(result.caseId),
        sourceRunId: asNullableString(run.id),
        observedAt: asNullableString(run.createdAt),
        evalPassed: typeof result.passed === "boolean" ? result.passed : null,
        transportSuccess,
        latencyMs: telemetryLatency ?? durationLatency,
        retryCount: asNonNegativeInteger(telemetry?.retryCount),
        fallbackCount: asNonNegativeInteger(telemetry?.fallbackCount),
        failureClass: deriveFailureClass(telemetry),
        costUsd: costStatus !== null && TRUSTED_COST_STATUSES.has(costStatus) ? candidateCost : null,
        costStatus,
      });
    }
  }
  return records;
}

function mean(values: readonly number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percentileNearestRank(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1];
}

function coverage(known: number, total: number): number {
  return total > 0 ? known / total : 0;
}

function aggregateRecords(records: readonly EmpiricalEvaluationRecord[]): EmpiricalEvaluationGroup[] {
  const grouped = new Map<string, EmpiricalEvaluationRecord[]>();
  for (const record of records) {
    const key = JSON.stringify([record.model, record.taskClass]);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(record);
    else grouped.set(key, [record]);
  }

  return [...grouped.values()].map((groupRecords): EmpiricalEvaluationGroup => {
    const first = groupRecords[0];
    const evaluated = groupRecords.filter((record) => record.evalPassed !== null);
    const passed = evaluated.filter((record) => record.evalPassed === true).length;
    const transport = groupRecords.filter((record) => record.transportSuccess !== null);
    const transportSuccesses = transport.filter((record) => record.transportSuccess === true).length;
    const latencies = groupRecords.flatMap((record) => record.latencyMs === null ? [] : [record.latencyMs]);
    const retries = groupRecords.flatMap((record) => record.retryCount === null ? [] : [record.retryCount]);
    const fallbacks = groupRecords.flatMap((record) => record.fallbackCount === null ? [] : [record.fallbackCount]);
    const costs = groupRecords.flatMap((record) => record.costUsd === null ? [] : [record.costUsd]);
    const dates = groupRecords.flatMap((record) => {
      if (record.observedAt === null || !Number.isFinite(Date.parse(record.observedAt))) return [];
      return [record.observedAt];
    }).sort((left, right) => Date.parse(left) - Date.parse(right));
    const countsByClass: Partial<Record<EmpiricalFailureClass, number>> = {};
    for (const record of groupRecords) {
      if (record.failureClass !== null) {
        countsByClass[record.failureClass] = (countsByClass[record.failureClass] ?? 0) + 1;
      }
    }
    const sampleCount = groupRecords.length;
    return {
      model: first.model,
      taskClass: first.taskClass,
      sampleCount,
      deterministicEval: {
        sampleCount: evaluated.length,
        passCount: passed,
        failCount: evaluated.length - passed,
        passRate: evaluated.length > 0 ? passed / evaluated.length : null,
      },
      transport: {
        knownSampleCount: transport.length,
        successCount: transportSuccesses,
        failureCount: transport.length - transportSuccesses,
        successRate: transport.length > 0 ? transportSuccesses / transport.length : null,
      },
      latency: {
        knownSampleCount: latencies.length,
        avgMs: mean(latencies),
        p50Ms: percentileNearestRank(latencies, 0.5),
        p95Ms: percentileNearestRank(latencies, 0.95),
      },
      retries: { knownSampleCount: retries.length, avgRetries: mean(retries) },
      fallbacks: { knownSampleCount: fallbacks.length, avgFallbacks: mean(fallbacks) },
      failures: { countsByClass },
      cost: { knownSampleCount: costs.length, avgUsd: mean(costs) },
      freshness: {
        newestObservedAt: dates.length > 0 ? dates[dates.length - 1] : null,
        oldestObservedAt: dates.length > 0 ? dates[0] : null,
      },
      coverage: {
        transportKnown: coverage(transport.length, sampleCount),
        retryKnown: coverage(retries.length, sampleCount),
        fallbackKnown: coverage(fallbacks.length, sampleCount),
        costKnown: coverage(costs.length, sampleCount),
      },
    };
  }).sort((left, right) => {
    const modelOrder = left.model.localeCompare(right.model);
    if (modelOrder !== 0) return modelOrder;
    if (left.taskClass === null) return right.taskClass === null ? 0 : 1;
    if (right.taskClass === null) return -1;
    return left.taskClass.localeCompare(right.taskClass);
  });
}

export function aggregateEmpiricalEvaluationRecords(
  records: readonly EmpiricalEvaluationRecord[]
): EmpiricalEvaluationGroup[] {
  return aggregateRecords(records.filter((record) => record.evidenceStream === "deterministic_eval"));
}

export function aggregateEmpiricalEvalRuns(runs: readonly PersistedEvalRun[]): EmpiricalEvaluationGroup[] {
  return aggregateRecords(normalizeEmpiricalEvalRuns(runs));
}

export function buildEmpiricalShadowScorecard(
  runs: readonly PersistedEvalRun[]
): EmpiricalShadowScorecardEntry[] {
  return aggregateEmpiricalEvalRuns(runs).map((evidence) => {
    const reasons: string[] = [];
    if (evidence.taskClass === null) reasons.push("unclassified_task");
    if (evidence.deterministicEval.sampleCount < MIN_EMPIRICAL_EVAL_SAMPLES) {
      reasons.push("insufficient_deterministic_eval_samples");
    }
    if (evidence.deterministicEval.passRate === null) reasons.push("unknown_pass_rate");
    return {
      model: evidence.model,
      taskClass: evidence.taskClass,
      eligibleForFutureEmpiricalRouting: reasons.length === 0,
      reasons,
      evidence,
    };
  });
}
