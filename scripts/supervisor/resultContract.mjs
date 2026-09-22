import { MAX_RESULT_BYTES, RESULT_FIELDS } from "./constants.mjs";
import { hashEvidence, redactValue } from "./redaction.mjs";
import { HermesResultSchema } from "./schema.mjs";

function list(value, name) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") throw new Error(`${name} must be an array or string`);
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error(`${name} must be an array`);
    return parsed;
  }
  return [trimmed];
}

function evidenceList(value) {
  return list(value, "evidence").map((item) => {
    const record =
      typeof item === "string" ? { type: "other", source: "hermes-result", summary: item } : item;
    const timestamp = record.timestamp ?? new Date().toISOString();
    return { ...record, timestamp, hash: record.hash ?? hashEvidence({ ...record, timestamp }) };
  });
}

function normalize(value) {
  const result = {
    status: value.status,
    task: value.task,
    evidence: evidenceList(value.evidence),
    changes: list(value.changes, "changes"),
    tests: list(value.tests, "tests"),
    blocker: !value.blocker || /^(?:none|null)$/i.test(value.blocker) ? null : value.blocker,
    next_action: value.next_action,
    requires_approval:
      typeof value.requires_approval === "boolean"
        ? value.requires_approval
        : /^(?:yes|true)$/i.test(value.requires_approval),
  };
  return HermesResultSchema.parse(redactValue(result));
}

export function parseHermesResult(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_RESULT_BYTES) {
    throw new Error("Hermes result exceeds size limit");
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    const required = [
      "status",
      "task",
      "evidence",
      "changes",
      "tests",
      "blocker",
      "next_action",
      "requires_approval",
    ];
    const missing = required.filter((field) => !Object.hasOwn(parsed, field));
    if (missing.length) throw new Error(`Missing required fields: ${missing.join(", ")}`);
    return normalize(parsed);
  }
  const values = {};
  for (const line of trimmed.split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid result line: ${line}`);
    if (!RESULT_FIELDS.includes(match[1])) throw new Error(`Unknown result field: ${match[1]}`);
    if (Object.hasOwn(values, match[1])) throw new Error(`Duplicate result field: ${match[1]}`);
    values[match[1]] = match[2];
  }
  const missing = RESULT_FIELDS.filter((field) => !Object.hasOwn(values, field));
  if (missing.length) throw new Error(`Missing required fields: ${missing.join(", ")}`);
  return normalize({
    status: values.STATUS,
    task: values.TASK,
    evidence: values.EVIDENCE,
    changes: values.CHANGES,
    tests: values.TESTS,
    blocker: values.BLOCKER,
    next_action: values.NEXT_ACTION,
    requires_approval: values.REQUIRES_APPROVAL,
  });
}

export function formatHermesPrompt(state) {
  const publicCriteria = state.acceptance_criteria.map(
    ({ expected_evidence: _expectedEvidence, ...criterion }) => criterion
  );
  const context = redactValue({
    mission_id: state.mission_id,
    milestone: state.milestone,
    authoritative_facts: state.authoritative_facts,
    task: state.current_task,
    acceptance_criteria: publicCriteria,
    forbidden_topics: state.forbidden_topics,
    forbidden_paths: state.forbidden_paths,
    forbidden_actions: state.forbidden_actions,
  });
  return `Complete only this bounded task. Do not exceed its scope or request forbidden actions.\nCONTEXT=${JSON.stringify(context)}\nReturn strict JSON when possible, otherwise exactly:\nSTATUS=\nTASK=\nEVIDENCE=\nCHANGES=\nTESTS=\nBLOCKER=\nNEXT_ACTION=\nREQUIRES_APPROVAL=YES/NO`;
}
