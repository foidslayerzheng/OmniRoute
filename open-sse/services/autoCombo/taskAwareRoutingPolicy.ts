/** Conservative task-aware routing policy and bounded autotuner. */
export const TASK_CLASSES = [
  "simple/general", "coding", "reasoning", "research/analysis",
  "long-context", "low-latency/background", "agent/tool", "local/private",
] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];
export type RouteKind = "free" | "local" | "paid";

export interface RoutingRequest {
  prompt: string;
  contextTokens?: number;
  hasTools?: boolean;
  localOnly?: boolean;
  background?: boolean;
  governorAdmitted?: boolean;
}
export interface RouteCandidate {
  model: string;
  provider?: string;
  kind: RouteKind;
  quality: number;
  reliability: number;
  latencyMs?: number;
  contextTokens?: number;
  toolCalling?: boolean;
  available?: boolean;
}
export interface RoutingDecision {
  taskClass: TaskClass;
  candidates: RouteCandidate[];
  reason: string;
  governorAdmitted: boolean;
  adjustments: Record<string, number>;
}
const FREE_MATRIX: Record<TaskClass, string[]> = {
  "simple/general": ["nvidia/nemotron-3-ultra-550b-a55b:free", "nvidia/nemotron-3.5-lightning:free"],
  coding: ["nvidia/nemotron-3.5-lightning:free", "openai/gpt-oss-20b:free", "poolside/laguna-s-2.1:free"],
  reasoning: ["nvidia/nemotron-3-ultra-550b-a55b:free", "nvidia/nemotron-3.5-lightning:free"],
  "research/analysis": ["nvidia/nemotron-3-ultra-550b-a55b:free", "nvidia/nemotron-3.5-lightning:free"],
  "long-context": ["nvidia/nemotron-3-ultra-550b-a55b:free", "nvidia/nemotron-3.5-lightning:free"],
  "low-latency/background": ["nvidia/nemotron-3.5-lightning:free", "poolside/laguna-s-2.1:free"],
  "agent/tool": ["nvidia/nemotron-3.5-lightning:free", "openai/gpt-oss-20b:free"],
  "local/private": ["local-qwen"],
};
export function classifyTask(req: RoutingRequest): TaskClass {
  if (req.localOnly) return "local/private";
  if (req.hasTools) return "agent/tool";
  if (req.background) return "low-latency/background";
  if ((req.contextTokens ?? 0) >= 100_000) return "long-context";
  const p = req.prompt.toLowerCase();
  if (/\b(code|coding|implement|debug|refactor|typescript|javascript|python|sql|function|repository)\b/.test(p)) return "coding";
  if (/\b(prove|derive|reason|reasoning|equation|math|mathematical|step by step|logic)\b/.test(p)) return "reasoning";
  if (/\b(research|analy[sz]e|analysis|compare|evaluate|sources|literature)\b/.test(p)) return "research/analysis";
  return "simple/general";
}
export function preferredModels(taskClass: TaskClass): readonly string[] { return FREE_MATRIX[taskClass]; }
export function rankCandidates(req: RoutingRequest, candidates: RouteCandidate[]): RoutingDecision {
  const taskClass = classifyTask(req);
  const preferred = FREE_MATRIX[taskClass];
  const eligible = candidates.filter(c => c.kind !== "paid" && c.available !== false && (!req.localOnly || c.kind === "local"));
  const usable = eligible.filter(c => (c.contextTokens ?? Infinity) >= (req.contextTokens ?? 0) && (!req.hasTools || c.toolCalling !== false));
  const ranked = [...usable].sort((a, b) => {
    const ai = preferred.indexOf(a.model), bi = preferred.indexOf(b.model);
    const ap = ai < 0 ? 999 : ai, bp = bi < 0 ? 999 : bi;
    return ap - bp || (b.quality + b.reliability) - (a.quality + a.reliability) || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity);
  });
  const adjustments: Record<string, number> = {};
  for (const c of ranked) adjustments[c.model] = Math.max(0, 1 - Math.min(1, preferred.indexOf(c.model) < 0 ? 0 : preferred.indexOf(c.model) * 0.1));
  return { taskClass, candidates: ranked, governorAdmitted: req.governorAdmitted !== false, adjustments,
    reason: req.localOnly ? "local/private policy" : `task matrix: ${taskClass}; paid routes excluded` };
}
export interface TelemetryEvent { taskClass: TaskClass; model: string; provider?: string; success: boolean; latencyMs: number; status?: number; retryCount: number; fallbackCount: number; governorAdmitted: boolean; kind: RouteKind; selectionReason?: string; taskAwareAdjustment?: number; failureClass?: FailureClass; }
export type FailureClass = "429" | "5xx" | "other" | "none";
export function classifyFailure(status?: number): FailureClass { if (!status) return "none"; if (status === 429) return "429"; if (status >= 500) return "5xx"; return "other"; }
export interface TunerWeights { quality: number; reliability: number; latency: number; }
export const DEFAULT_TUNER_WEIGHTS: Readonly<TunerWeights> = { quality: 0.55, reliability: 0.35, latency: 0.10 };
const BOUNDS = { quality: [0.35, 0.75], reliability: [0.2, 0.6], latency: [0.05, 0.25] } as const;
const MIN_TUNER_SAMPLES = 20;
const MAX_PREFERENCE_ADJUSTMENT = 0.03;
const OUTCOME_DECAY_MS = 7 * 24 * 60 * 60 * 1000;

