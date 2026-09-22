import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EvidenceCache } from "../../scripts/supervisor/evidenceCache.mjs";

const result = {
  verifier_id: "fileHash",
  status: "PASS",
  evidence: [{ type: "file", source: "/tmp/a", summary: "abc" }],
  reason: "matched",
  retryable: false,
};

test("immutable evidence is reused only for the same fresh resource fingerprint", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evidence-cache-"));
  const cache = new EvidenceCache(root);
  const spec = { verifier_id: "fileHash", resource_id: "file:/tmp/a", max_age_ms: 60_000 };
  await cache.put(spec, "fingerprint-a", result);
  assert.equal((await cache.get(spec, "fingerprint-a")).result.status, "PASS");
  assert.equal(await cache.get(spec, "fingerprint-b"), null);
  assert.deepEqual(cache.stats(), { hits: 1, misses: 1, writes: 1 });
});

test("fresh proof bypasses cache and expired evidence is rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evidence-fresh-"));
  let now = 1_000;
  const cache = new EvidenceCache(root, { now: () => now });
  const spec = { verifier_id: "fileHash", resource_id: "file:/tmp/a", max_age_ms: 10 };
  await cache.put(spec, "same", result);
  assert.equal(await cache.get({ ...spec, fresh: true }, "same"), null);
  now = 1_011;
  assert.equal(await cache.get(spec, "same"), null);
});

test("cache persistence is redacted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evidence-redact-"));
  const cache = new EvidenceCache(root);
  const spec = { verifier_id: "fileHash", resource_id: "file:/tmp/a", max_age_ms: 100 };
  await cache.put(spec, "same", {
    ...result,
    evidence: [{ type: "file", source: "/tmp/a", summary: "token=super-secret-value" }],
  });
  const hit = await cache.get(spec, "same");
  assert.doesNotMatch(JSON.stringify(hit), /super-secret-value/);
});
