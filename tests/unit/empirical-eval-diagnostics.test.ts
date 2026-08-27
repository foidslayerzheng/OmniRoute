import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-empirical-diagnostics-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.OMNIROUTE_MANAGEMENT_API_KEY = "";

const core = await import("../../src/lib/db/core.ts");
const localDb = await import("../../src/lib/localDb.ts");
const evalsRoute = await import("../../src/app/api/evals/route.ts");

function resetDb() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function saveModelRun(id: string, results: Array<Record<string, unknown>>) {
  localDb.saveEvalRun({
    id,
    suiteId: "empirical-suite",
    suiteName: "Empirical Suite",
    target: { type: "model", id: "model-shadow", label: "Model Shadow" },
    summary: {
      total: results.length,
      passed: results.filter((entry) => entry.passed === true).length,
      failed: results.filter((entry) => entry.passed !== true).length,
      passRate: results.length === 0 ? 0 : 100,
    },
    avgLatencyMs: 25,
    results,
    outputs: { "secret-output": "must-not-enter-empirical-scorecard" },
    createdAt: "2026-08-24T12:00:00.000Z",
  });
}

test.beforeEach(resetDb);
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("GET always exposes an empty read-only empirical shadow scorecard", async () => {
  const response = await evalsRoute.GET(new Request("http://localhost/api/evals"));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.empiricalScorecard, {
    schemaVersion: 1,
    shadowOnly: true,
    minEmpiricalEvalSamples: 5,
    generatedFrom: "persisted_eval_runs",
    groups: [],
    routingReadiness: [],
  });
  assert.ok(Array.isArray(payload.suites));
  assert.ok(Array.isArray(payload.targets));
  assert.ok(Array.isArray(payload.recentRuns));
  assert.equal(payload.scorecard, null);
});

test("GET aggregates persisted rich and legacy evidence without exposing raw material", async () => {
  saveModelRun("rich", [
    {
      caseId: "rich",
      passed: true,
      durationMs: 40,
      prompt: "PRIVATE PROMPT",
      output: "PRIVATE OUTPUT",
      error: "PRIVATE ERROR",
      telemetry: {
        tags: ["coding"],
        transportSuccess: false,
        selectedModel: "model-b",
        provider: "provider-b",
        latencyMs: 25,
        retryCount: 1,
        fallbackCount: 0,
        httpStatus: 503,
        costUsd: 0,
        costStatus: "unknown",
        Authorization: "Bearer SECRET",
        cookie: "SECRET COOKIE",
        toolArguments: { secret: true },
        toolResult: "SECRET RESULT",
      },
    },
    { caseId: "legacy", passed: false },
    { caseId: "ambiguous", passed: true, telemetry: { tags: ["coding", "reasoning"] } },
  ]);

  const response = await evalsRoute.GET(new Request("http://localhost/api/evals"));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.recentRuns.length, 1);
  assert.ok(payload.scorecard);

  const scorecard = payload.empiricalScorecard;
  assert.equal(scorecard.schemaVersion, 1);
  assert.equal(scorecard.shadowOnly, true);
  assert.equal(scorecard.groups.length, 2);
  const coding = scorecard.groups.find((group: { taskClass: string | null }) => group.taskClass === "coding");
  assert.equal(coding.deterministicEval.passCount, 1);
  assert.equal(coding.transport.failureCount, 1);
  assert.equal(coding.cost.avgUsd, null);
  const unclassified = scorecard.groups.find((group: { taskClass: string | null }) => group.taskClass === null);
  assert.equal(unclassified.deterministicEval.sampleCount, 2);
  assert.equal(unclassified.transport.knownSampleCount, 0);
  assert.ok(scorecard.routingReadiness.every((entry: { eligibleForFutureEmpiricalRouting: boolean }) => !entry.eligibleForFutureEmpiricalRouting));

  const serialized = JSON.stringify(scorecard);
  for (const secret of [
    "PRIVATE PROMPT", "PRIVATE OUTPUT", "PRIVATE ERROR", "Bearer SECRET", "SECRET COOKIE",
    "SECRET RESULT", "must-not-enter-empirical-scorecard",
  ]) assert.equal(serialized.includes(secret), false);
  for (const forbiddenKey of ["prompt", "output", "error", "Authorization", "cookie", "toolArguments", "toolResult"])
    assert.equal(Object.prototype.hasOwnProperty.call(scorecard, forbiddenKey), false);
});

test("five deterministic samples become shadow-ready without routing effects", () => {
  const results = Array.from({ length: 5 }, (_, index) => ({
    caseId: `case-${index}`,
    passed: true,
    telemetry: {
      tags: ["coding"],
      transportSuccess: index !== 0,
      selectedModel: "model-b",
      provider: "provider-b",
    },
  }));
  saveModelRun("ready", results);
  const persistedRuns = localDb.listEvalRuns({ limit: 1000 });
  const scorecard = evalsRoute.createEmpiricalDiagnosticsScorecard(persistedRuns);
  assert.equal(scorecard.groups[0].deterministicEval.sampleCount, 5);
  assert.equal(scorecard.groups[0].transport.knownSampleCount, 5);
  assert.equal(scorecard.routingReadiness[0].eligibleForFutureEmpiricalRouting, true);
});

test("empirical diagnostics integration has no routing-module dependency", () => {
  const routeSource = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/api/evals/route.ts"),
    "utf8"
  );
  const empiricalImport = routeSource.match(/import[\s\S]*?from "@\/lib\/evals\/empiricalAggregation";/)?.[0] ?? "";
  assert.match(empiricalImport, /buildEmpiricalShadowScorecard/);
  assert.doesNotMatch(empiricalImport, /runtimeRoutingTuner|taskAwareRoutingPolicy|taskAwareAutoOrdering|resolveAutoStrategy|evalRouting/);
  const helperSource = routeSource.slice(
    routeSource.indexOf("export function createEmpiricalDiagnosticsScorecard"),
    routeSource.indexOf("export async function GET")
  );
  assert.doesNotMatch(helperSource, /runtimeRoutingTuner|taskAwareRoutingPolicy|taskAwareAutoOrdering|resolveAutoStrategy|evalRouting|buildEvalTargetOptions/);
});
