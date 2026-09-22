import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ResourceLockManager } from "../../scripts/supervisor/resourceLocks.mjs";
import { SupervisorScheduler } from "../../scripts/supervisor/scheduler.mjs";

function task(id, overrides = {}) {
  return {
    task_id: id,
    description: `Run ${id}`,
    depends_on: [],
    resources: [],
    can_parallelize: true,
    acceptance_criteria: [
      { id: `${id}-proof`, description: `${id} proof`, required_evidence: [id], status: "pending" },
    ],
    verifiers: [],
    max_attempts: 3,
    requires_approval: false,
    mutating: false,
    ...overrides,
  };
}

function adapterFactory({ delay = 40, fail = new Set(), tracker = null } = {}) {
  return (lane) => ({
    async send_task(dispatched) {
      tracker?.started(lane.task_id, Date.now(), dispatched);
      return { lane, dispatched };
    },
    async wait_for_result(handle) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      tracker?.ended(lane.task_id, Date.now());
      const failed = fail.has(lane.task_id);
      return JSON.stringify({
        status: failed ? "FAILED" : "COMPLETE",
        task: lane.description,
        evidence: [
          { type: "other", source: lane.task_id, summary: failed ? "failed" : lane.task_id },
        ],
        changes: [],
        tests: ["NOT_RUN"],
        blocker: failed ? "fixture failure" : null,
        next_action: "none",
        requires_approval: false,
      });
    },
    async poll_status() {
      return { status: "unknown" };
    },
  });
}

async function schedulerFor(tasks, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "scheduler-"));
  const scheduler = new SupervisorScheduler({
    root,
    missionId: options.missionId ?? "mission",
    adapterFactory: options.adapterFactory ?? adapterFactory(options),
    lockManager: new ResourceLockManager(root),
    verifierHarness: options.verifierHarness,
    maxConcurrency: options.maxConcurrency,
  });
  await scheduler.initialize({ goal: "test", tasks, max_concurrency: options.maxConcurrency });
  return { root, scheduler };
}

test("independent lanes run concurrently and max concurrency three is enforced", async () => {
  let active = 0;
  let maximum = 0;
  const tracker = {
    started() {
      active += 1;
      maximum = Math.max(maximum, active);
    },
    ended() {
      active -= 1;
    },
  };
  const { scheduler } = await schedulerFor([task("a"), task("b"), task("c"), task("d")], {
    delay: 50,
    tracker,
    maxConcurrency: 3,
  });
  const state = await scheduler.run();
  assert.equal(state.status, "COMPLETE");
  assert.equal(maximum, 3);
  assert.equal(Object.values(state.lanes).filter((lane) => lane.status === "COMPLETE").length, 4);
});

test("conflicting writes serialize while read/read locks coexist", async () => {
  const starts = new Map();
  const ends = new Map();
  const tracker = {
    started(id, time) {
      starts.set(id, time);
    },
    ended(id, time) {
      ends.set(id, time);
    },
  };
  const shared = "path:/tmp/scheduler-project";
  const { scheduler } = await schedulerFor(
    [
      task("write-a", { resources: [{ id: shared, mode: "write" }] }),
      task("write-b", { resources: [{ id: `${shared}/src`, mode: "write" }] }),
      task("read-a", { resources: [{ id: "path:/tmp/read-only", mode: "read" }] }),
      task("read-b", { resources: [{ id: "path:/tmp/read-only", mode: "read" }] }),
    ],
    { delay: 40, tracker, maxConcurrency: 4 }
  );
  assert.equal((await scheduler.run()).status, "COMPLETE");
  assert.ok(
    starts.get("write-b") >= ends.get("write-a") || starts.get("write-a") >= ends.get("write-b")
  );
  assert.ok(starts.get("read-a") < ends.get("read-b") && starts.get("read-b") < ends.get("read-a"));
});

test("dependencies wait, parent failure blocks child, and independent lane completes", async () => {
  const starts = new Map();
  const ends = new Map();
  const tracker = {
    started(id, time) {
      starts.set(id, time);
    },
    ended(id, time) {
      ends.set(id, time);
    },
  };
  const { scheduler } = await schedulerFor(
    [task("parent"), task("child", { depends_on: ["parent"] }), task("independent")],
    { delay: 20, tracker }
  );
  let state = await scheduler.run();
  assert.equal(state.status, "COMPLETE");
  assert.ok(starts.get("child") >= ends.get("parent"));

  const failed = await schedulerFor(
    [task("bad"), task("dependent", { depends_on: ["bad"] }), task("safe")],
    { delay: 10, fail: new Set(["bad"]) }
  );
  state = await failed.scheduler.run();
  assert.equal(state.lanes.bad.status, "FAILED");
  assert.equal(state.lanes.dependent.status, "BLOCKED");
  assert.equal(state.lanes.safe.status, "COMPLETE");
  assert.match(state.blocker, /bad: fixture failure/);
});

