import { mkdir, open } from "node:fs/promises";
import path from "node:path";

import { hashEvidence, redactValue } from "./redaction.mjs";

export async function appendAuditEvent(auditPath, event) {
  await mkdir(path.dirname(auditPath), { recursive: true, mode: 0o700 });
  const evidence = (event.evidence ?? []).map((item) => {
    const compact = redactValue({
      type: item.type ?? "other",
      source: item.source ?? "unknown",
      summary: item.summary ?? "",
    });
    return { ...compact, hash: item.hash ?? hashEvidence(compact) };
  });
  const record = redactValue({
    timestamp: new Date().toISOString(),
    mission_id: event.mission_id,
    lane_id: event.lane_id ?? null,
    task_id: event.task_id ?? null,
    attempt_id: event.attempt_id ?? null,
    correlation_id: event.correlation_id ?? null,
    prompt_hash: event.prompt_hash ?? null,
    hermes_status: event.hermes_status ?? null,
    supervisor_decision: event.supervisor_decision,
    evidence,
    routing: event.routing ?? null,
    approval_stop_reason: event.approval_stop_reason ?? null,
  });
  const handle = await open(auditPath, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return record;
}
