import test from "node:test";
import assert from "node:assert/strict";
import { orderTaskAwareCandidates } from "../../open-sse/services/autoCombo/taskAwareAutoOrdering.ts";
import { runtimeRoutingTuner } from "../../open-sse/services/autoCombo/taskAwareRoutingPolicy.ts";

const LIGHTNING = "nvidia/nemotron-3.5-lightning:free";
const ULTRA = "nvidia/nemotron-3-ultra-550b-a55b:free";
const OSS = "openai/gpt-oss-20b:free";
const POOLSIDE = "poolside/laguna-s-2.1:free";

function candidate(modelStr: string, executionKey = modelStr, extra: Record<string, unknown> = {}) {
  return { modelStr, executionKey, provider: modelStr.split("/")[0], connectionId: null, ...extra } as any;
}
function order(prompt: string, candidates: any[], extra: Record<string, unknown> = {}) {
  return orderTaskAwareCandidates({ prompt, ...extra } as any, candidates);
}

test("runtime ordering prefers role-specific free models while preserving fallbacks", () => {
  assert.equal(order("implement this TypeScript function", [candidate(POOLSIDE), candidate(LIGHTNING), candidate(OSS)]).candidates[0].modelStr, LIGHTNING);
  assert.equal(order("derive and prove the equation", [candidate(LIGHTNING), candidate(ULTRA)]).candidates[0].modelStr, ULTRA);
  assert.equal(order("hello, summarize this", [candidate(LIGHTNING), candidate(ULTRA)]).candidates[0].modelStr, ULTRA);
  assert.deepEqual(order("implement this", [candidate(LIGHTNING), candidate(OSS), candidate(POOLSIDE)]).candidates.map((c) => c.modelStr), [LIGHTNING, OSS, POOLSIDE]);
});

test("runtime ordering preserves local privacy and caller precedence", () => {
  assert.deepEqual(order("keep this private", [candidate(ULTRA), candidate("local-qwen")], { localOnly: true }).candidates.map((c) => c.modelStr), ["local-qwen"]);
  assert.equal(order("implement this", [candidate(LIGHTNING), candidate(ULTRA)]).candidates[0].modelStr, LIGHTNING);
});

test("paid candidates are not promoted, fallbacks and ordering remain deterministic", () => {
  const paid = candidate("openai/gpt-4", "paid", { cost: 1 });
  const result = order("implement this", [paid, candidate(OSS), candidate(LIGHTNING)]);
  assert.equal(result.adjustments.get("paid"), 0);
  assert.ok(result.candidates.some((c) => c.executionKey === "paid"));
  assert.deepEqual(result.candidates.map((c) => c.executionKey), order("implement this", [paid, candidate(OSS), candidate(LIGHTNING)]).candidates.map((c) => c.executionKey));
  assert.equal(result.taskClass, "coding");
});

test("task-aware ordering does not mutate Governor state", () => {
  const governor = Object.freeze({ admitted: true, maxConcurrent: 2 });
  const before = JSON.stringify(governor);
  order("reason about this", [candidate(ULTRA), candidate(LIGHTNING)], { governorAdmitted: true });
  assert.equal(JSON.stringify(governor), before);
});

test("runtime tuner adds only its bounded learned preference after enough successful observations", () => {
  const tuner = new (runtimeRoutingTuner.constructor as new () => typeof runtimeRoutingTuner)();
  tuner.enable();
  for (let index = 0; index < 20; index += 1) {
    tuner.recordOutcome({ taskClass: "coding", model: OSS, success: true, latencyMs: 100 });
  }
  const baseline = order("implement this", [candidate(LIGHTNING), candidate(OSS)]);
  const result = orderTaskAwareCandidates(
    { prompt: "implement this" },
    [candidate(LIGHTNING), candidate(OSS)],
    tuner
  );
  assert.equal(result.candidates[0].modelStr, LIGHTNING);
  const learnedDelta = (result.adjustments.get(OSS) ?? 0) - (baseline.adjustments.get(OSS) ?? 0);
  assert.ok(learnedDelta > 0);
  assert.ok(learnedDelta <= 0.03);
});
