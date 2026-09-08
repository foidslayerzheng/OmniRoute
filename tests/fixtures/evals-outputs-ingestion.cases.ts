import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Environment setup (before any imports) ───────────────────────────────────
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-evals-outputs-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-secret";

// ── Application imports (mock-inference.mjs is loaded via --import BEFORE this) ─
const core = await import("../../src/lib/db/core.ts");
const localDb = await import("../../src/lib/localDb.ts");
const evalsRoute = await import("../../src/app/api/evals/route.ts");

// ── Inference mock handle (set by mock-inference.mjs via --import) ────────────
const inferenceMock = (globalThis as unknown as { __inferenceMock: unknown }).__inferenceMock as {
  mock: { calls: { arguments: Record<string, unknown>[] }[]; resetCalls(): void };
};
assert.ok(inferenceMock, "mock-inference.mjs must be loaded via --import before tests");

type EvalCaseInput = Parameters<typeof localDb.saveCustomEvalSuite>[0]["cases"][number];

interface PostBody {
  suiteId?: string;
  tag?: string;
  outputs?: Record<string, string>;
  target?: { type: string; id: string | null };
}

function resetDb(): void {
  core.resetDbInstance();
  localDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function makePost(body: PostBody): Request {
  return new Request("http://localhost/api/evals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test.beforeEach(() => {
  resetDb();
  inferenceMock.mock.resetCalls();
});

test.after(() => {
  core.resetDbInstance();
  localDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function createSuite(name: string, cases: EvalCaseInput[]): string {
  localDb.saveCustomEvalSuite({ name, cases });
  const suites = localDb.listCustomEvalSuites();
  return suites[suites.length - 1].id;
}

function makeCase(id: string, expected: string, tags?: string[]): EvalCaseInput {
  return {
    id,
    name: `Case ${id}`,
    model: "gpt-4o",
    input: { messages: [{ role: "user", content: `test ${id}` }] },
    expected: { strategy: "exact", value: expected },
    ...(tags ? { tags } : {}),
  };
}

// ── Valid ingestion ──────────────────────────────────────────────────────────

test("valid exact outputs are scored, persisted, and readable back", async () => {
  const suiteId = createSuite("Ingest Test", [
    makeCase("ingest-a", "HELLO"),
    makeCase("ingest-b", "GOODBYE"),
  ]);

  const response = await evalsRoute.POST(
    makePost({
      suiteId,
      outputs: { "ingest-a": "HELLO", "ingest-b": "GOODBYE" },
    })
  );

  assert.equal(response.status, 200);
  const payload = await response.json();

  // Response shape: runId at top level, all scorecard fields preserved
  assert.equal(typeof payload.runId, "string");
  assert.ok(payload.runId.length > 0);
  assert.equal(typeof payload.suiteId, "string");
  assert.equal(typeof payload.suiteName, "string");
  assert.equal(payload.summary.total, 2);
  assert.equal(payload.summary.passed, 2);
  assert.equal(payload.summary.failed, 0);
  assert.equal(payload.summary.passRate, 100);
  assert.ok(Array.isArray(payload.results));
  assert.equal(payload.results.length, 2);

  // Inference runner was NOT called
  assert.equal(
    inferenceMock.mock.calls.length,
    0,
    "inference runner must not be called for ingestion"
  );

  // Persisted run is readable back
  const runs = localDb.listEvalRuns({ limit: 10 });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, payload.runId);
  assert.equal(runs[0].suiteId, suiteId);
  assert.equal(runs[0].target.type, "suite-default");
  assert.equal(runs[0].target.id, null);
  assert.equal(runs[0].summary.total, 2);
  assert.equal(runs[0].summary.passRate, 100);

  // Case-level results are persisted
  const caseResults = runs[0].results;
  assert.equal(caseResults.length, 2);
  assert.equal(caseResults[0].caseId, "ingest-a");
  assert.equal(caseResults[0].passed, true);
  assert.equal(caseResults[1].caseId, "ingest-b");
  assert.equal(caseResults[1].passed, true);
});

// ── Unknown suite ────────────────────────────────────────────────────────────

test("unknown suite is rejected with 404 and nothing is persisted", async () => {
  const response = await evalsRoute.POST(
    makePost({
      suiteId: "nonexistent-suite",
      outputs: { "case-1": "some output" },
    })
  );

  assert.equal(response.status, 404);
  const payload = await response.json();
  assert.ok(payload.error.message.includes("Suite not found"));

  assert.equal(inferenceMock.mock.calls.length, 0, "inference runner must not be called");

  const runs = localDb.listEvalRuns({ limit: 10 });
  assert.equal(runs.length, 0);
});

// ── Missing output IDs ───────────────────────────────────────────────────────

test("missing output IDs are rejected with 400 and nothing is persisted", async () => {
  const suiteId = createSuite("Partial Test", [
    makeCase("part-1", "HI"),
    makeCase("part-2", "BYE"),
  ]);

  const response = await evalsRoute.POST(
    makePost({
      suiteId,
      outputs: { "part-1": "HI" },
    })
  );

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.ok(payload.error.message.includes("Output IDs do not match"));
  assert.deepEqual(payload.error.missing, ["part-2"]);
  assert.deepEqual(payload.error.unexpected, []);

  assert.equal(inferenceMock.mock.calls.length, 0, "inference runner must not be called");

  const runs = localDb.listEvalRuns({ limit: 10 });
  assert.equal(runs.length, 0);
});

// ── Extra output IDs ─────────────────────────────────────────────────────────

test("extra output IDs are rejected with 400 and nothing is persisted", async () => {
  const suiteId = createSuite("Extra Test", [makeCase("ex-1", "PONG")]);

  const response = await evalsRoute.POST(
    makePost({
      suiteId,
      outputs: { "ex-1": "PONG", "bogus-id": "extra" },
    })
  );

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.deepEqual(payload.error.missing, []);
  assert.deepEqual(payload.error.unexpected, ["bogus-id"]);

  assert.equal(inferenceMock.mock.calls.length, 0, "inference runner must not be called");

  const runs = localDb.listEvalRuns({ limit: 10 });
  assert.equal(runs.length, 0);
});

// ── Empty outputs object ─────────────────────────────────────────────────────

test("empty outputs {} is rejected with 400, never reaches inference", async () => {
  const suiteId = createSuite("Empty Outputs", [makeCase("eo-1", "A"), makeCase("eo-2", "B")]);

  const runsBefore = localDb.listEvalRuns({ limit: 10 }).length;

  const response = await evalsRoute.POST(
    makePost({
      suiteId,
      outputs: {},
    })
  );

  // Empty outputs: all selected case IDs are "missing"
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.ok(payload.error.message.includes("Output IDs do not match"));
  assert.deepEqual(payload.error.missing.sort(), ["eo-1", "eo-2"]);
  assert.deepEqual(payload.error.unexpected, []);

  assert.equal(
    inferenceMock.mock.calls.length,
    0,
    "inference runner must not be called for empty outputs"
  );

  // Nothing persisted
  const runsAfter = localDb.listEvalRuns({ limit: 10 });
  assert.equal(runsAfter.length, runsBefore);
});

// ── Zero selected cases (tag matches nothing) ────────────────────────────────

test("tag selecting zero cases is rejected with 400 and nothing is persisted", async () => {
  const suiteId = createSuite("No Match Tag", [
    makeCase("nm-1", "X", ["alpha"]),
    makeCase("nm-2", "Y", ["alpha"]),
  ]);

  const runsBefore = localDb.listEvalRuns({ limit: 10 }).length;

  const response = await evalsRoute.POST(
    makePost({
      suiteId,
      tag: "nonexistent-tag",
      outputs: { "nm-1": "X", "nm-2": "Y" },
    })
  );

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.ok(payload.error.message.includes("No eval cases"));

  assert.equal(inferenceMock.mock.calls.length, 0, "inference runner must not be called");

  const runsAfter = localDb.listEvalRuns({ limit: 10 });
  assert.equal(runsAfter.length, runsBefore);
});

// ── Tag-filtered ingestion ───────────────────────────────────────────────────

test("tag-filtered ingestion validates against only selected cases", async () => {
  const suiteId = createSuite("Tagged Suite", [
    makeCase("tag-a", "ALPHA", ["ingest"]),
    makeCase("tag-b", "BETA", ["ingest"]),
    makeCase("tag-c", "GAMMA"),
  ]);

  const response = await evalsRoute.POST(
    makePost({
      suiteId,
      tag: "ingest",
      outputs: { "tag-a": "ALPHA", "tag-b": "BETA" },
    })
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.summary.total, 2);
  assert.equal(payload.summary.passed, 2);

  assert.equal(inferenceMock.mock.calls.length, 0, "inference runner must not be called");

  const runs = localDb.listEvalRuns({ limit: 10 });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].summary.total, 2);
  assert.equal(runs[0].results.length, 2);
});

