import assert from "node:assert/strict";
import test from "node:test";

import { TypeSafeJevAdapter } from "../../scripts/supervisor/routing/typesafeJevAdapter.mjs";

const response = (status, body) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const validBody = (answer = "local", confidence = 0.91) => ({
  answers: {
    rankExecutors: { type: "choice", choice: answer, confidence },
  },
  usage: { input_tokens: 12, output_tokens: 3, estimated_cost: 0.004 },
});

test("TypeSafe Jev validates a choice response and records bounded usage", async () => {
  let request;
  const adapter = new TypeSafeJevAdapter({
    enabled: true,
    apiKey: "secret-test-key",
    maxCalls: 2,
    spendCeiling: 1,
    fetchFn: async (url, init) => {
      request = { url, init };
      return response(200, validBody());
    },
  });
  const result = await adapter.rankExecutors({
    state: { task_type: "shell-read", secret: "secret-test-key" },
    candidates: ["local", "codex"],
  });

  assert.equal(request.url, "https://api.typesafe.ai/v1/systemone");
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(Object.keys(body.questions.rankExecutors.criteria), ["local", "codex"]);
  assert.doesNotMatch(request.init.body, /secret-test-key/);
  assert.deepEqual(result.selected, ["local"]);
  assert.equal(result.fallback, false);
  assert.equal(result.model, "jev-latest");
  assert.deepEqual(result.usage, {
    input_tokens: 12,
    output_tokens: 3,
    estimated_cost: 0.004,
  });
  assert.deepEqual(adapter.getUsage(), {
    calls: 1,
    http_attempts: 1,
    input_tokens: 12,
    output_tokens: 3,
    estimated_spend: 0.004,
  });
});

test("malformed, empty, and low-confidence TypeSafe results fail open", async () => {
  for (const body of ["not-json", {}, validBody("local", 1.1), validBody("local", 0.1)]) {
    const adapter = new TypeSafeJevAdapter({
      enabled: true,
      apiKey: "key",
      maxCalls: 1,
      spendCeiling: 1,
      fetchFn: async () => response(200, body),
    });
    const result = await adapter.rankExecutors({ candidates: ["local"] });
    assert.equal(result.fallback, true);
  }
});

test("timeout, authorization failures, and unavailable transport fall back", async () => {
  const timeout = new TypeSafeJevAdapter({
    enabled: true,
    apiKey: "key",
    timeoutMs: 10,
    maxCalls: 1,
    spendCeiling: 1,
    fetchFn: async (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      ),
  });
  assert.match((await timeout.classifyTask({ choices: ["shell"] })).fallback_reason, /timeout/i);

  for (const status of [401, 403]) {
    let attempts = 0;
    const adapter = new TypeSafeJevAdapter({
      enabled: true,
      apiKey: "key",
      maxCalls: 1,
      spendCeiling: 1,
      fetchFn: async () => {
        attempts += 1;
        return response(status, {});
      },
    });
    assert.equal((await adapter.classifyTask({ choices: ["shell"] })).fallback, true);
    assert.equal(attempts, 1);
  }

  const disabled = new TypeSafeJevAdapter();
  assert.equal((await disabled.classifyTask({ choices: ["shell"] })).fallback, true);
});

test("429 and 5xx retry once, while persistent transient failure falls back", async () => {
  for (const status of [429, 503]) {
    let attempts = 0;
    const adapter = new TypeSafeJevAdapter({
      enabled: true,
      apiKey: "key",
      maxCalls: 1,
      spendCeiling: 1,
      retryDelayMs: 0,
      fetchFn: async () => {
        attempts += 1;
        return attempts === 1 ? response(status, {}) : response(200, validBody());
      },
    });
    assert.equal((await adapter.rankExecutors({ candidates: ["local"] })).fallback, false);
    assert.equal(attempts, 2);
  }

  const failed = new TypeSafeJevAdapter({
    enabled: true,
    apiKey: "key",
    maxCalls: 1,
    spendCeiling: 1,
    retryDelayMs: 0,
    fetchFn: async () => response(500, {}),
  });
  assert.equal((await failed.classifyTask({ choices: ["shell"] })).fallback, true);
  assert.equal(failed.getUsage().http_attempts, 2);
});

test("call and spend ceilings stop further Jev calls without blocking routing", async () => {
  let calls = 0;
  const callLimited = new TypeSafeJevAdapter({
    enabled: true,
    apiKey: "key",
    maxCalls: 1,
    spendCeiling: 1,
    fetchFn: async () => {
      calls += 1;
      return response(200, validBody());
    },
  });
  await callLimited.rankExecutors({ candidates: ["local"] });
  const limited = await callLimited.rankExecutors({ candidates: ["local"] });
  assert.match(limited.fallback_reason, /call limit/i);
  assert.equal(calls, 1);

  const spendLimited = new TypeSafeJevAdapter({
    enabled: true,
    apiKey: "key",
    maxCalls: 2,
    spendCeiling: 0.004,
    fetchFn: async () => response(200, validBody()),
  });
  await spendLimited.rankExecutors({ candidates: ["local"] });
  const spendResult = await spendLimited.rankExecutors({ candidates: ["local"] });
  assert.match(spendResult.fallback_reason, /spend ceiling/i);
});

test("API key is neither serializable nor returned in results or usage", async () => {
  const key = "do-not-persist-this-key";
  const adapter = new TypeSafeJevAdapter({
    enabled: true,
    apiKey: key,
    maxCalls: 1,
    spendCeiling: 1,
    fetchFn: async () => response(200, validBody()),
  });
  const result = await adapter.rankExecutors({ candidates: ["local"] });
  assert.doesNotMatch(JSON.stringify(adapter), new RegExp(key));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(key));
  assert.doesNotMatch(JSON.stringify(adapter.getUsage()), new RegExp(key));
});

test("tool and context inclusion use bounded yes/no choice questions", async () => {
  const seen = [];
  const adapter = new TypeSafeJevAdapter({
    enabled: true,
    apiKey: "key",
    maxCalls: 2,
    spendCeiling: 1,
    fetchFn: async (_url, init) => {
      const body = JSON.parse(init.body);
      seen.push(body.questions);
      return response(200, {
        answers: Object.fromEntries(
          Object.keys(body.questions).map((id) => [
            id,
            { type: "noul", noul: id.endsWith(":required") ? 0.9 : 0.1 },
          ])
        ),
      });
    },
  });
  const tools = await adapter.selectTools({ available: ["required", "optional"] });
  const context = await adapter.selectContext({ available: ["required", "optional"] });
  assert.deepEqual(tools.selected, ["required"]);
  assert.deepEqual(context.selected, ["required"]);
  assert.ok(seen.flatMap(Object.values).every((question) => question.type === "noul"));
});
