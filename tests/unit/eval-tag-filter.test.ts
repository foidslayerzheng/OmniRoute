import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-eval-tag-filter-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const localDb = await import("../../src/lib/localDb.ts");
const { evalRunSuiteSchema } = await import("../../src/shared/validation/schemas/evals.ts");
const { getSuite, runSuite, selectEvalCasesByTag } = await import(
  "../../src/lib/evals/evalRunner.ts"
);
const { runEvalSuiteAgainstTarget } = await import("../../src/lib/evals/runtime.ts");

function resetDb() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(resetDb);
test.after(() => {
  resetDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("eval run schema accepts an optional bounded trimmed tag", () => {
  const withoutTag = evalRunSuiteSchema.parse({ suiteId: "jarvis-core-v1" });
  assert.equal(withoutTag.tag, undefined);

  const withTag = evalRunSuiteSchema.parse({
    suiteId: "jarvis-core-v1",
    target: { type: "model", id: "local-qwen" },
    tag: "  task-class:simple  ",
  });
  assert.equal(withTag.tag, "task-class:simple");
  assert.equal(evalRunSuiteSchema.safeParse({ suiteId: "jarvis-core-v1", tag: "" }).success, false);
  assert.equal(
    evalRunSuiteSchema.safeParse({ suiteId: "jarvis-core-v1", tag: "x".repeat(65) }).success,
    false
  );
});

test("exact tag filtering preserves jarvis simple case order and no-tag behavior", () => {
  const suite = getSuite("jarvis-core-v1");
  assert.ok(suite);
  assert.equal(suite.cases.length, 24);
  assert.deepEqual(selectEvalCasesByTag(suite.cases), suite.cases);

  const selected = selectEvalCasesByTag(suite.cases, "task-class:simple");
  assert.deepEqual(
    selected.map((evalCase: { id: string }) => evalCase.id),
    ["jcv1-simple-arithmetic", "jcv1-simple-extraction", "jcv1-simple-sort"]
  );
  assert.throws(
    () => selectEvalCasesByTag(suite.cases, "simple"),
    /No eval cases matched tag: simple/
  );
});

test("tagged scoring includes only selected cases in results and summary", () => {
  const evaluated = runSuite("jarvis-core-v1", {}, {}, "task-class:simple");
  assert.equal(evaluated.summary.total, 3);
  assert.deepEqual(
    evaluated.results.map((result: { caseId: string }) => result.caseId),
    ["jcv1-simple-arithmetic", "jcv1-simple-extraction", "jcv1-simple-sort"]
  );
});

test("a nonmatching runtime tag fails before dispatch or persistence", async () => {
  let networkRequests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    networkRequests += 1;
    throw new Error("network must not be reached");
  };

  try {
    await assert.rejects(
      runEvalSuiteAgainstTarget({
        suiteId: "jarvis-core-v1",
        target: { type: "model", id: "local-qwen" },
        tag: "task-class:not-present",
      }),
      /No eval cases matched tag: task-class:not-present/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(networkRequests, 0);
  assert.deepEqual(localDb.listEvalRuns({ limit: 20 }), []);
});
