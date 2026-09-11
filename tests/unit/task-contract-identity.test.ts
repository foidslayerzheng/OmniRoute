import assert from "node:assert/strict";
import test from "node:test";
import { readTaskContract, resolveCallLogCorrelationId } from "../../src/shared/taskContract.ts";

function identityHeaders(overrides: Record<string, string> = {}) {
  return new Headers({
    "x-omniroute-contract-version": "1",
    "x-omniroute-mission-id": "session-123",
    "x-omniroute-task-id": "session-123:turn-456",
    "x-omniroute-correlation-id": "session-123:turn-456",
    ...overrides,
  });
}

test("non-streaming Hermes identity becomes the call-log correlation id", () => {
  const request = new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers: identityHeaders(), body: JSON.stringify({ stream: false }),
  });
  assert.equal(resolveCallLogCorrelationId(request.headers, "api-request-1"), "session-123:turn-456");
});

test("streaming Hermes identity becomes the call-log correlation id", () => {
  const request = new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers: identityHeaders(), body: JSON.stringify({ stream: true }),
  });
  assert.equal(resolveCallLogCorrelationId(request.headers, "api-request-2"), "session-123:turn-456");
});

test("legacy callers retain the per-request id as call-log correlation", () => {
  assert.equal(resolveCallLogCorrelationId(new Headers(), "api-request-legacy"), "api-request-legacy");
});

test("malformed or untrusted identity is ignored as a complete envelope", () => {
  const malformed = identityHeaders({
    "x-omniroute-task-id": "turn-good",
    "x-omniroute-correlation-id": "turn-other",
    "x-omniroute-tool-call-id": "forged-authority",
  });
  assert.equal(readTaskContract(malformed), null);
  assert.equal(resolveCallLogCorrelationId(malformed, "api-request-safe"), "api-request-safe");
});

test("task identity has no mutation-authority field", () => {
  const parsed = readTaskContract(identityHeaders({ "x-omniroute-tool-call-id": "forged" }));
  assert.deepEqual(Object.keys(parsed ?? {}).sort(), [
    "contract_version", "correlation_id", "mission_id", "task_id",
  ]);
});
