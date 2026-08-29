import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  clearAllModelLockouts,
  isModelLocked,
} from "../../open-sse/services/accountFallback.ts";
import {
  filterResilienceBlockedCandidates,
  SYNTHETIC_NOAUTH_CONNECTION_ID,
} from "../../open-sse/services/autoCombo/resilienceCandidateFilter.ts";
import { filterPaidOnlyCandidates } from "../../open-sse/services/autoCombo/paidModelFilter.ts";
import { recordAutoBestFreeCandidateFailure } from "../../open-sse/services/autoCombo/failureResilience.ts";

const base = {
  comboName: "auto/best-free",
  baseCooldownMs: 10_000,
  maxCooldownMs: 60_000,
};

test.beforeEach(() => clearAllModelLockouts());
test.after(() => clearAllModelLockouts());

test("no-auth free candidate is model-locked after unavailable 404 and removed from a later pool", () => {
  assert.equal(
    recordAutoBestFreeCandidateFailure({
      ...base,
      provider: "felo-web",
      connectionId: SYNTHETIC_NOAUTH_CONNECTION_ID,
      model: "felo-scholar",
      status: 404,
      errorText: "model unavailable",
    }),
    true
  );
  const healthy = {
    provider: "opencode",
    connectionId: SYNTHETIC_NOAUTH_CONNECTION_ID,
    model: "big-pickle",
  };
  const pool = filterResilienceBlockedCandidates(
    [
      {
        provider: "felo-web",
        connectionId: SYNTHETIC_NOAUTH_CONNECTION_ID,
        model: "felo-scholar",
      },
      healthy,
    ],
    new Map()
  );
  assert.deepEqual(pool, [healthy]);
});

test("clearly model-unavailable 400 is model-locked", () => {
  recordAutoBestFreeCandidateFailure({
    ...base,
    provider: "oc",
    connectionId: "conn-free",
    model: "deepseek-v4-flash-free",
    status: 400,
    errorText: "requested model is not available",
  });
  assert.equal(isModelLocked("oc", "conn-free", "deepseek-v4-flash-free"), true);
});

test("429 creates a bounded temporary model cooldown and preserves healthy free fallback", () => {
  recordAutoBestFreeCandidateFailure({
    ...base,
    provider: "felo-web",
    connectionId: SYNTHETIC_NOAUTH_CONNECTION_ID,
    model: "felo-scholar",
    status: 429,
    errorText: "too many requests",
  });
  assert.equal(isModelLocked("felo-web", SYNTHETIC_NOAUTH_CONNECTION_ID, "felo-scholar"), true);
  assert.equal(
    isModelLocked("felo-web", SYNTHETIC_NOAUTH_CONNECTION_ID, "felo-search"),
    false,
    "cooldown must stay model-specific"
  );
});

test("non-best-free combo does not mutate the best-free resilience path", () => {
  assert.equal(
    recordAutoBestFreeCandidateFailure({
      ...base,
      comboName: "auto/smart",
      provider: "felo-web",
      connectionId: SYNTHETIC_NOAUTH_CONNECTION_ID,
      model: "felo-scholar",
      status: 404,
      errorText: "model unavailable",
    }),
    false
  );
});

test("combo dispatch wires best-free failures into the shared resilience recorder", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "open-sse/services/combo.ts"),
    "utf8"
  );
  assert.match(source, /recordAutoBestFreeCandidateFailure\s*\(/);
});

test("paid candidate can never enter the auto/best-free pool", () => {
  const pool = filterPaidOnlyCandidates(
    [
      { provider: "openai", model: "gpt-4o" },
      { provider: "groq", model: "llama-3.3-70b-versatile" },
    ],
    true
  );
  assert.equal(pool.some((candidate) => candidate.provider === "openai"), false);
});
