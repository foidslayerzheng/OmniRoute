import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FakeLayaAdapter, NullLayaAdapter } from "../../scripts/supervisor/routing/layaAdapter.mjs";
import { RoutingObservationStore } from "../../scripts/supervisor/routing/observationStore.mjs";
import { ResourceLockManager } from "../../scripts/supervisor/resourceLocks.mjs";
import { SupervisorScheduler } from "../../scripts/supervisor/scheduler.mjs";

const result = (description) =>
  JSON.stringify({
    status: "COMPLETE",
    task: description,
    evidence: [{ type: "other", source: "proof", summary: "ok" }],
    changes: [],
    tests: ["NOT_RUN"],
    blocker: null,
    next_action: "none",
    requires_approval: false,
  });

async function run(routing) {
  const root = await mkdtemp(path.join(os.tmpdir(), "routing-integration-"));
  const selected = [];
  const scheduler = new SupervisorScheduler({
    root,
    missionId: "m",
    lockManager: new ResourceLockManager(root),
    routing,
    adapterFactory(lane, executor) {
      selected.push(executor?.executor ?? "legacy");
      return {
        async send_task() {
          return "h";
        },
        async wait_for_result() {
          return result(lane.description);
        },
      };
    },
  });
  await scheduler.initialize({
    goal: "route",
    tasks: [
      {
        task_id: "t",
        description: "read",
        depends_on: [],
        resources: [],
        can_parallelize: true,
        task_type: "shell-read",
        required_tools: ["terminal"],
        acceptance_criteria: [
          { id: "c", description: "proof", required_evidence: ["proof"], status: "pending" },
        ],
        verifiers: [],
        max_attempts: 3,
        requires_approval: false,
      },
    ],
  });
  return { root, selected, state: await scheduler.run() };
}

test("opt-in empirical routing selects an executor and persists route audit and outcome", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routing-observations-"));
  const store = new RoutingObservationStore(root);
  for (let index = 0; index < 5; index += 1)
    await store.append({
      task_id: `prior-${index}`,
      correlation_id: `prior-${index}`,
      task_type: "shell-read",
      executor: "local",
      model: "qwen",
      provider: "custom",
      started_at: "2026-09-22T00:00:00.000Z",
      success: true,
      verifier_result: "PASS",
      acceptance_result: "PASS",
    });
  const execution = await run({
    enabled: true,
    store,
    laya: new FakeLayaAdapter({ rankExecutors: { selected: ["codex"], confidence: 0.9 } }),
    candidates: [
      {
        executor: "local",
        model: "qwen",
        provider: "custom",
        available: true,
        tools: ["terminal"],
        context_ids: [],
        estimated_cost: 0,
      },
      {
        executor: "codex",
        model: "codex",
        provider: "omniroute",
        available: true,
        tools: ["terminal"],
        context_ids: [],
        estimated_cost: 2,
      },
    ],
    conservative_fallback: "local",
    minimum_samples: 5,
  });
  assert.deepEqual(execution.selected, ["local"]);
  assert.equal(execution.state.lanes.t.status, "COMPLETE");
  assert.equal(execution.state.lanes.t.route_decision.explanation.EMPIRICAL_SELECTION, "local");
  const audit = await readFile(path.join(execution.root, "m", "audit.jsonl"), "utf8");
  assert.match(audit, /SELECTED_EXECUTOR/);
  assert.equal((await store.list()).length, 6);
});

test("routing omitted preserves the legacy adapter path and null Laya does not block", async () => {
  const legacy = await run(null);
  assert.deepEqual(legacy.selected, ["legacy"]);
  const root = await mkdtemp(path.join(os.tmpdir(), "routing-null-"));
  const routed = await run({
    enabled: true,
    store: new RoutingObservationStore(root),
    laya: new NullLayaAdapter(),
    candidates: [
      {
        executor: "local",
        model: null,
        provider: null,
        available: true,
        tools: ["terminal"],
        context_ids: [],
        estimated_cost: 0,
      },
    ],
    conservative_fallback: "local",
    minimum_samples: 5,
  });
  assert.deepEqual(routed.selected, ["local"]);
});

test("scheduler persists and advances deterministic bounded exploration cadence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routing-cadence-"));
  const store = new RoutingObservationStore(root);
  for (let index = 0; index < 10; index += 1) {
    await store.append({
      task_id: `local-${index}`,
      correlation_id: `local-${index}`,
      task_type: "shell-read",
      executor: "local",
      model: "qwen",
      provider: "custom",
      started_at: "2026-09-22T00:00:00.000Z",
      success: true,
      verifier_result: "PASS",
      acceptance_result: "PASS",
      tool_profile: "terminal-read",
    });
  }
  const selected = [];
  const scheduler = new SupervisorScheduler({
    root,
    missionId: "cadence",
    maxConcurrency: 1,
    lockManager: new ResourceLockManager(root),
    routing: {
      enabled: true,
      store,
      laya: new NullLayaAdapter(),
      candidates: [
        {
          executor: "local",
          model: "qwen",
          provider: "custom",
          available: true,
          tools: ["terminal"],
          context_ids: [],
          estimated_cost: 0,
        },
        {
          executor: "probe",
          model: "probe",
          provider: "offline",
          available: true,
          tools: ["terminal"],
          context_ids: [],
          estimated_cost: 0,
        },
      ],
      conservative_fallback: "local",
      minimum_samples: 5,
      exploration_interval: 2,
      exploration_sequence: 0,
    },
    adapterFactory(lane, executor) {
      selected.push(executor.executor);
      return {
        async send_task() {
          return "h";
        },
        async wait_for_result() {
          return result(lane.description);
        },
      };
    },
  });
  const tasks = ["a", "b", "c"].map((id) => ({
    task_id: id,
    description: `read ${id}`,
    depends_on: [],
    resources: [{ id: "repo:/tmp", mode: "read" }],
    can_parallelize: true,
    task_type: "shell-read",
    tool_profile: "terminal-read",
    required_tools: ["terminal"],
    acceptance_criteria: [
      { id: `proof-${id}`, description: "proof", required_evidence: ["proof"] },
    ],
    verifiers: [],
    max_attempts: 1,
    requires_approval: false,
    mutating: false,
  }));
  await scheduler.initialize({ goal: "cadence", max_concurrency: 1, tasks });
  const state = await scheduler.run();
  assert.deepEqual(selected, ["local", "probe", "local"]);
  assert.equal(state.metrics.routing_decisions, 3);
});
