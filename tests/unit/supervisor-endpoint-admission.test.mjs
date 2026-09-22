import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EndpointAdmissionGate } from "../../scripts/supervisor/endpointAdmissionGate.mjs";

test("endpoint admission serializes three concurrent holders at capacity one", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "endpoint-admission-"));
  const gate = new EndpointAdmissionGate({
    root,
    endpointKey: "http://127.0.0.1:8080/v1",
    capacity: 1,
    queueTimeoutMs: 1_000,
  });
  let active = 0;
  let maximum = 0;
  const entered = [];

  await Promise.all(
    ["a", "b", "c"].map(async (attemptId) => {
      const lease = await gate.acquire({ task_id: attemptId, attempt_id: attemptId });
      active += 1;
      maximum = Math.max(maximum, active);
      entered.push(attemptId);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      await lease.release();
    })
  );

  assert.equal(maximum, 1);
  assert.deepEqual([...entered].sort(), ["a", "b", "c"]);
});

test("queue timeout is separate and queued cancellation does not consume a slot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "endpoint-admission-timeout-"));
  const holder = new EndpointAdmissionGate({
    root,
    endpointKey: "http://127.0.0.1:8080/v1",
    capacity: 1,
    queueTimeoutMs: 1_000,
  });
  const lease = await holder.acquire({ task_id: "holder", attempt_id: "holder" });
  const timed = new EndpointAdmissionGate({
    root,
    endpointKey: "http://127.0.0.1:8080/v1",
    capacity: 1,
    queueTimeoutMs: 20,
  });
  await assert.rejects(
    () => timed.acquire({ task_id: "timed", attempt_id: "timed" }),
    /queue wait timed out/i
  );

  const controller = new AbortController();
  const cancelled = holder.acquire(
    { task_id: "cancelled", attempt_id: "cancelled" },
    { signal: controller.signal }
  );
  controller.abort();
  await assert.rejects(() => cancelled, /cancelled/i);
  await lease.release();

  const next = await holder.acquire({ task_id: "next", attempt_id: "next" });
  await next.release();
});

test("dead process ownership is reclaimed without leaking endpoint capacity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "endpoint-admission-stale-"));
  const gate = new EndpointAdmissionGate({
    root,
    endpointKey: "http://127.0.0.1:8080/v1",
    capacity: 1,
    queueTimeoutMs: 1_000,
  });
  const seed = await gate.acquire({ task_id: "seed", attempt_id: "seed" });
  const slotPath = seed.slotPath;
  await seed.release();
  await mkdir(slotPath);
  await writeFile(
    path.join(slotPath, "owner.json"),
    `${JSON.stringify({ pid: 2147483647, process_start: "dead" })}\n`
  );
  const lease = await gate.acquire({ task_id: "recovered", attempt_id: "recovered" });
  assert.equal(lease.slot, 0);
  await lease.release();
});
