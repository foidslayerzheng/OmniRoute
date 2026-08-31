import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getEvalRun } from "@/lib/localDb";

interface RunContext {
  params: Promise<{ runId: string }>;
}

export async function GET(request: Request, { params }: RunContext) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { runId } = await params;
  const run = getEvalRun(runId);
  if (!run) {
    return NextResponse.json(
      { error: { code: "eval_run_not_found", message: "Eval run not found" } },
      { status: 404 }
    );
  }

  const url = new URL(request.url);
  const results =
    url.searchParams.get("filter") === "failed"
      ? run.results.filter((result) => result.passed === false)
      : run.results;
  if (url.searchParams.get("scorecard") === "true") {
    return NextResponse.json({ ...run.summary, score: run.summary.passRate / 100 });
  }
  return NextResponse.json({ ...run, results, samples: results });
}

export async function POST(request: Request, { params }: RunContext) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "invalid_eval_run_operation",
          message: "Only the cancel operation is supported",
        },
      },
      { status: 400 }
    );
  }
  if (!body || typeof body !== "object" || (body as { op?: unknown }).op !== "cancel") {
    return NextResponse.json(
      {
        error: {
          code: "invalid_eval_run_operation",
          message: "Only the cancel operation is supported",
        },
      },
      { status: 400 }
    );
  }
  const { runId } = await params;
  const run = getEvalRun(runId);
  if (!run) {
    return NextResponse.json(
      { error: { code: "eval_run_not_found", message: "Eval run not found" } },
      { status: 404 }
    );
  }

  return NextResponse.json(
    { error: { code: "eval_run_immutable", message: "Completed eval runs cannot be cancelled" } },
    { status: 409 }
  );
}