// ── Tag-filtered with missing output ─────────────────────────────────────────

test("tag-filtered with missing output for a selected case is rejected", async () => {
  const suiteId = createSuite("Tagged Missing", [
    makeCase("tm-1", "ONE", ["subset"]),
    makeCase("tm-2", "TWO", ["subset"]),
  ]);

  const response = await evalsRoute.POST(
    makePost({
      suiteId,
      tag: "subset",
      outputs: { "tm-1": "ONE" },
    })
  );

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.deepEqual(payload.error.missing, ["tm-2"]);

  assert.equal(inferenceMock.mock.calls.length, 0, "inference runner must not be called");

  const runs = localDb.listEvalRuns({ limit: 10 });
  assert.equal(runs.length, 0);
});

// ── Combined missing + extra ─────────────────────────────────────────────────

test("both missing and extra IDs produce combined error", async () => {
  const suiteId = createSuite("Mixed Error", [makeCase("me-1", "X"), makeCase("me-2", "Y")]);

  const response = await evalsRoute.POST(
    makePost({
      suiteId,
      outputs: { "me-1": "X", bogus: "Z" },
    })
  );

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.deepEqual(payload.error.missing, ["me-2"]);
  assert.deepEqual(payload.error.unexpected, ["bogus"]);
  assert.ok(payload.error.details.includes("missing"));
  assert.ok(payload.error.details.includes("unexpected"));

  assert.equal(inferenceMock.mock.calls.length, 0, "inference runner must not be called");

  const runs = localDb.listEvalRuns({ limit: 10 });
  assert.equal(runs.length, 0);
});

// ── Inference path: no outputs, mock returns canned result ───────────────────

test("POST without outputs invokes inference runner once with expected args", async () => {
  const response = await evalsRoute.POST(
    makePost({
      suiteId: "golden-set",
      target: { type: "suite-default", id: null },
    })
  );

  // Inference path returns 200 with runs array from the mock
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(Array.isArray(payload.runs), "should have runs array from inference path");
  assert.ok(!payload.runId, "should NOT have runId (that is outputs path)");

  // Mock was called exactly once
  assert.equal(inferenceMock.mock.calls.length, 1, "inference runner must be called exactly once");

  // Verify the arguments passed to the inference runner
  const callArgs = inferenceMock.mock.calls[0].arguments[0];
  assert.equal(callArgs.suiteId, "golden-set");
  assert.deepEqual(callArgs.target, { type: "suite-default", id: null });

  // Mock result shape is reflected in response
  assert.equal(payload.runs[0].suiteName, "mocked-suite");
  assert.equal(payload.runs[0].summary.total, 1);
});
