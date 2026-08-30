import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-rl-wait-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const resilienceSettings = await import("../../src/lib/resilience/settings.ts");
const rateLimitManager = await import("../../open-sse/services/rateLimitManager.ts");

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function configure(connectionId: string, maxWaitMs: number): Promise<void> {
  await rateLimitManager.applyRequestQueueSettings({
    ...resilienceSettings.DEFAULT_RESILIENCE_SETTINGS.requestQueue,
    enabled: true,
    concurrentRequests: 1,
    requestsPerMinute: 100000,
    minTimeBetweenRequestsMs: 0,
    maxWaitMs,
    maxQueueDepth: 0,
  });
  rateLimitManager.enableRateLimitProtection(connectionId);
}

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

test("queued longer than maxWaitMs fails before execution", async () => {
  const connectionId = "conn-queue-wait-timeout";
  await configure(connectionId, 500);
  const status = () => rateLimitManager.getAllRateLimitStatus()[`openai:${connectionId}`];

  const blocker = rateLimitManager.withRateLimit("openai", connectionId, "model", async () => {
    await wait(700);
    return "blocker";
  });
  await pollUntil(() => (status()?.executing ?? 0) >= 1);

  let executed = false;
  const queued = rateLimitManager.withRateLimit("openai", connectionId, "model", async () => {
    executed = true;
    return "queued";
  });
  const queuedRejection = assert.rejects(queued, (error: Error & { code?: string }) => {
    assert.equal(error.code, "RATE_LIMIT_QUEUE_TIMEOUT");
    return true;
  });
  await pollUntil(() => (status()?.queued ?? 0) >= 1);
  await queuedRejection;
  assert.equal(executed, false);
  assert.equal(await blocker, "blocker");
});

test("immediate dispatch may execute longer than maxWaitMs", async () => {
  const connectionId = "conn-slow-execution";
  const maxWaitMs = 500;
  const executionMs = 700;
  await configure(connectionId, maxWaitMs);

  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  let executionStartedAt = 0;
  const resultPromise = rateLimitManager.withRateLimit(
    "openai",
    connectionId,
    "model",
    async () => {
      executionStartedAt = Date.now();
      signalStarted();
      await wait(executionMs);
      return "slow-success";
    }
  );

  await started;
  const result = await resultPromise;

  assert.equal(result, "slow-success");
  assert.ok(
    Date.now() - executionStartedAt >= maxWaitMs,
    "execution must remain active beyond the queue-wait budget"
  );
});

test("slow executing job is never mislabeled as a queue timeout", async () => {
  const connectionId = "conn-slow-not-timeout";
  await configure(connectionId, 20);

  let error: unknown;
  try {
    await rateLimitManager.withRateLimit("openai", connectionId, "model", async () => {
      await wait(60);
      throw new Error("upstream-slow-failure");
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof Error);
  assert.equal(error.message, "upstream-slow-failure");
  assert.notEqual((error as Error & { code?: string }).code, "RATE_LIMIT_QUEUE_TIMEOUT");
});

test("queued abort rejects and never executes the job", async () => {
  const connectionId = "conn-queued-abort";
  await configure(connectionId, 500);
  const status = () => rateLimitManager.getAllRateLimitStatus()[`openai:${connectionId}`];

  const blocker = rateLimitManager.withRateLimit("openai", connectionId, "model", async () => {
    await wait(80);
    return "blocker";
  });
  await pollUntil(() => (status()?.executing ?? 0) >= 1);

  const controller = new AbortController();
  let executed = false;
  const queued = rateLimitManager.withRateLimit(
    "openai",
    connectionId,
    "model",
    async () => {
      executed = true;
      return "queued";
    },
    controller.signal
  );
  await pollUntil(() => (status()?.queued ?? 0) >= 1);
  controller.abort(new Error("queued-abort"));

  await assert.rejects(queued, /queued-abort/);
  assert.equal(await blocker, "blocker");
  await wait(20);
  assert.equal(executed, false);
});

test("watchdog wedge-recovery implementation remains queued-only", async () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "open-sse/services/rateLimitManager.ts"),
    "utf8"
  );
  assert.match(source, /counts\.QUEUED === 0/);
  assert.match(source, /counts\.RUNNING > 0 \|\| counts\.EXECUTING > 0/);
  assert.match(source, /dropErrorMessage: "rate-limit-watchdog-wedge-reset"/);
  assert.match(source, /wedgeErr\.code = "RATE_LIMIT_QUEUE_WEDGED"/);
});

test("normal short jobs remain unchanged", async () => {
  const connectionId = "conn-normal-short";
  await configure(connectionId, 100);

  const result = await rateLimitManager.withRateLimit("openai", connectionId, "model", async () => {
    await wait(5);
    return { ok: true };
  });

  assert.deepEqual(result, { ok: true });
});
