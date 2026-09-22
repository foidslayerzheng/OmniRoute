import { MAX_DRIFT_CORRECTIONS } from "./constants.mjs";
import { classifyPermission } from "./policy.mjs";

const HEDGE = /\b(probably|should|likely|appears? to|seems?)\b/i;

function evidenceText(evidence) {
  return `${evidence.source ?? ""}\n${evidence.summary ?? ""}`.toLowerCase();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsForbiddenPhrase(text, phrase) {
  const pattern = phrase
    .trim()
    .split(/\s+/)
    .map((part) => escapeRegExp(part))
    .join("\\s+");
  if (!pattern) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`, "iu").test(text);
}

function containsForbiddenPath(text, forbiddenPath) {
  const path = forbiddenPath.trim();
  if (!path) return false;
  const pattern = escapeRegExp(path);
  return new RegExp(`(?<![A-Za-z0-9._~/-])${pattern}(?=$|[/\\\\]|[^A-Za-z0-9._~/-])`, "i").test(
    text
  );
}

export function evaluateAcceptance(state, result) {
  const criteria = state.acceptance_criteria.map((criterion) => {
    const requiredPass = criterion.required_evidence.every((requirement) =>
      result.evidence.some((evidence) => {
        const text = evidenceText(evidence);
        return text.includes(requirement.toLowerCase()) && !HEDGE.test(text);
      })
    );
    const expectedPass = (criterion.expected_evidence ?? []).every((expected) =>
      result.evidence.some(
        (evidence) =>
          evidence.summary.trim().toLowerCase() === expected.trim().toLowerCase() &&
          !HEDGE.test(evidence.summary)
      )
    );
    const pass = requiredPass && expectedPass;
    return { ...criterion, status: pass ? "pass" : "fail" };
  });
  return { complete: criteria.every((criterion) => criterion.status === "pass"), criteria };
}

export function detectDrift(state, result) {
  const combined = [
    result.task,
    result.next_action,
    result.blocker,
    ...(result.changes ?? []),
    ...(result.tests ?? []),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  const taskMismatch =
    result.task.trim().toLowerCase() !== state.current_task.description.trim().toLowerCase();
  const forbidden = [...state.forbidden_topics, ...state.forbidden_actions].find((item) =>
    containsForbiddenPhrase(combined, item)
  );
  const forbiddenPath = state.forbidden_paths.find((item) => containsForbiddenPath(combined, item));
  const relevant = state.acceptance_criteria.some((criterion) =>
    criterion.required_evidence.some((requirement) =>
      result.evidence.some((evidence) => evidenceText(evidence).includes(requirement.toLowerCase()))
    )
  );
  const reasons = [];
  if (taskMismatch) reasons.push("task identity mismatch");
  if (forbidden) reasons.push(`forbidden context: ${forbidden}`);
  if (forbiddenPath) reasons.push(`forbidden context: ${forbiddenPath}`);
  if (!relevant && result.evidence.length)
    reasons.push("evidence unrelated to acceptance criteria");
  return { drift: reasons.length > 0, reasons };
}

export function decideResult(state, result) {
  const permission = classifyPermission(state, result);
  if (permission.decision === "FORBIDDEN")
    return { action: "BLOCKED", reason: permission.reason, permission };
  if (permission.decision === "REQUIRES_USER_APPROVAL") {
    return { action: "WAITING_APPROVAL", reason: permission.reason, permission };
  }
  if (result.blocker || /^(?:BLOCKED|FAILED)$/i.test(result.status)) {
    return { action: "BLOCKED", reason: result.blocker ?? result.status, permission };
  }
  const drift = detectDrift(state, result);
  if (drift.drift) {
    return state.drift_correction_count >= MAX_DRIFT_CORRECTIONS
      ? { action: "BLOCKED", reason: "Drift correction limit reached", drift, permission }
      : { action: "CORRECT", reason: drift.reasons.join("; "), drift, permission };
  }
  const acceptance = evaluateAcceptance(state, result);
  return acceptance.complete
    ? { action: "COMPLETE", reason: "All acceptance criteria passed", acceptance, permission }
    : {
        action: "RETRY_VERIFICATION",
        reason: "Required evidence is missing",
        acceptance,
        permission,
      };
}