test("verifier failure prevents completion and production write waits for approval", async () => {
  const verifierHarness = {
    count: 0,
    async run(spec) {
      this.count += 1;
      return {
        verifier_id: spec.verifier_id,
        status: "FAIL",
        evidence: [],
        reason: "no",
        retryable: false,
      };
    },
  };
  const verified = await schedulerFor([task("verify", { verifiers: [{ verifier_id: "x" }] })], {
    verifierHarness,
  });
  assert.equal((await verified.scheduler.run()).lanes.verify.status, "FAILED");

  const production = await schedulerFor([
    task("deploy", {
      mutating: true,
      resources: [{ id: "deployment:omniroute", mode: "write" }],
    }),
  ]);
  const state = await production.scheduler.run();
  assert.equal(state.lanes.deploy.status, "WAITING_APPROVAL");
  assert.equal(state.metrics.dispatch_count, 0);
});

test("persisted external resource lock blocks a lane without spinning or stealing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scheduler-external-lock-"));
  const lockManager = new ResourceLockManager(root);
  const lease = await lockManager.acquire([{ id: "path:/tmp/external-lock", mode: "write" }], {
    mission_id: "other",
    lane_id: "other-lane",
    task_id: "other-task",
    attempt_id: "other-attempt",
  });
  const scheduler = new SupervisorScheduler({
    root,
    missionId: "blocked-mission",
    adapterFactory: adapterFactory({ delay: 1 }),
    lockManager,
    maxConcurrency: 3,
  });
  await scheduler.initialize({
    goal: "blocked",
    tasks: [
      task("blocked", { resources: [{ id: "path:/tmp/external-lock/child", mode: "read" }] }),
    ],
  });
  const state = await Promise.race([
    scheduler.run(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("scheduler spun")), 250)),
  ]);
  assert.equal(state.lanes.blocked.status, "BLOCKED");
  assert.equal((await lockManager.inspect()).length, 1);
  await lockManager.release(lease);
});

test("crash recovery retries read-only lanes but verifies uncertain mutation before resend", async () => {
  let dispatches = 0;
  const adapters = (lane) => {
    const adapter = adapterFactory({ delay: 1 })(lane);
    return {
      ...adapter,
      send_task: async (value) => {
        dispatches += 1;
        return adapter.send_task(value);
      },
    };
  };
  const readOnly = await schedulerFor([task("read")], { adapterFactory: adapters });
  let state = await readOnly.scheduler.load();
  state.lanes.read.status = "RUNNING";
  state.lanes.read.attempt_id = "uncertain";
  await readOnly.scheduler.save(state);
  assert.equal((await readOnly.scheduler.recover()).status, "COMPLETE");
  assert.equal(dispatches, 1);

  const verifierHarness = {
    count: 0,
    async run(spec) {
      this.count += 1;
      return {
        verifier_id: spec.verifier_id,
        status: "FAIL",
        evidence: [],
        reason: "unknown",
        retryable: false,
      };
    },
  };
  const mutation = await schedulerFor(
    [task("mutate", { mutating: true, verifiers: [{ verifier_id: "proof" }] })],
    { adapterFactory: adapters, verifierHarness }
  );
  state = await mutation.scheduler.load();
  state.lanes.mutate.status = "RUNNING";
  state.lanes.mutate.attempt_id = "uncertain-mutation";
  await mutation.scheduler.save(state);
  const recovered = await mutation.scheduler.recover();
  assert.equal(recovered.lanes.mutate.status, "WAITING_APPROVAL");
  assert.equal(verifierHarness.count, 1);
  assert.equal(dispatches, 1);
});

test("audit persists distinct lane task correlation identities and redacts secrets", async () => {
  const { root, scheduler } = await schedulerFor([
    task("one", { authoritative_facts: ["token=super-secret-token"] }),
    task("two"),
  ]);
  const state = await scheduler.run();
  const audit = await readFile(path.join(root, "mission", "audit.jsonl"), "utf8");
  const persistedState = await readFile(path.join(root, "mission", "dag-state.json"), "utf8");
  for (const lane of Object.values(state.lanes)) {
    assert.match(audit, new RegExp(lane.lane_id));
    assert.match(audit, new RegExp(lane.task_id));
    assert.match(audit, new RegExp(lane.correlation_id));
  }
  assert.notEqual(state.lanes.one.correlation_id, state.lanes.two.correlation_id);
  assert.doesNotMatch(audit, /super-secret-token/);
  assert.doesNotMatch(persistedState, /super-secret-token/);
});