type TunerOutcome = Pick<TelemetryEvent, "taskClass" | "model" | "success" | "latencyMs" | "status"> & {
  recordedAt?: number;
};

export class BoundedRoutingTuner {
  private weights: TunerWeights = { ...DEFAULT_TUNER_WEIGHTS };
  private samples = 0;
  private enabled = true;
  private readonly outcomes = new Map<string, TunerOutcome[]>();

  adjust(observed: Partial<TunerWeights>, sampleCount: number, reason: string) {
    if (!this.enabled || sampleCount < MIN_TUNER_SAMPLES) return { changed: false, reason: "insufficient-sample-or-disabled", weights: { ...this.weights } };
    const next = { ...this.weights };
    for (const key of ["quality", "reliability", "latency"] as const) { const value = observed[key]; if (typeof value === "number" && Number.isFinite(value)) next[key] = Math.min(BOUNDS[key][1], Math.max(BOUNDS[key][0], value)); }
    this.weights = next; this.samples += sampleCount;
    return { changed: true, reason, weights: { ...this.weights } };
  }

  recordOutcome(outcome: TunerOutcome): void {
    if (!this.enabled || classifyFailure(outcome.status) === "429") return;
    const key = `${outcome.taskClass}\u0000${outcome.model}`;
    const recordedAt = outcome.recordedAt ?? Date.now();
    const retained = (this.outcomes.get(key) ?? []).filter((entry) => recordedAt - (entry.recordedAt ?? recordedAt) <= OUTCOME_DECAY_MS);
    retained.push({ ...outcome, recordedAt });
    this.outcomes.set(key, retained);
    this.samples += 1;
  }

  getPreferenceAdjustment(taskClass: TaskClass, model: string, now = Date.now()): number {
    if (!this.enabled) return 0;
    const outcomes = (this.outcomes.get(`${taskClass}\u0000${model}`) ?? []).filter(
      (entry) => now - (entry.recordedAt ?? now) <= OUTCOME_DECAY_MS
    );
    if (outcomes.length < MIN_TUNER_SAMPLES) return 0;
    const successRate = outcomes.filter((entry) => entry.success).length / outcomes.length;
    const avgLatencyMs = outcomes.reduce((total, entry) => total + entry.latencyMs, 0) / outcomes.length;
    const reliabilitySignal = Math.max(0, successRate - 0.5) * 2;
    const latencySignal = Math.max(0, 1 - Math.min(avgLatencyMs, 10_000) / 10_000);
    return Number((MAX_PREFERENCE_ADJUSTMENT * (reliabilitySignal * 0.8 + latencySignal * 0.2)).toFixed(4));
  }

  disable() { this.enabled = false; } enable() { this.enabled = true; }
  rollback() { this.weights = { ...DEFAULT_TUNER_WEIGHTS }; this.outcomes.clear(); this.samples = 0; }
  getState() { return { enabled: this.enabled, samples: this.samples, weights: { ...this.weights } }; }
}

export const runtimeRoutingTuner = new BoundedRoutingTuner();
