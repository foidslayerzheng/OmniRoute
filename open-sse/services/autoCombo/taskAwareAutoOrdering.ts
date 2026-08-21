import type { AutoProviderCandidate } from "../combo/types.ts";
import {
  classifyTask,
  preferredModels,
  runtimeRoutingTuner,
  type BoundedRoutingTuner,
  type RoutingRequest,
  type TaskClass,
} from "./taskAwareRoutingPolicy.ts";

export interface TaskAwareOrdering {
  taskClass: TaskClass;
  selectionReason: string;
  adjustments: Map<string, number>;
  candidates: AutoProviderCandidate[];
}

function modelKey(candidate: AutoProviderCandidate): string {
  return candidate.modelStr;
}

function isLocal(candidate: AutoProviderCandidate): boolean {
  return candidate.modelStr === "local-qwen" || candidate.provider === "local-qwen";
}

/**
 * Apply only a bounded, deterministic preference among candidates that have already
 * passed explicit-routing, health, quota, tool/context and budget controls. The
 * underlying candidate set is preserved except for an explicitly local-only request.
 * Paid candidates receive no task-aware boost and therefore are never promoted here.
 */
export function orderTaskAwareCandidates(
  request: RoutingRequest,
  candidates: AutoProviderCandidate[],
  tuner: Pick<BoundedRoutingTuner, "getPreferenceAdjustment"> = runtimeRoutingTuner
): TaskAwareOrdering {
  const taskClass = classifyTask(request);
  const preferred = preferredModels(taskClass);
  const eligible = request.localOnly ? candidates.filter(isLocal) : [...candidates];
  const adjustments = new Map<string, number>();
  for (const candidate of eligible) {
    const preferredIndex = preferred.indexOf(modelKey(candidate));
    const staticAdjustment =
      candidate.modelStr.endsWith(":free") || isLocal(candidate)
        ? preferredIndex < 0
          ? 0
          : Math.max(0.01, 0.12 - preferredIndex * 0.03)
        : 0;
    const learnedAdjustment =
      candidate.modelStr.endsWith(":free") || isLocal(candidate)
        ? tuner.getPreferenceAdjustment(taskClass, modelKey(candidate))
        : 0;
    adjustments.set(candidate.executionKey, staticAdjustment + learnedAdjustment);
  }
  const ordered = [...eligible].sort((left, right) => {
    const adjustmentDelta =
      (adjustments.get(right.executionKey) ?? 0) - (adjustments.get(left.executionKey) ?? 0);
    if (adjustmentDelta !== 0) return adjustmentDelta;
    return left.executionKey.localeCompare(right.executionKey);
  });
  return {
    taskClass,
    selectionReason: `task-aware bounded preference: ${taskClass}; paid candidates not promoted`,
    adjustments,
    candidates: ordered,
  };
}
