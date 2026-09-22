import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SupervisorEngine } from "../../scripts/supervisor/engine.mjs";
import { FakeHermesAdapter } from "../../scripts/supervisor/adapters/fakeAdapter.mjs";
import { createInitialState } from "../../scripts/supervisor/schema.mjs";
import { MissionStateStore, transitionState } from "../../scripts/supervisor/stateStore.mjs";

function initial(overrides = {}) {
  return {
    ...createInitialState({
      mission_id: "engine",
      milestone: "Supervisor V1",
      goal: "inspect",
      authoritative_facts: ["authoritative checkout"],
      current_task: { description: "Run git status", mutating: false, scope: ["git status"] },
      acceptance_criteria: [
        { id: "c1", description: "status", required_evidence: ["git status"], status: "pending" },
      ],
      forbidden_topics: ["memory eval"],
      forbidden_paths: [".hermes/worktrees"],
      forbidden_actions: ["deploy"],
    }),
    ...overrides,
  };
}

function response(overrides = {}) {
  return JSON.stringify({
    status: "COMPLETE",
    task: "Run git status",
    evidence: [{ type: "git_state", source: "git status", summary: "clean" }],
    changes: [],
    tests: ["pass"],
    blocker: null,
    next_action: "none",
    requires_approval: false,
    ...overrides,
  });
}

async function setup(responses, overrides) {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervisor-engine-"));
  const store = new MissionStateStore(root, "engine");
  await store.save(initial(overrides));
  const adapter = new FakeHermesAdapter(responses);
  return { root, store, adapter, engine: new SupervisorEngine({ store, adapter }) };
}

test("successful task advances with stable task ID, unique attempt ID, persistence, and audit", async () => {
  const { store, adapter, engine } = await setup([response()]);
  const before = await store.load();
  const after = await engine.runOnce();
  assert.equal(after.status, "COMPLETE");
  assert.equal(after.current_task.task_id, before.current_task.task_id);
  assert.ok(after.current_task.attempt_id);
  assert.equal(adapter.sentTasks.length, 1);
  assert.equal(adapter.sentTasks[0].correlation_id, after.current_task.attempt_id);
  assert.equal((await store.load()).status, "COMPLETE");
  assert.match(await readFile(store.auditPath, "utf8"), /COMPLETE/);
});

test("blocker and production restart stop correctly", async () => {
  const blocked = await setup([response({ status: "BLOCKED", blocker: "missing tool" })]);
  assert.equal((await blocked.engine.runOnce()).status, "BLOCKED");
  const approval = await setup([
    response({ next_action: "restart production service", requires_approval: true }),
  ]);
  assert.equal((await approval.engine.runOnce()).status, "WAITING_APPROVAL");
});

test("drift gets exactly one correction and repeated drift blocks", async () => {
  const { engine, adapter } = await setup([
    response({ task: "Run memory eval" }),
    response({ task: "Run memory eval" }),
  ]);
  const corrected = await engine.runOnce();
  assert.equal(corrected.status, "CORRECTING");
  assert.equal(corrected.drift_correction_count, 1);
  assert.equal((await engine.runOnce()).status, "BLOCKED");
  assert.equal(adapter.sentTasks.length, 2);
});

test("missing evidence never completes and three attempts stop", async () => {
  const { engine } = await setup([
    response({ evidence: [] }),
    response({ evidence: [] }),
    response({ evidence: [] }),
  ]);
  assert.equal((await engine.runOnce()).status, "CORRECTING");
  assert.equal((await engine.runOnce()).status, "CORRECTING");
  const final = await engine.runOnce();
  assert.equal(final.status, "BLOCKED");
  assert.equal(final.attempt_count, 3);
  assert.equal(final.verification_retry_count, 3);
});

test("state survives engine reconstruction and secrets do not persist", async () => {
  const secret = "sk-12345678901234567890";
  const fixture = await setup([response({ changes: [`api_key=${secret}`] })]);
  const reconstructed = new SupervisorEngine({ store: fixture.store, adapter: fixture.adapter });
  await reconstructed.runOnce();
  const persisted = `${await readFile(fixture.store.statePath, "utf8")}\n${await readFile(fixture.store.auditPath, "utf8")}`;
  assert.doesNotMatch(persisted, new RegExp(secret));
});

