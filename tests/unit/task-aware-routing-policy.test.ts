import test from "node:test";
import assert from "node:assert/strict";
import { classifyTask, rankCandidates, classifyFailure, BoundedRoutingTuner, DEFAULT_TUNER_WEIGHTS } from "../../open-sse/services/autoCombo/taskAwareRoutingPolicy.ts";
const models = [
  { model: "nvidia/nemotron-3-ultra-550b-a55b:free", kind: "free" as const, quality: .9, reliability: .9, contextTokens: 200000, toolCalling: true },
  { model: "nvidia/nemotron-3.5-lightning:free", kind: "free" as const, quality: .85, reliability: .85, latencyMs: 1000, contextTokens: 100000, toolCalling: true },
  { model: "poolside/laguna-s-2.1:free", kind: "free" as const, quality: .7, reliability: .5, latencyMs: 500, contextTokens: 32000, toolCalling: false },
  { model: "paid/frontier", kind: "paid" as const, quality: 1, reliability: 1, contextTokens: 1000000, toolCalling: true },
];
test("classifies all task classes", () => {
  assert.equal(classifyTask({ prompt: "hi" }), "simple/general");
  assert.equal(classifyTask({ prompt: "implement a python function" }), "coding");
  assert.equal(classifyTask({ prompt: "prove this equation step by step" }), "reasoning");
  assert.equal(classifyTask({ prompt: "research and compare sources" }), "research/analysis");
  assert.equal(classifyTask({ prompt: "summarize", contextTokens: 100000 }), "long-context");
  assert.equal(classifyTask({ prompt: "title", background: true }), "low-latency/background");
  assert.equal(classifyTask({ prompt: "call the tool", hasTools: true }), "agent/tool");
  assert.equal(classifyTask({ prompt: "private", localOnly: true }), "local/private");
});
test("free-only ranking and context/tool constraints", () => {
  const d = rankCandidates({ prompt: "implement code", hasTools: true }, models);
  assert.equal(d.taskClass, "agent/tool");
  assert.ok(d.candidates.every(c => c.kind !== "paid"));
  assert.ok(!d.candidates.some(c => c.model.includes("laguna")));
});
test("local/private excludes cloud", () => assert.deepEqual(rankCandidates({ prompt: "x", localOnly: true }, [{ model: "local-qwen", kind: "local", quality: .8, reliability: .8 }]).candidates.map(x => x.model), ["local-qwen"]));
test("failure categories and bounded tuner", () => {
  assert.equal(classifyFailure(429), "429"); assert.equal(classifyFailure(503), "5xx");
  const t = new BoundedRoutingTuner();
  assert.equal(t.adjust({ quality: 1 }, 1, "burst").changed, false);
  t.adjust({ quality: 1, reliability: 0, latency: 1 }, 20, "measured");
  const s = t.getState(); assert.deepEqual(s.weights, { quality: .75, reliability: .2, latency: .25 });
  t.rollback(); assert.deepEqual(t.getState().weights, DEFAULT_TUNER_WEIGHTS); t.disable();
  assert.equal(t.adjust({ quality: .7 }, 100, "disabled").changed, false);
});
