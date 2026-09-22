import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ResourceLockManager } from "../../scripts/supervisor/resourceLocks.mjs";

function owner(lane, pid = process.pid) {
  return {
    mission_id: "mission",
    lane_id: lane,
    task_id: `task-${lane}`,
    attempt_id: `attempt-${lane}`,
    pid,
  };
}

test("persisted read locks coexist while write conflicts across manager instances", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-locks-"));
  const first = new ResourceLockManager(root);
  const second = new ResourceLockManager(root);
  const a = await first.acquire([{ id: "repo:/tmp/project", mode: "read" }], owner("a"));
  const b = await second.acquire([{ id: "repo:/tmp/project", mode: "read" }], owner("b"));
  assert.equal((await first.inspect()).length, 2);
  await assert.rejects(
    () => second.acquire([{ id: "repo:/tmp/project", mode: "write" }], owner("c")),
    /resource conflict/i
  );
  await first.release(a);
  await second.release(b);
  assert.deepEqual(await first.inspect(), []);
});

test("hierarchical repo and path writes conflict but similarly prefixed siblings do not", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-hierarchy-"));
  const locks = new ResourceLockManager(root);
  const lease = await locks.acquire([{ id: "repo:/tmp/project", mode: "write" }], owner("parent"));
  await assert.rejects(
    () => locks.acquire([{ id: "path:/tmp/project/src", mode: "read" }], owner("child")),
    /resource conflict/i
  );
  const sibling = await locks.acquire(
    [{ id: "path:/tmp/project-other", mode: "write" }],
    owner("sibling")
  );
  await locks.release(sibling);
  await locks.release(lease);
});

test("release verifies ownership and stale recovery requires dead-owner proof", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-stale-"));
  const locks = new ResourceLockManager(root);
  const lease = await locks.acquire([{ id: "service:test", mode: "write" }], owner("a"));
  await assert.rejects(
    () => locks.release({ ...lease, owner_token: "wrong" }),
    /owned by another/i
  );
  const [record] = await locks.inspect();
  await assert.rejects(() => locks.recoverStale(record.lock_id), /proof.*required/i);
  await assert.rejects(
    () => locks.recoverStale(record.lock_id, { owner_dead: false }),
    /owner is not proven dead/i
  );
  await locks.release(lease);
});

test("stale lock is recovered only when persisted owner is proven dead", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-dead-"));
  const locks = new ResourceLockManager(root);
  const lease = await locks.acquire(
    [{ id: "deployment:test", mode: "write" }],
    owner("dead", 999_999_999)
  );
  const [record] = await locks.inspect();
  assert.equal(await locks.recoverStale(record.lock_id, { owner_dead: true }), true);
  assert.deepEqual(await locks.inspect(), []);
  await assert.rejects(() => locks.release(lease), /does not exist/i);
});

test("malformed persisted lock fails closed instead of being ignored", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-malformed-"));
  const locks = new ResourceLockManager(root);
  await locks.initialize();
  await writeFile(path.join(root, "resource-locks", "broken.json"), "not-json\n");
  await assert.rejects(() => locks.inspect(), /malformed resource lock/i);
});