test("uncertain mutating dispatch verifies before resend and never duplicates", async () => {
  const fixture = await setup([response()], {
    current_task: { ...initial().current_task, mutating: true },
  });
  let state = await fixture.store.load();
  state = transitionState(state, "RUNNING", "dispatch persisted");
  state.current_task = {
    ...state.current_task,
    attempt_id: "attempt-old",
    adapter_handle: "unknown",
    dispatch_state: "uncertain",
  };
  state.attempt_count = 1;
  await fixture.store.save(state);
  const recovered = await fixture.engine.recover();
  assert.equal(recovered.status, "WAITING_APPROVAL");
  assert.equal(fixture.adapter.sentTasks.length, 0);
});

test("final adapter wait failure persists terminal state and audit without restart replay", async () => {
  const secret = "sk-wait-failure-secret-1234567890";
  const rawTranscript = `giant raw transcript ${"x".repeat(2_000)} ${secret}`;
  const root = await mkdtemp(path.join(os.tmpdir(), "supervisor-wait-failure-"));
  const store = new MissionStateStore(root, "engine");
  await store.save(initial());
  const adapter = {
    sentTasks: [],
    async send_task(task) {
      this.sentTasks.push(task);
      return `handle-${this.sentTasks.length}`;
    },
    async wait_for_result() {
      throw new Error(`executor unavailable ${rawTranscript}`);
    },
    async poll_status() {
      return { status: "failed" };
    },
  };
  const engine = new SupervisorEngine({ store, adapter });

  assert.equal((await engine.runOnce()).status, "CORRECTING");
  assert.equal((await engine.runOnce()).status, "CORRECTING");
  const terminal = await engine.runOnce();

  assert.equal(terminal.status, "BLOCKED");
  assert.equal(terminal.attempt_count, 3);
  assert.equal(terminal.execution_retry_count, 3);
  assert.equal(terminal.latest_result.status, "FAILED");
  assert.match(terminal.blocker, /result retrieval failed/i);
  assert.match(terminal.next_action, /user/i);
  assert.equal(adapter.sentTasks.length, 3);
  await assert.rejects(() => access(path.join(store.missionDir, "mission.lock")), /ENOENT/);

  const audit = await readFile(store.auditPath, "utf8");
  assert.match(audit, /\"supervisor_decision\":\"BLOCKED\"/);
  assert.match(audit, /\"hermes_status\":\"FAILED\"/);
  const persisted = `${await readFile(store.statePath, "utf8")}\n${audit}`;
  assert.doesNotMatch(persisted, new RegExp(secret));
  assert.doesNotMatch(persisted, /giant raw transcript/);

  const restarted = new SupervisorEngine({ store, adapter });
  const recovered = await restarted.runOnce();
  assert.equal(recovered.status, "BLOCKED");
  assert.equal(recovered.attempt_count, 3);
  assert.equal(adapter.sentTasks.length, 3);
});

test("final malformed result persists blocked state and audit without leaking or replaying", async () => {
  const secret = "sk-parse-failure-secret-1234567890";
  const malformed = `STATUS=COMPLETE\nTASK=Run git status\nEVIDENCE=${secret}`;
  const fixture = await setup([malformed, malformed, malformed]);

  assert.equal((await fixture.engine.runOnce()).status, "CORRECTING");
  assert.equal((await fixture.engine.runOnce()).status, "CORRECTING");
  const terminal = await fixture.engine.runOnce();

  assert.equal(terminal.status, "BLOCKED");
  assert.equal(terminal.attempt_count, 3);
  assert.equal(terminal.verification_retry_count, 3);
  assert.equal(terminal.latest_result.status, "FAILED");
  assert.match(terminal.blocker, /contract validation failed/i);
  assert.match(terminal.next_action, /inspect/i);
  assert.equal(fixture.adapter.sentTasks.length, 3);
  await assert.rejects(() => access(path.join(fixture.store.missionDir, "mission.lock")), /ENOENT/);

  const audit = await readFile(fixture.store.auditPath, "utf8");
  assert.match(audit, /"supervisor_decision":"BLOCKED"/);
  assert.match(audit, /"hermes_status":"FAILED"/);
  const persisted = `${await readFile(fixture.store.statePath, "utf8")}\n${audit}`;
  assert.doesNotMatch(persisted, new RegExp(secret));
  assert.doesNotMatch(persisted, /STATUS=COMPLETE/);

  const restarted = new SupervisorEngine({ store: fixture.store, adapter: fixture.adapter });
  assert.equal((await restarted.runOnce()).status, "BLOCKED");
  assert.equal(fixture.adapter.sentTasks.length, 3);
});
