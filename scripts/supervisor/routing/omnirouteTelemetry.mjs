import Database from "better-sqlite3";

import { normalizeRoutingObservation } from "./observation.mjs";

export function readOmniRouteObservations({ databasePath, since = null, limit = 1000 }) {
  if (!databasePath) throw new Error("An explicit OmniRoute database path is required");
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(call_logs)")
        .all()
        .map((row) => row.name)
    );
    for (const required of ["id", "timestamp", "status"]) {
      if (!columns.has(required)) throw new Error(`call_logs missing required column: ${required}`);
    }
    const optional = (name, fallback = "NULL") =>
      columns.has(name) ? name : `${fallback} AS ${name}`;
    const where = since && columns.has("timestamp") ? "WHERE timestamp >= ?" : "";
    const sql = `SELECT id, timestamp, status, ${optional("model")}, ${optional("provider")}, ${optional("duration")}, ${optional("tokens_in")}, ${optional("tokens_out")}, ${optional("request_type", "'unknown'")}, ${optional("correlation_id")}, ${optional("error_summary")} FROM call_logs ${where} ORDER BY timestamp DESC LIMIT ?`;
    const rows = since ? db.prepare(sql).all(since, limit) : db.prepare(sql).all(limit);
    return rows.map((row) =>
      normalizeRoutingObservation({
        task_id: String(row.id),
        correlation_id: row.correlation_id ? String(row.correlation_id) : String(row.id),
        task_type: row.request_type ? String(row.request_type) : "unknown",
        executor: "omniroute",
        model: row.model === null ? null : String(row.model),
        provider: row.provider === null ? null : String(row.provider),
        started_at: new Date(row.timestamp).toISOString(),
        completed_at: null,
        latency_ms: Number.isFinite(row.duration) ? row.duration : null,
        input_tokens: Number.isFinite(row.tokens_in) ? row.tokens_in : null,
        output_tokens: Number.isFinite(row.tokens_out) ? row.tokens_out : null,
        estimated_cost: null,
        retries: null,
        failure_reason: row.error_summary === null ? null : String(row.error_summary),
        verifier_result: null,
        acceptance_result: null,
        success: Number(row.status) >= 200 && Number(row.status) < 400,
        quality_score: null,
        context_bytes: null,
        tool_count: null,
        tool_profile: null,
      })
    );
  } finally {
    db.close();
  }
}
