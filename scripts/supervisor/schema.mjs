import { createHash } from "node:crypto";
import { z } from "zod";

import {
  EVIDENCE_TYPES,
  MAX_AUTONOMOUS_ATTEMPTS,
  PERMISSION_DECISIONS,
  TASK_STATUSES,
} from "./constants.mjs";

const bounded = z.string().max(16_384);
export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1).max(200),
  description: bounded.min(1),
  required_evidence: z.array(z.string().min(1).max(500)).min(1),
  expected_evidence: z.array(z.string().min(1).max(500)).default([]),
  status: z.enum(["pending", "pass", "fail"]),
});
export const EvidenceSchema = z.object({
  type: z.enum(EVIDENCE_TYPES),
  source: bounded.min(1),
  summary: bounded.min(1),
  timestamp: z.string().min(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const HermesResultSchema = z
  .object({
    status: bounded.min(1),
    task: bounded.min(1),
    evidence: z.array(
      z.object({
        type: z.enum(EVIDENCE_TYPES),
        source: bounded.min(1),
        summary: bounded.min(1),
        timestamp: z.string().optional(),
        hash: z.string().optional(),
      })
    ),
    changes: z.array(bounded),
    tests: z.array(bounded),
    blocker: bounded.nullable(),
    next_action: bounded,
    requires_approval: z.boolean(),
  })
  .strict();

export const SupervisorStateSchema = z.object({
  schema_version: z.literal(1),
  mission_id: z.string().min(1),
  milestone: bounded.min(1),
  goal: bounded.min(1),
  status: z.enum(TASK_STATUSES),
  transition_timestamps: z.record(z.string(), z.string()),
  transition_history: z.array(
    z.object({ from: z.string().nullable(), to: z.enum(TASK_STATUSES), timestamp: z.string() })
  ),
  authoritative_facts: z.array(bounded),
  current_task: z.object({
    task_id: z.string().min(1),
    attempt_id: z.string().nullable(),
    description: bounded.min(1),
    mutating: z.boolean(),
    scope: z.array(bounded),
    dispatch_state: z.enum(["not_dispatched", "dispatched", "result_received", "uncertain"]),
    adapter_handle: z.string().nullable(),
  }),
  acceptance_criteria: z.array(AcceptanceCriterionSchema).min(1),
  forbidden_topics: z.array(bounded),
  forbidden_paths: z.array(bounded),
  forbidden_actions: z.array(bounded),
  evidence: z.array(EvidenceSchema),
  blocker: bounded.nullable(),
  next_action: bounded,
  requires_user_approval: z.boolean(),
  permission_decision: z.enum(PERMISSION_DECISIONS),
  execution_retry_count: z.number().int().nonnegative(),
  drift_correction_count: z.number().int().nonnegative(),
  verification_retry_count: z.number().int().nonnegative(),
  attempt_count: z.number().int().nonnegative(),
  max_attempts: z.number().int().min(1).max(MAX_AUTONOMOUS_ATTEMPTS),
  latest_result: HermesResultSchema.nullable(),
  sequence: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});

export function createInitialState(input) {
  const now = new Date().toISOString();
  const taskId =
    input.current_task.task_id ??
    `task-${createHash("sha256")
      .update(`${input.mission_id}\0${input.current_task.description}`)
      .digest("hex")
      .slice(0, 16)}`;
  return SupervisorStateSchema.parse({
    schema_version: 1,
    mission_id: input.mission_id,
    milestone: input.milestone,
    goal: input.goal,
    status: "PENDING",
    transition_timestamps: { PENDING: now },
    transition_history: [{ from: null, to: "PENDING", timestamp: now }],
    authoritative_facts: [...(input.authoritative_facts ?? [])],
    current_task: {
      task_id: taskId,
      attempt_id: null,
      description: input.current_task.description,
      mutating: input.current_task.mutating ?? false,
      scope: [...(input.current_task.scope ?? [])],
      dispatch_state: "not_dispatched",
      adapter_handle: null,
    },
    acceptance_criteria: input.acceptance_criteria,
    forbidden_topics: [...(input.forbidden_topics ?? [])],
    forbidden_paths: [...(input.forbidden_paths ?? [])],
    forbidden_actions: [...(input.forbidden_actions ?? [])],
    evidence: [],
    blocker: null,
    next_action: "dispatch",
    requires_user_approval: false,
    permission_decision: "AUTO_CONTINUE",
    execution_retry_count: 0,
    drift_correction_count: 0,
    verification_retry_count: 0,
    attempt_count: 0,
    max_attempts: input.max_attempts ?? MAX_AUTONOMOUS_ATTEMPTS,
    latest_result: null,
    sequence: 0,
    created_at: now,
    updated_at: now,
  });
}
