import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getEvalScorecard, listEvalRuns, getApiKeys } from "@/lib/localDb";
import { listSuites, runSuite, createScorecard } from "@/lib/evals/evalRunner";
import {
  buildEmpiricalShadowScorecard,
  MIN_EMPIRICAL_EVAL_SAMPLES,
} from "@/lib/evals/empiricalAggregation";
import { buildEvalTargetOptions, runEvalSuiteAgainstTarget } from "@/lib/evals/runtime";
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

    const { suiteId, outputs, target, compareTarget, apiKeyId } = validation.data;

    if (outputs && Object.keys(outputs).length > 0) {
      const result = runSuite(suiteId, outputs);
      return NextResponse.json(result);
    }

    const targetsToRun = [target || { type: "suite-default" as const, id: null }];
    if (compareTarget) {
      targetsToRun.push(compareTarget);
    }

    const runGroupId = targetsToRun.length > 1 ? randomUUID() : null;
    const runs = await Promise.all(
      targetsToRun.map((entry) =>
        runEvalSuiteAgainstTarget({
          suiteId,
          target: entry,
          apiKeyId,
          runGroupId,
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
    return NextResponse.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}
