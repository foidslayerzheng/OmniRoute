import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyEvalCompletion,
  collectEvalTelemetry,
  summarizeEvalQuality,
} from "../../src/lib/evals/runtime.ts";

const base = {
  suiteId: "universal-v1",
  caseId: "case-1",
  tags: ["quality", "smoke"],
  requestedTarget: { type: "model" as const, id: "requested/model" },
  durationMs: 321,
};

function response(headers: Record<string, string> = {}, status = 200) {
  return new Response(null, { status, headers });
}

test("captures routing headers and canonical body usage", () => {
  const telemetry = collectEvalTelemetry({
    ...base,
    response: response({
      "X-OmniRoute-Model": "openai/selected",
      "X-OmniRoute-Provider": "openai",
      "X-OmniRoute-Request-Id": "req-123",
      "X-OmniRoute-Decision": "balanced",
      "X-OmniRoute-Fallback-Attempts": "2",
      "X-OmniRoute-Cache": "miss",
      "X-OmniRoute-Cache-Hit": "false",
      "X-OmniRoute-Latency-Ms": "45",
      "X-OmniRoute-Tokens-In": "999",
      "X-OmniRoute-Tokens-Out": "999",
    }),
    payload: {
      choices: [{ message: { content: "valid answer" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        reasoning_tokens: 2,
        prompt_tokens_details: { cached_tokens: 3 },
        cache_creation_input_tokens: 5,
      },
    },
  });

  assert.deepEqual(telemetry, {
    schemaVersion: 2,
    suiteId: "universal-v1",
    caseId: "case-1",
    tags: ["quality", "smoke"],
    requestedTarget: { type: "model", id: "requested/model" },
    selectedModel: "openai/selected",
    provider: "openai",
    routingDecision: "balanced",
    requestId: "req-123",
    httpStatus: 200,
    transportSuccess: true,
    finishReason: "stop",
    completionStatus: "complete",
    validForQuality: true,
    latencyMs: 45,
    inputTokens: 10,
    outputTokens: 4,
    reasoningTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 5,
    fallbackCount: 2,
    retryCount: null,
    failureReason: null,
    cacheStatus: "miss",
    cacheHit: false,
    costUsd: null,
    costStatus: "unknown",
  });
});

test("positive response cost is reported", () => {
  const telemetry = collectEvalTelemetry({
    ...base,
    response: response({
      "X-OmniRoute-Model": "openai/paid",
      "X-OmniRoute-Response-Cost": "0.0125",
    }),
    payload: {},
  });
  assert.equal(telemetry.costUsd, 0.0125);
  assert.equal(telemetry.costStatus, "reported");
});

test("explicit cache hit records a semantic zero cost", () => {
  const telemetry = collectEvalTelemetry({
    ...base,
    response: response({ "X-OmniRoute-Cache-Hit": "true" }),
    payload: {},
  });
  assert.equal(telemetry.cacheHit, true);
  assert.equal(telemetry.costUsd, 0);
  assert.equal(telemetry.costStatus, "cache_hit_zero");
});

test("model names never prove a free-route zero cost", () => {
  for (const selectedModel of ["openrouter/model:free", "local-qwen"]) {
    const telemetry = collectEvalTelemetry({
      ...base,
      response: response({ "X-OmniRoute-Model": selectedModel }),
      payload: {},
    });
    assert.equal(telemetry.costUsd, null);
    assert.equal(telemetry.costStatus, "unknown");
  }
});

test("a positively verified local execution records a free-route zero cost", () => {
  const telemetry = collectEvalTelemetry({
    ...base,
    response: response({ "X-OmniRoute-Model": "openai/qwen/qwen3.5-9b" }),
    payload: {},
    zeroCostVerified: true,
  });
  assert.equal(telemetry.costUsd, 0);
  assert.equal(telemetry.costStatus, "free_route");
});

test("zero cost header on an unknown route remains unknown", () => {
  const telemetry = collectEvalTelemetry({
    ...base,
    response: response({
      "X-OmniRoute-Model": "openai/unknown",
      "X-OmniRoute-Response-Cost": "0.0000000000",
    }),
    payload: {},
  });
  assert.equal(telemetry.costUsd, null);
  assert.equal(telemetry.costStatus, "unknown");
  assert.equal(telemetry.retryCount, null);
});

test("failed HTTP response uses a bounded machine-readable failure reason", () => {
  const telemetry = collectEvalTelemetry({
    ...base,
    response: response({}, 429),
    payload: { error: { message: "unbounded upstream text must not enter telemetry" } },
  });
  assert.equal(telemetry.transportSuccess, false);
  assert.equal(telemetry.failureReason, "http_429");
});

test("classifies HTTP 200 output-limit exhaustion as runtime-invalid", () => {
  assert.deepEqual(
    classifyEvalCompletion(
      {
        choices: [
          { message: { content: null, reasoning_content: "unfinished" }, finish_reason: "length" },
        ],
      },
      true
    ),
    {
      finishReason: "length",
      completionStatus: "output_limit",
      failureReason: "output_limit_exhausted",
      validForQuality: false,
    }
  );
});

test("classifies reasoning-only HTTP 200 response without final content", () => {
  const result = classifyEvalCompletion(
    {
      choices: [
        { message: { content: "", reasoning_content: "reasoning" }, finish_reason: "stop" },
      ],
    },
    true
  );
  assert.equal(result.failureReason, "reasoning_only_no_final_content");
  assert.equal(result.validForQuality, false);
});

test("classifies empty HTTP 200 final content without reasoning", () => {
  const result = classifyEvalCompletion(
    { choices: [{ message: { content: null }, finish_reason: "stop" }] },
    true
  );
  assert.equal(result.failureReason, "empty_final_content");
  assert.equal(result.validForQuality, false);
});

test("keeps valid exact-answer completions eligible for quality scoring", () => {
  const result = classifyEvalCompletion(
    { choices: [{ message: { content: "EXACT" }, finish_reason: "stop" }] },
    true
  );
  assert.equal(result.failureReason, null);
  assert.equal(result.validForQuality, true);
});

test("infers output-limit exhaustion from bounded token usage when finish metadata is absent", () => {
  const result = classifyEvalCompletion(
    { choices: [{ message: { content: null } }], usage: { completion_tokens: 512 } },
    true,
    false,
    512
  );
  assert.equal(result.completionStatus, "output_limit");
  assert.equal(result.failureReason, "output_limit_exhausted");
  assert.equal(result.validForQuality, false);
});

test("runtime-invalid samples are excluded from quality failures and denominator", () => {
  assert.deepEqual(summarizeEvalQuality([{ passed: true }, { passed: false }, { passed: null }]), {
    total: 3,
    valid: 2,
    invalid: 1,
    passed: 1,
    failed: 1,
    passRate: 50,
  });
});
