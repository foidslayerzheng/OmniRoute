import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendAuditEvent } from "../../scripts/supervisor/auditLog.mjs";
import { createInitialState } from "../../scripts/supervisor/schema.mjs";
import {
  acquireMissionLock,
  MissionStateStore,
  transitionState,
} from "../../scripts/supervisor/stateStore.mjs";

function state() {
  return createInitialState({
    mission_id: "state-test",
    milestone: "v1",
    goal: "persist",
    authoritative_facts: ["fact one"],
    current_task: { description: "test state", mutating: false },
    acceptance_criteria: [
      { id: "c1", description: "saved", required_evidence: ["file"], status: "pending" },
    ],
  });
}

test("state saves atomically, reloads, and records valid transitions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervisor-state-"));
  const store = new MissionStateStore(root, "state-test");
  await store.save(state());
  const loaded = await store.load();
  const running = transitionState(loaded, "RUNNING", "dispatch");
  await store.save(running);
  assert.equal((await store.load()).status, "RUNNING");
  assert.equal(running.transition_history.at(-1).from, "PENDING");
  assert.ok(running.transition_timestamps.RUNNING);
  assert.equal((await readFile(store.statePath, "utf8")).endsWith("\n"), true);
  assert.throws(() => transitionState(running, "COMPLETE", "skip"), /transition/i);
});

test("mission lock is exclusive and only its owner releases it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervisor-lock-"));
  const first = await acquireMissionLock(root, "m1");
  await assert.rejects(() => acquireMissionLock(root, "m1"), /locked/i);
  await first.release();
  const second = await acquireMissionLock(root, "m1");
  await second.release();
});

test("authoritative facts require an explicit approved migration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervisor-facts-"));
  const store = new MissionStateStore(root, "state-test");
  await store.save(state());
  const changed = { ...state(), authoritative_facts: ["silently changed"] };
  await assert.rejects(() => store.save(changed), /authoritative/i);
  await store.migrateAuthoritativeFacts(["approved fact"], { userApproved: true });
  assert.deepEqual((await store.load()).authoritative_facts, ["approved fact"]);
});

test("audit log is compact, redacted, and excludes raw payloads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervisor-audit-"));
  const auditPath = path.join(root, "audit.jsonl");
  await appendAuditEvent(auditPath, {
    mission_id: "m",
    task_id: "t",
    attempt_id: "a",
    prompt_hash: "abc",
    hermes_status: "COMPLETE",
    supervisor_decision: "COMPLETE",
    evidence: [{ type: "test", source: "node", summary: "token=secret-value-12345" }],
    raw_prompt: "must never persist",
    authorization: "Bearer abcdefghijklmnop",
  });
  const text = await readFile(auditPath, "utf8");
  assert.doesNotMatch(text, /secret-value|abcdefghijklmnop|must never persist/);
  const record = JSON.parse(text);
  assert.equal(record.authorization, undefined);
  assert.ok(record.timestamp);
  assert.equal(record.evidence.length, 1);
});
