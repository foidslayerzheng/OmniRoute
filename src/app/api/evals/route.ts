import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getEvalScorecard, listEvalRuns, getApiKeys } from "@/lib/localDb";
import { saveEvalRun } from "@/lib/db/evals";
import {
  listSuites,
  getSuite,
  selectEvalCasesByTag,
  evaluateCase,
  createScorecard,
} from "@/lib/evals/evalRunner";
import {
  buildEmpiricalShadowScorecard,
  MIN_EMPIRICAL_EVAL_SAMPLES,
} from "@/lib/evals/empiricalAggregation";
import { buildEvalTargetOptions, runEvalSuiteAgainstTarget } from "@/lib/evals/runtime";
import { EvalTargetSafetyError, resolveSafeEvalExecution } from "@/lib/evals/targetSafety";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { evalRunSuiteSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

interface EmpiricalScorecardPayload {
  schemaVersion: 1;
  shadowOnly: true;
  minEmpiricalEvalSamples: number;
  generatedFrom: "persisted_eval_runs";
  groups: ReturnType<typeof buildEmpiricalShadowScorecard>[number]["evidence"][];
  routingReadiness: ReturnType<typeof buildEmpiricalShadowScorecard>;
}

export function createEmpiricalDiagnosticsScorecard(
  persistedRuns: Parameters<typeof buildEmpiricalShadowScorecard>[0]
): EmpiricalScorecardPayload {
  const routingReadiness = buildEmpiricalShadowScorecard(persistedRuns);
  return {
    schemaVersion: 1,
    shadowOnly: true,
    minEmpiricalEvalSamples: MIN_EMPIRICAL_EVAL_SAMPLES,
    generatedFrom: "persisted_eval_runs",
    groups: routingReadiness.map((entry) => entry.evidence),
    routingReadiness,
  };
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const [suites, persistedRuns, scorecard, targets, apiKeys] = await Promise.all([
      Promise.resolve(listSuites()),
      Promise.resolve(listEvalRuns({ limit: 1000 })),
      Promise.resolve(getEvalScorecard({ limit: 50 })),
      buildEvalTargetOptions(),
      getApiKeys(),
    ]);

    return NextResponse.json({
      suites,
      recentRuns: persistedRuns.slice(0, 20),
      scorecard,
      empiricalScorecard: createEmpiricalDiagnosticsScorecard(persistedRuns),
      targets,
      apiKeys: apiKeys.map((key) => ({
        id: key.id,
        name: key.name,
        isActive: key.isActive !== false,
      })),
    });
  } catch (error: unknown) {
    return NextResponse.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          message: "Invalid request",
          details: [{ field: "body", message: "Invalid JSON body" }],
        },
      },
      { status: 400 }
    );
  }

  try {
    const validation = validateBody(evalRunSuiteSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const { suiteId, outputs, target, compareTarget, apiKeyId, tag } = validation.data;

    if (outputs !== undefined) {
      // ── Strict persisted external-output ingestion ──────────────────────
      // 1. Resolve the existing suite (built-in or custom).
      const suite = getSuite(suiteId);
      if (!suite) {
        return NextResponse.json(
          { error: { message: `Suite not found: ${suiteId}` } },
          { status: 404 }
        );
      }

      // 2. Select cases using the same tag filtering as scoring.
      let selectedCases: ReturnType<typeof selectEvalCasesByTag>;
      try {
        selectedCases = selectEvalCasesByTag(suite.cases || [], tag);
      } catch (e: unknown) {
        const msg = sanitizeErrorMessage(e);
        return NextResponse.json({ error: { message: msg } }, { status: 400 });
      }

      if (selectedCases.length === 0) {
        return NextResponse.json(
          { error: { message: `No eval cases to ingest for suite: ${suiteId}` } },
          { status: 400 }
        );
      }

      // 3. Require exact one-to-one match between output keys and selected case IDs.
      const selectedIds = new Set(selectedCases.map((c) => c.id));
      if (selectedIds.size !== selectedCases.length) {
        return NextResponse.json(
          { error: { message: "Duplicate case IDs in selected cases" } },
          { status: 400 }
        );
      }

      const outputKeys = Object.keys(outputs);
      const missing =
        selectedIds.size > 0
          ? [...selectedIds].filter((id) => !Object.prototype.hasOwnProperty.call(outputs, id))
          : [];
      const extra = outputKeys.filter((id) => !selectedIds.has(id));

      if (missing.length > 0 || extra.length > 0) {
        const details: string[] = [];
        if (missing.length > 0) details.push(`missing: ${missing.join(", ")}`);
        if (extra.length > 0) details.push(`unexpected: ${extra.join(", ")}`);
        return NextResponse.json(
          {
            error: {
              message: "Output IDs do not match selected cases",
              details: details.join("; "),
              missing,
              unexpected: extra,
            },
          },
          { status: 400 }
        );
      }

      // 4. Score the already-validated selectedCases directly — no re-fetch/reselect.
      const results = selectedCases.map((c) => evaluateCase(c, outputs[c.id] || ""));
      const passed = results.filter((r) => r.passed).length;
      const total = results.length;
      const scored = {
        suiteId: suite.id,
        suiteName: suite.name,
        results,
        summary: {
          total,
          passed,
          failed: total - passed,
          passRate: total > 0 ? Math.round((passed / total) * 100) : 0,
        },
      };

      // 5. Persist through existing saveEvalRun() — eval_runs is the only storage.
      const persisted = saveEvalRun({
        suiteId: scored.suiteId,
        suiteName: scored.suiteName,
        target: {
          type: "suite-default" as const,
          id: null,
          label: `External outputs (${selectedCases.length} cases)`,
        },
        avgLatencyMs: 0,
        summary: scored.summary,
        results: scored.results as Array<Record<string, unknown>>,
        outputs,
      });

      // 6. Return every existing scorecard field plus runId.
      return NextResponse.json({ ...scored, runId: persisted.id });
    }

    const inferenceSuite = getSuite(suiteId);
    if (!inferenceSuite) {
      return NextResponse.json(
        { error: { message: `Suite not found: ${suiteId}` } },
        { status: 404 }
      );
    }

    let inferenceCases: ReturnType<typeof selectEvalCasesByTag>;
    try {
      inferenceCases = selectEvalCasesByTag(inferenceSuite.cases || [], tag);
    } catch (error: unknown) {
      return NextResponse.json(
        { error: { message: sanitizeErrorMessage(error) } },
        { status: 400 }
      );
    }
    if (
      inferenceCases.some(
        (evalCase) => Array.isArray(evalCase.tags) && evalCase.tags.includes("offline-only")
      )
    ) {
      throw new EvalTargetSafetyError(
        "Offline-only eval suites require externally computed outputs"
      );
    }

    const targetsToRun = [target || { type: "suite-default" as const, id: null }];
    if (compareTarget) {
      targetsToRun.push(compareTarget);
    }

    // Finish every fail-closed safety preflight before dispatching the first case.
    const preparedTargets = [];
    for (const entry of targetsToRun) {
      preparedTargets.push({
        entry,
        safeExecution: await resolveSafeEvalExecution(entry),
      });
    }

    const runGroupId = preparedTargets.length > 1 ? randomUUID() : null;
    const runs = await Promise.all(
      preparedTargets.map(({ entry, safeExecution }) =>
        runEvalSuiteAgainstTarget({
          suiteId,
          target: entry,
          apiKeyId,
          tag,
          runGroupId,
          safeExecution,
        })
      )
    );

    const scorecard =
      runs.length > 0
        ? createScorecard(
            runs.map((run) => ({
              suiteId: `${run.suiteId}:${run.target.key}`,
              suiteName: `${run.suiteName} · ${run.target.label}`,
              results: run.results,
              summary: run.summary,
            }))
          )
        : null;

    return NextResponse.json({
      suiteId,
      runGroupId,
      runs,
      scorecard,
      recentRuns: listEvalRuns({ limit: 20 }),
      historyScorecard: getEvalScorecard({ limit: 50 }),
    });
  } catch (error: unknown) {
    const status = error instanceof EvalTargetSafetyError ? 400 : 500;
    return NextResponse.json({ error: sanitizeErrorMessage(error) }, { status });
  }
}
