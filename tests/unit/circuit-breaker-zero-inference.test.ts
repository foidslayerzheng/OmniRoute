import test from "node:test";
import assert from "node:assert/strict";

import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  STATE,
} from "../../src/shared/utils/circuitBreaker.ts";

test("CircuitBreaker blocks execution while OPEN and recovers through one HALF_OPEN probe", async () => {
  const breaker = new CircuitBreaker(`zero-inference-${process.pid}-${Date.now()}`, {
    failureThreshold: 1,
    resetTimeout: 60_000,
    halfOpenRequests: 1,
  });
  let callbackCalls = 0;

  assert.equal(breaker.getStatus().state, STATE.CLOSED);

  await assert.rejects(
    breaker.execute(async () => {
      callbackCalls += 1;
      throw new Error("simulated provider failure");
    }),
    /simulated provider failure/
  );
  assert.equal(breaker.getStatus().state, STATE.OPEN);
  assert.equal(callbackCalls, 1);

  await assert.rejects(
    breaker.execute(async () => {
      callbackCalls += 1;
      return "must not execute";
    }),
    (error) => error instanceof CircuitBreakerOpenError
  );
  assert.equal(callbackCalls, 1, "OPEN breaker must not execute the protected callback");

  breaker.lastFailureTime = Date.now() - breaker.resetTimeout - 1;
  assert.equal(breaker.getStatus().state, STATE.HALF_OPEN);

  const result = await breaker.execute(async () => {
    callbackCalls += 1;
    return "recovered";
  });

  assert.equal(result, "recovered");
  assert.equal(callbackCalls, 2);
  assert.equal(breaker.getStatus().state, STATE.CLOSED);
});
