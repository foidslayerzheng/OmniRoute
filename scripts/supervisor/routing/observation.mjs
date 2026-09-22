import { z } from "zod";

import { redactValue } from "../redaction.mjs";

const bounded = z.string().max(16_384);
const nullableMetric = z.number().finite().nonnegative().nullable().default(null);

export const RoutingObservationSchema = z
  .object({
    task_id: z.string().min(1).max(240),
    correlation_id: z.string().min(1).max(240),
    task_type: z.string().min(1).max(120),
    executor: z.string().min(1).max(120),
    model: bounded.nullable().default(null),
    provider: bounded.nullable().default(null),
    started_at: z.string().datetime(),
    completed_at: z.string().datetime().nullable().default(null),
    latency_ms: nullableMetric,
    input_tokens: nullableMetric,
    output_tokens: nullableMetric,
    estimated_cost: nullableMetric,
    retries: nullableMetric,
    failure_reason: bounded.nullable().default(null),
    verifier_result: z.enum(["PASS", "FAIL", "BLOCKED"]).nullable().default(null),
    acceptance_result: z.enum(["PASS", "FAIL"]).nullable().default(null),
    success: z.boolean(),
    quality_score: z.number().finite().min(0).max(1).nullable().default(null),
    context_bytes: nullableMetric,
    tool_count: nullableMetric,
    tool_profile: bounded.nullable().default(null),
  })
  .strict();

export function normalizeRoutingObservation(value) {
  return RoutingObservationSchema.parse(redactValue(value));
}

export function observationKey(value) {
  return `${value.task_id}\0${value.correlation_id}`;
}
