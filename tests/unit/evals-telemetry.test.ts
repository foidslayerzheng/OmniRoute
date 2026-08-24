import test from "node:test";
import assert from "node:assert/strict";

import { collectEvalTelemetry } from "../../src/lib/evals/runtime.ts";

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
    schemaVersion: 1,
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

test("free and local selected models record a free-route zero cost", () => {
  for (const selectedModel of ["openrouter/model:free", "local-qwen"]) {
    const telemetry = collectEvalTelemetry({
      ...base,
      response: response({ "X-OmniRoute-Model": selectedModel }),
      payload: {},
    });
    assert.equal(telemetry.costUsd, 0);
    assert.equal(telemetry.costStatus, "free_route");
  }
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
