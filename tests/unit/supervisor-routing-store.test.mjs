import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { readOmniRouteObservations } from "../../scripts/supervisor/routing/omnirouteTelemetry.mjs";
import { RoutingObservationStore } from "../../scripts/supervisor/routing/observationStore.mjs";

const observation = (id, success = true, overrides = {}) => ({
  task_id: id,
  correlation_id: `c-${id}`,
  task_type: "shell-read",
  executor: "hermes-local",
  provider: "custom",
  model: "local",
  started_at: "2026-09-22T00:00:00.000Z",
  completed_at: "2026-09-22T00:00:01.000Z",
  latency_ms: 1000,
  retries: 0,
  verifier_result: success ? "PASS" : "FAIL",
  acceptance_result: success ? "PASS" : "FAIL",
  success,
  ...overrides,
});

test("observation store survives restart, deduplicates, and aggregates without one-result overfit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routing-store-"));
  const store = new RoutingObservationStore(root);
  await Promise.all([store.append(observation("1")), store.append(observation("2", false))]);
  assert.equal(await store.append(observation("1")), false);
  const reopened = new RoutingObservationStore(root);
  assert.equal((await reopened.list()).length, 2);
  const stats = await reopened.stats();
  assert.equal(stats[0].samples, 2);
  assert.equal(stats[0].successes, 1);
  assert.ok(stats[0].smoothed_success > 0 && stats[0].smoothed_success < 1);
});

test("observation aggregation preserves bounded recency and retry-exhaustion evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routing-recency-"));
  const store = new RoutingObservationStore(root);
  await store.append(observation("1"));
  await store.append(observation("2"));
  await store.append(observation("3"));
  await store.append(
    observation("4", false, {
      retries: 2,
      latency_ms: 900_000,
      failure_reason: "Maximum autonomous attempts reached after adapter failure",
    })
  );
  await store.append(
    observation("5", false, {
      retries: 2,
      latency_ms: 900_000,
      failure_reason: "Maximum autonomous attempts reached after adapter failure",
    })
  );

  const [stats] = await store.stats();
  assert.equal(stats.retry_exhaustions, 2);
  assert.equal(stats.recent_failure_streak, 2);
  assert.equal(stats.recent_success_streak, 0);
  assert.equal(stats.recent_samples, 5);
  assert.equal(stats.recent_failures, 2);
  assert.equal(stats.verifier_samples, 5);
  assert.equal(stats.acceptance_samples, 5);
});

test("unknown retries stay unknown and terminal attempt exhaustion is explicit", () => {
  const store = new RoutingObservationStore("/unused");
  const [stats] = store.aggregate([
    observation("1", true, { retries: null }),
    observation("2", false, {
      retries: 1,
      failure_reason: "Maximum autonomous attempts reached after adapter failure",
    }),
  ]);
  assert.equal(stats.retry_samples, 1);
  assert.equal(stats.average_retries, 1);
  assert.equal(stats.retry_exhaustions, 1);
});

test("observation append recovers a lock owned by a dead process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routing-stale-lock-"));
  const store = new RoutingObservationStore(root);
  await mkdir(store.root, { recursive: true });
  await writeFile(
    store.lockPath,
    `${JSON.stringify({ pid: 999_999_999, created_at: "2026-09-22T00:00:00.000Z" })}\n`
  );
  assert.equal(await store.append(observation("recovered")), true);
  assert.equal((await store.list()).length, 1);
});

test("OmniRoute telemetry import reads call_logs without writing and maps missing metrics to null", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routing-sqlite-"));
  const databasePath = path.join(root, "usage.db");
  const db = new Database(databasePath);
  db.exec(
    "CREATE TABLE call_logs (id TEXT, timestamp TEXT, status INTEGER, model TEXT, provider TEXT, duration INTEGER, tokens_in INTEGER, tokens_out INTEGER, request_type TEXT, correlation_id TEXT, error_summary TEXT)"
  );
  db.prepare("INSERT INTO call_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "id1",
    "2026-09-22T00:00:00.000Z",
    200,
    "m",
    "p",
    42,
    3,
    4,
    "chat",
    "c1",
    null
  );
  db.close();
  const before = new Database(databasePath, { readonly: true })
    .prepare("SELECT COUNT(*) n FROM call_logs")
    .get().n;
  const rows = readOmniRouteObservations({ databasePath, limit: 10 });
  const afterDb = new Database(databasePath, { readonly: true });
  const after = afterDb.prepare("SELECT COUNT(*) n FROM call_logs").get().n;
  afterDb.close();
  assert.equal(before, after);
  assert.equal(rows[0].success, true);
  assert.equal(rows[0].estimated_cost, null);
  assert.equal(rows[0].correlation_id, "c1");
});
