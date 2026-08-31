import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  claimEvalIdempotencyKey,
  completeEvalIdempotencyKey,
  getEvalScorecard,
  listEvalRuns,
  getApiKeys,
  releaseEvalIdempotencyKey,
  saveEvalRun,
} from "@/lib/localDb";
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
    const url = new URL(request.url);
    const suiteId = url.searchParams.get("suiteId")?.trim() || undefined;
    const status = url.searchParams.get("status")?.trim() || undefined;
    const rawSince = url.searchParams.get("since")?.trim();
    const since = rawSince && !Number.isNaN(Date.parse(rawSince)) ? rawSince : undefined;
    const rawLimit = Number.parseInt(url.searchParams.get("limit") || "20", 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, rawLimit)) : 20;
    const [suites, persistedRuns, scorecard, targets, apiKeys] = await Promise.all([
      Promise.resolve(listSuites()),
      Promise.resolve(listEvalRuns({ limit: 1000 })),
      Promise.resolve(getEvalScorecard({ limit: 50 })),
      buildEvalTargetOptions(),
      getApiKeys(),
    ]);
    const recentRuns =
      status && status !== "completed" ? [] : listEvalRuns({ suiteId, since, limit });

    return NextResponse.json({
      suites,
      recentRuns,
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

  let idempotencyClaim: { key: string; fingerprint: string } | null = null;
  try {
    const validation = validateBody(evalRunSuiteSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const { suiteId, outputs, target, compareTarget, apiKeyId, tag } = validation.data;
    const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() || null;
    if (idempotencyKey) {
      if (idempotencyKey.length > 255) {
        return NextResponse.json(
          { error: { code: "invalid_idempotency_key", message: "Idempotency-Key is too long" } },
          { status: 400 }
        );
      }
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(validation.data))
        .digest("hex");
      const claim = claimEvalIdempotencyKey(idempotencyKey, fingerprint);
      if (claim.kind === "conflict") {
        return NextResponse.json(
          {
            error: {
              code: "idempotency_key_conflict",
              message: "Idempotency-Key was already used for a different eval request",
            },
          },
          { status: 409 }
        );
      }
      if (claim.kind === "pending") {
        return NextResponse.json(
          { error: { code: "idempotency_request_in_progress", message: "Eval request is in progress" } },
          { status: 409 }
        );
      }
      if (claim.kind === "replay") {
        return NextResponse.json(claim.response, {
          headers: { "Idempotency-Replayed": "true" },
        });
      }
      idempotencyClaim = { key: idempotencyKey, fingerprint };
    }

    if (outputs && Object.keys(outputs).length > 0) {
      const result = runSuite(suiteId, outputs, {}, tag);
      const run = saveEvalRun({
        suiteId: result.suiteId,
        suiteName: result.suiteName,
        target: { type: "suite-default", id: null, label: "Suite default" },
        apiKeyId,
        summary: result.summary,
        results: result.results,
        outputs,
      });
      const responseBody = {
        suiteId,
        runGroupId: null,
        runs: [run],
        scorecard: createScorecard([result]),
        recentRuns: listEvalRuns({ limit: 20 }),
        historyScorecard: getEvalScorecard({ limit: 50 }),
      };
      if (idempotencyClaim) {
        completeEvalIdempotencyKey(
          idempotencyClaim.key,
          idempotencyClaim.fingerprint,
          responseBody
        );
      }
      return NextResponse.json(responseBody);
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
          tag,
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

    const responseBody = {
      suiteId,
      runGroupId,
      runs,
      scorecard,
      recentRuns: listEvalRuns({ limit: 20 }),
      historyScorecard: getEvalScorecard({ limit: 50 }),
    };
    if (idempotencyClaim) {
      completeEvalIdempotencyKey(idempotencyClaim.key, idempotencyClaim.fingerprint, responseBody);
    }
    return NextResponse.json(responseBody);
  } catch (error: unknown) {
    if (idempotencyClaim) {
      releaseEvalIdempotencyKey(idempotencyClaim.key, idempotencyClaim.fingerprint);
    }
    return NextResponse.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}
