import test from "node:test";
import assert from "node:assert/strict";

import manifest from "../../src/lib/evals/evalRunner/hermesOfflineSuites.json";
import { getSuite } from "../../src/lib/evals/evalRunner.ts";

test("Hermes offline manifest and built-in suites have identical stable case IDs", () => {
  assert.deepEqual(
    manifest.suites.map((suite) => [suite.id, suite.cases.length]),
    [
      ["provider_retry", 10],
      ["memory", 18],
      ["browser_tool", 9],
    ]
  );

  const allNodeIds = new Set<string>();
  for (const specification of manifest.suites) {
    const suite = getSuite(specification.id);
    assert.ok(suite);
    assert.deepEqual(
      suite.cases.map((entry: { id: string }) => entry.id),
      specification.cases.map((entry) => entry.id)
    );
    for (const evalCase of suite.cases) {
      assert.deepEqual(evalCase.expected, { strategy: "exact", value: "passed" });
      assert.ok(evalCase.tags.includes("offline-only"));
    }
    for (const evalCase of specification.cases) {
      const nodeId = `${specification.testFile}::${evalCase.nodeId}`;
      assert.equal(allNodeIds.has(nodeId), false);
      allNodeIds.add(nodeId);
    }
  }
  assert.equal(allNodeIds.size, 37);
});
