CREATE TABLE IF NOT EXISTS eval_run_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
  response_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_eval_run_idempotency_created_at
  ON eval_run_idempotency(created_at);
