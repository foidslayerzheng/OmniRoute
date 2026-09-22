import assert from "node:assert/strict";
import test from "node:test";

import { CommandHermesAdapter } from "../../scripts/supervisor/adapters/commandAdapter.mjs";
import { FakeHermesAdapter } from "../../scripts/supervisor/adapters/fakeAdapter.mjs";

test("fake adapter captures tasks and deterministically supports lifecycle methods", async () => {
  const fake = new FakeHermesAdapter(["result-one"]);
  assert.equal((await fake.health_check()).status, "healthy");
  const handle = await fake.send_task({ prompt: "hello", attempt_id: "a1" });
  assert.equal(fake.sentTasks.length, 1);
  assert.equal((await fake.poll_status(handle)).status, "complete");
  assert.equal(await fake.wait_for_result(handle), "result-one");
  assert.equal((await fake.cancel_task(handle)).status, "cancelled");
});

test("command adapter requires explicit executable and passes prompt as one shell-free argument", async () => {
  assert.throws(() => new CommandHermesAdapter({}), /executable/i);
  const adapter = new CommandHermesAdapter({ executable: "/usr/bin/printf", args: ["%s"] });
  const handle = await adapter.send_task({ prompt: "hello; echo unsafe", attempt_id: "a1" });
  assert.equal(await adapter.wait_for_result(handle), "hello; echo unsafe");
  assert.equal((await adapter.poll_status(handle)).status, "unsupported");
  assert.equal((await adapter.cancel_task(handle)).status, "unsupported");
  assert.equal((await adapter.health_check()).status, "healthy");
});

test("command adapter bounds output and unknown handles fail closed", async () => {
  const adapter = new CommandHermesAdapter({
    executable: "/usr/bin/printf",
    args: ["%s"],
    maxOutputBytes: 20,
  });
  const handle = await adapter.send_task({ prompt: "x".repeat(100), attempt_id: "a1" });
  await assert.rejects(() => adapter.wait_for_result(handle), /output limit/i);
  await assert.rejects(() => adapter.wait_for_result("unknown"), /unknown/i);
});
