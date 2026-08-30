/**
 * #4165 — surface a clear error when a request exceeds the local queue-wait budget.
 *
 * `requestQueue.maxWaitMs` limits only time spent waiting for Bottleneck dispatch.
 * A genuinely queued request receives a clear, classifiable OmniRoute error and
 * its callback never executes; provider execution time is governed elsewhere.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-rl-queue-timeout-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const resilienceSettings = await import("../../src/lib/resilience/settings.ts");
const rateLimitManager = await import("../../open-sse/services/rateLimitManager.ts");

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function pollUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await wait(2);
  }
}

test.afterEach(async () => {
  await rateLimitManager.__resetRateLimitManagerForTests();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// Drive a real Bottleneck `expiration` failure: a tiny maxWaitMs and a job that
// runs longer than it.
async function triggerQueueTimeout() {
  await rateLimitManager.applyRequestQueueSettings({
    ...resilienceSettings.DEFAULT_RESILIENCE_SETTINGS.requestQueue,
    autoEnableApiKeyProviders: false,
    concurrentRequests: 1,
    requestsPerMinute: 100000,
    minTimeBetweenRequestsMs: 0,
    maxWaitMs: 500,
  });
  const connectionId = "conn-queue-timeout";
  rateLimitManager.enableRateLimitProtection(connectionId);
  const status = () => rateLimitManager.getAllRateLimitStatus()[`openai:${connectionId}`];

  const blocker = rateLimitManager.withRateLimit("openai", connectionId, "gpt-4o", async () => {
    await wait(700);
    return "blocker";
  });
  await pollUntil(() => (status()?.executing ?? 0) >= 1);

  let queuedCallbackExecuted = false;
  const queued = rateLimitManager.withRateLimit("openai", connectionId, "gpt-4o", async () => {
    queuedCallbackExecuted = true;
    return "should-not-reach";
  });
  await pollUntil(() => (status()?.queued ?? 0) >= 1);

  return { blocker, queued, queuedCallbackExecuted: () => queuedCallbackExecuted };
}

test("#4165 queued timeout surfaces a clear local error and never executes the callback", async () => {
  const { blocker, queued, queuedCallbackExecuted } = await triggerQueueTimeout();
  let caught: (Error & { code?: string; cause?: { message?: string } }) | undefined;
  try {
    await queued;
    assert.fail("expected the queued job to be dropped");
  } catch (err) {
    caught = err as Error & { code?: string; cause?: { message?: string } };
  }
  assert.ok(caught, "an error should have been thrown");
  assert.equal(caught.code, "RATE_LIMIT_QUEUE_TIMEOUT", "error must carry the queue-timeout code");
  assert.match(caught.message, /maxWaitMs/, "message should name the maxWaitMs knob");
  assert.match(caught.message, /not an upstream/i, "message should disclaim an upstream timeout");
  assert.doesNotMatch(caught.message, /This job timed out/, "old Bottleneck message must not leak");
  assert.match(String(caught.cause?.message ?? ""), /Queue wait exceeded 500ms before dispatch/);
  assert.equal(queuedCallbackExecuted(), false);

  assert.equal(await blocker, "blocker");
  await wait(20);
  assert.equal(queuedCallbackExecuted(), false, "timed-out tombstone must remain non-executable");
});

test("#4165 a job that completes within maxWaitMs is unaffected", async () => {
  await rateLimitManager.applyRequestQueueSettings({
    ...resilienceSettings.DEFAULT_RESILIENCE_SETTINGS.requestQueue,
    autoEnableApiKeyProviders: false,
    concurrentRequests: 1,
    requestsPerMinute: 100000,
    minTimeBetweenRequestsMs: 0,
    maxWaitMs: 5000,
  });
  rateLimitManager.enableRateLimitProtection("conn-fast");

  const result = await rateLimitManager.withRateLimit(
    "openai",
    "conn-fast",
    "gpt-4o",
    async () => "ok"
  );
  assert.equal(result, "ok");
});
