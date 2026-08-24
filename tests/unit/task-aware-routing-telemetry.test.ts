import test from "node:test";
import assert from "node:assert/strict";
import { getComboMetrics, recordComboRequest, resetAllComboMetrics } from "../../open-sse/services/comboMetrics.ts";
import { runtimeRoutingTuner } from "../../open-sse/services/autoCombo/taskAwareRoutingPolicy.ts";
import { toRecordedTarget } from "../../open-sse/services/combo/comboPredicates.ts";

test("combo telemetry preserves existing metrics and records task-aware fields", () => {
  resetAllComboMetrics();
  const governor = Object.freeze({ admitted: true });
  recordComboRequest("telemetry-test", "nvidia/nemotron-3.5-lightning:free", {
    success: true,
    latencyMs: 123,
    fallbackCount: 2,
    target: {
      executionKey: "lightning",
      provider: "nvidia",
      taskAwareTelemetry: {
        taskClass: "coding",
        selectionReason: "preferred-free-model",
        taskAwareAdjustment: 0.25,
        localOrCloud: "cloud",
        freeOrPaid: "free",
        governorDecision: true,
      },
    },
    telemetry: { failureClass: "none" },
  });
  recordComboRequest("telemetry-test", "openai/gpt-4", {
    success: false,
    latencyMs: 77,
    target: { executionKey: "paid", provider: "openai" },
    telemetry: { localOrCloud: "cloud", freeOrPaid: "paid", failureClass: "429" },
  });
  const metrics = getComboMetrics("telemetry-test");
  assert.ok(metrics);
  assert.equal(metrics.totalRequests, 2);
  assert.equal(metrics.totalSuccesses, 1);
  assert.equal(metrics.totalFailures, 1);
  assert.equal(metrics.totalLatencyMs, 200);
  assert.equal(metrics.totalFallbacks, 2);
  assert.equal(metrics.byModel["nvidia/nemotron-3.5-lightning:free"].successes, 1);
  assert.equal(metrics.byTarget.lightning.provider, "nvidia");
  assert.deepEqual(metrics.telemetry, {
    taskClass: "coding",
    selectionReason: "preferred-free-model",
    taskAwareAdjustment: 0.25,
    localOrCloud: "cloud",
    freeOrPaid: "paid",
    governorDecision: true,
    failureClass: "429",
  });
  assert.equal(governor.admitted, true);
});

test("task-aware free successes feed the bounded runtime tuner", () => {
  resetAllComboMetrics();
  runtimeRoutingTuner.rollback();
  runtimeRoutingTuner.enable();
  for (let index = 0; index < 20; index += 1) {
    recordComboRequest("telemetry-tuner", "nvidia/nemotron-3.5-lightning:free", {
      success: true,
      latencyMs: 100,
      target: {
        executionKey: "lightning",
        taskAwareTelemetry: { taskClass: "coding", freeOrPaid: "free" },
      },
    });
  }
  assert.ok(
    runtimeRoutingTuner.getPreferenceAdjustment(
      "coding",
      "nvidia/nemotron-3.5-lightning:free"
    ) > 0
  );
  runtimeRoutingTuner.rollback();
});

test("recorded targets carry task-aware telemetry into runtime metrics", () => {
  const target = toRecordedTarget({
    kind: "model",
    stepId: "coding",
    executionKey: "lightning",
    modelStr: "nvidia/nemotron-3.5-lightning:free",
    provider: "nvidia",
    providerId: null,
    connectionId: null,
    weight: 1,
    label: null,
    taskAwareTelemetry: {
      taskClass: "coding",
      selectionReason: "task-aware bounded preference: coding; paid candidates not promoted",
      taskAwareAdjustment: 0.12,
      localOrCloud: "cloud",
      freeOrPaid: "free",
    },
  });

  assert.deepEqual(target.taskAwareTelemetry, {
    taskClass: "coding",
    selectionReason: "task-aware bounded preference: coding; paid candidates not promoted",
    taskAwareAdjustment: 0.12,
    localOrCloud: "cloud",
    freeOrPaid: "free",
  });
});
