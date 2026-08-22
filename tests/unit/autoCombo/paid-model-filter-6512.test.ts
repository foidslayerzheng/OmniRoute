/**
 * #6512 / Phase 6A4 — regression guards for free-only auto routing.
 *
 * Tests the pure filter wired into createVirtualAutoCombo, including the
 * mandatory free-tier override when hidePaidModels is disabled.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { filterPaidOnlyCandidates } from "../../../open-sse/services/autoCombo/paidModelFilter.ts";

// `agentrouter/claude-opus-4-6` is documented free; openai models are paid-only.
const FREE = { provider: "agentrouter", model: "claude-opus-4-6" };
const PAID = { provider: "openai", model: "gpt-4o" };

function filterForCombo<T extends { provider: string; model: string }>(
  pool: T[],
  options: { hidePaidModels: boolean; tier?: string }
): T[] {
  return filterPaidOnlyCandidates(
    pool,
    options.hidePaidModels === true || options.tier === "free"
  );
}

test("auto/best-free filters paid candidates with hidePaidModels OFF", () => {
  assert.deepEqual(filterForCombo([FREE, PAID], { hidePaidModels: false, tier: "free" }), [FREE]);
});

test("auto/best-free keeps only provider/model pairs approved as free", () => {
  assert.deepEqual(
    filterForCombo([FREE, PAID, { provider: "openai", model: "gpt-4.1" }], {
      hidePaidModels: false,
      tier: "free",
    }),
    [FREE]
  );
});

test("auto/best-free fails closed when no valid free candidates exist", () => {
  assert.deepEqual(filterForCombo([PAID], { hidePaidModels: false, tier: "free" }), []);
});

test("non-free auto combo with hidePaidModels OFF remains unchanged", () => {
  const pool = [FREE, PAID];
  assert.equal(filterForCombo(pool, { hidePaidModels: false, tier: "cheap" }), pool);
  assert.deepEqual(pool, [FREE, PAID]);
});

test("hidePaidModels ON retains existing free filtering", () => {
  assert.deepEqual(filterForCombo([FREE, PAID], { hidePaidModels: true, tier: "cheap" }), [FREE]);
});

test("filter preserves extra candidate fields", () => {
  const enriched = { provider: "agentrouter", model: "claude-opus-4-6", connectionId: "synthetic" };
  assert.deepEqual(filterForCombo([enriched, PAID], { hidePaidModels: false, tier: "free" }), [enriched]);
});
