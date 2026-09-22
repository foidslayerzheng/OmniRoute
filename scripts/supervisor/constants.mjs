export const TASK_STATUSES = Object.freeze([
  "PENDING",
  "RUNNING",
  "WAITING_RESULT",
  "VERIFYING",
  "CORRECTING",
  "WAITING_APPROVAL",
  "BLOCKED",
  "COMPLETE",
  "FAILED",
]);

export const PERMISSION_DECISIONS = Object.freeze([
  "AUTO_CONTINUE",
  "REQUIRES_USER_APPROVAL",
  "FORBIDDEN",
]);

export const EVIDENCE_TYPES = Object.freeze([
  "command_output",
  "test",
  "file",
  "service_state",
  "git_state",
  "other",
]);

export const MAX_AUTONOMOUS_ATTEMPTS = 3;
export const MAX_DRIFT_CORRECTIONS = 1;
export const MAX_RESULT_BYTES = 65_536;
export const RESULT_FIELDS = Object.freeze([
  "STATUS",
  "TASK",
  "EVIDENCE",
  "CHANGES",
  "TESTS",
  "BLOCKER",
  "NEXT_ACTION",
  "REQUIRES_APPROVAL",
]);
