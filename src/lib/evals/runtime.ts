import { POST as postChatCompletion } from "@/app/api/v1/chat/completions/route";
import type { PersistedEvalRun, EvalTargetType } from "@/lib/db/evals";
import { saveEvalRun } from "@/lib/db/evals";
import { getApiKeyById, getCombos } from "@/lib/localDb";
import { getSuite, listSuites, runSuite } from "./evalRunner";

export interface EvalTargetInput {
  type: EvalTargetType;
  id?: string | null;
}

export interface EvalTargetOption {
  key: string;
  type: EvalTargetType;
  id: string | null;
  label: string;
  description: string;
}

export interface EvalTelemetry {
  schemaVersion: 1;
  suiteId: string;
  caseId: string;
  tags: string[];
  requestedTarget: { type: EvalTargetType; id: string | null };
  selectedModel: string | null;
  provider: string | null;
  routingDecision: string | null;
  requestId: string | null;
  httpStatus: number | null;
  transportSuccess: boolean | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  fallbackCount: number | null;
  retryCount: number | null;
  failureReason: string | null;
  cacheStatus: string | null;
  cacheHit: boolean | null;
  costUsd: number | null;
  costStatus: "reported" | "cache_hit_zero" | "free_route" | "unknown";
}

function getNormalizedTargetId(target: EvalTargetInput): string | null {
  return typeof target.id === "string" && target.id.trim().length > 0 ? target.id.trim() : null;
}

export function getEvalTargetLabel(target: EvalTargetInput): string {
  const id = getNormalizedTargetId(target);

  if (target.type === "combo") {
    return `Combo: ${id || "Unknown"}`;
  }

  if (target.type === "model") {
    return `Model: ${id || "Unknown"}`;
  }

  return "Suite defaults";
}

export function normalizeEvalTarget(target?: EvalTargetInput | null): EvalTargetInput {
  if (!target || target.type === "suite-default") {
    return { type: "suite-default", id: null };
  }

  return {
    type: target.type === "combo" ? "combo" : "model",
    id: getNormalizedTargetId(target),
  };
}

export async function buildEvalTargetOptions(): Promise<EvalTargetOption[]> {
  const [suites, combos] = await Promise.all([Promise.resolve(listSuites()), getCombos()]);
  const models = [
    ...new Set(
      suites
        .flatMap((suite) => suite.cases || [])
        .map((evalCase) => evalCase.model)
        .filter((model): model is string => typeof model === "string" && model.trim().length > 0)
    ),
  ].sort((left, right) => left.localeCompare(right));

  const comboOptions = (Array.isArray(combos) ? combos : [])
    .map((combo) => ({
      key: `combo:${combo.name}`,
      type: "combo" as const,
      id: typeof combo.name === "string" ? combo.name : null,
      label: `Combo: ${combo.name}`,
      description:
        typeof combo.strategy === "string" && combo.strategy.trim().length > 0
          ? `Runs through combo strategy "${combo.strategy}"`
          : "Runs through the combo router",
    }))
    .filter((option) => option.id);

  return [
    {
      key: "suite-default:__default__",
      type: "suite-default",
      id: null,
      label: "Suite defaults",
      description: "Use each case's built-in model",
    },
    ...models.map((model) => ({
      key: `model:${model}`,
      type: "model" as const,
      id: model,
      label: `Model: ${model}`,
      description: "Force every case through one direct model",
    })),
    ...comboOptions,
  ];
}

function extractTextParts(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim().length > 0 ? [value] : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      return entry.trim().length > 0 ? [entry] : [];
    }

    if (!entry || typeof entry !== "object") {
      return [];
    }

    const record = entry as Record<string, unknown>;
    if (typeof record.text === "string" && record.text.trim().length > 0) {
      return [record.text];
    }

    if (
      record.type === "output_text" &&
      typeof record.text === "string" &&
      record.text.trim().length > 0
    ) {
      return [record.text];
    }

    return [];
  });
}

function extractChatOutput(payload: Record<string, unknown> | null): string {
  if (!payload) return "";

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice =
    choices.length > 0 && choices[0] && typeof choices[0] === "object"
      ? (choices[0] as Record<string, unknown>)
      : null;
  const message =
    firstChoice && firstChoice.message && typeof firstChoice.message === "object"
      ? (firstChoice.message as Record<string, unknown>)
      : null;

  const chatText = extractTextParts(message?.content);
  if (chatText.length > 0) {
    return chatText.join("\n").trim();
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const text = extractTextParts((item as Record<string, unknown>).content);
    if (text.length > 0) {
      return text.join("\n").trim();
    }
  }

  return "";
}

function extractErrorMessage(payload: Record<string, unknown> | null, status: number): string {
  const error =
    payload && payload.error && typeof payload.error === "object"
      ? (payload.error as Record<string, unknown>)
      : null;
  const message =
    (error && typeof error.message === "string" && error.message.trim().length > 0
      ? error.message.trim()
      : null) ||
    (payload && typeof payload.message === "string" && payload.message.trim().length > 0
      ? payload.message.trim()
      : null);

  return message || `HTTP ${status}`;
}

function resolveCaseModel(evalCase: Record<string, unknown>, target: EvalTargetInput): string {
  const targetId = getNormalizedTargetId(target);
  const caseModel =
    typeof evalCase.model === "string" && evalCase.model.trim().length > 0 ? evalCase.model : null;

  if (target.type === "model" || target.type === "combo") {
    return targetId || caseModel || "gpt-4o";
  }

  return caseModel || "gpt-4o";
}

function optionalHeader(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  return value && value.trim().length > 0 ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function integerSignal(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed === null ? null : Math.floor(parsed);
}

function explicitBoolean(value: string | null): boolean | null {
  if (value === null) return null;
  const normalized = value.toLowerCase();
  if (["true", "1", "hit", "yes"].includes(normalized)) return true;
  if (["false", "0", "miss", "no"].includes(normalized)) return false;
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function collectEvalTelemetry(input: {
  suiteId: string;
  caseId: string;
  tags: string[];
  requestedTarget: EvalTargetInput;
  response: Response;
  payload: Record<string, unknown> | null;
  durationMs: number;
}): EvalTelemetry {
  const usage = record(input.payload?.usage);
  const promptDetails = record(usage?.prompt_tokens_details);
  const inputDetails = record(usage?.input_tokens_details);
  const bodyUsageAvailable = usage !== null;
  const selectedModel =
    optionalHeader(input.response.headers, "X-OmniRoute-Model") ||
    (typeof input.payload?.model === "string" && input.payload.model.trim()
      ? input.payload.model.trim()
      : null);
  const cacheHit = explicitBoolean(
    optionalHeader(input.response.headers, "X-OmniRoute-Cache-Hit")
  );
  const reportedCost = finiteNumber(
    optionalHeader(input.response.headers, "X-OmniRoute-Response-Cost")
  );
  const freeRoute =
    selectedModel !== null && (selectedModel.endsWith(":free") || selectedModel === "local-qwen");
  const costStatus: EvalTelemetry["costStatus"] =
    reportedCost !== null && reportedCost > 0
      ? "reported"
      : cacheHit === true
        ? "cache_hit_zero"
        : freeRoute
          ? "free_route"
          : "unknown";
  const costUsd =
    costStatus === "reported"
      ? reportedCost
      : costStatus === "cache_hit_zero" || costStatus === "free_route"
        ? 0
        : null;
  const latencyHeader = finiteNumber(
    optionalHeader(input.response.headers, "X-OmniRoute-Latency-Ms")
  );

  return {
    schemaVersion: 1,
    suiteId: input.suiteId,
    caseId: input.caseId,
    tags: [...input.tags],
    requestedTarget: {
      type: input.requestedTarget.type,
      id: getNormalizedTargetId(input.requestedTarget),
    },
    selectedModel,
    provider: optionalHeader(input.response.headers, "X-OmniRoute-Provider"),
    routingDecision: optionalHeader(input.response.headers, "X-OmniRoute-Decision"),
    requestId: optionalHeader(input.response.headers, "X-OmniRoute-Request-Id"),
    httpStatus: Number.isInteger(input.response.status) ? input.response.status : null,
    transportSuccess: input.response.ok,
    latencyMs: latencyHeader ?? Math.max(0, Math.round(input.durationMs)),
    inputTokens: bodyUsageAvailable
      ? (integerSignal(usage?.prompt_tokens) ?? integerSignal(usage?.input_tokens))
      : integerSignal(optionalHeader(input.response.headers, "X-OmniRoute-Tokens-In")),
    outputTokens: bodyUsageAvailable
      ? (integerSignal(usage?.completion_tokens) ?? integerSignal(usage?.output_tokens))
      : integerSignal(optionalHeader(input.response.headers, "X-OmniRoute-Tokens-Out")),
    reasoningTokens: bodyUsageAvailable ? integerSignal(usage?.reasoning_tokens) : null,
    cacheReadTokens: bodyUsageAvailable
      ? (integerSignal(promptDetails?.cached_tokens) ??
        integerSignal(inputDetails?.cached_tokens) ??
        integerSignal(usage?.cache_read_input_tokens))
      : null,
    cacheWriteTokens: bodyUsageAvailable
      ? integerSignal(usage?.cache_creation_input_tokens)
      : null,
    fallbackCount: integerSignal(
      optionalHeader(input.response.headers, "X-OmniRoute-Fallback-Attempts")
    ),
    retryCount: null,
    failureReason: input.response.ok ? null : `http_${input.response.status}`,
    cacheStatus: optionalHeader(input.response.headers, "X-OmniRoute-Cache"),
    cacheHit,
    costUsd,
    costStatus,
  };
}

async function executeEvalCase(
  suiteId: string,
  evalCase: Record<string, unknown>,
  target: EvalTargetInput,
  apiKey: string | null
): Promise<{ output: string; durationMs: number; error?: string; telemetry: EvalTelemetry }> {
  const input =
    evalCase.input && typeof evalCase.input === "object" && !Array.isArray(evalCase.input)
      ? (evalCase.input as Record<string, unknown>)
      : {};
  const model = resolveCaseModel(evalCase, target);
  const headers = new Headers({
    "Content-Type": "application/json",
  });

  if (apiKey) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }

  const request = new Request("http://localhost/api/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...input,
      model,
      stream: false,
      max_tokens:
        typeof input.max_tokens === "number" && Number.isFinite(input.max_tokens)
          ? input.max_tokens
          : 512,
    }),
  });

  const startedAt = Date.now();
  const response = await postChatCompletion(request);
  const durationMs = Date.now() - startedAt;

  let payload: Record<string, unknown> | null = null;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    payload = null;
  }

  const telemetry = collectEvalTelemetry({
    suiteId,
    caseId: typeof evalCase.id === "string" ? evalCase.id : "",
    tags: Array.isArray(evalCase.tags)
      ? evalCase.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    requestedTarget: target,
    response,
    payload,
    durationMs,
  });

  if (!response.ok) {
    const error = extractErrorMessage(payload, response.status);
    return {
      output: `[ERROR] ${error}`,
      durationMs,
      error,
      telemetry,
    };
  }

  const output = extractChatOutput(payload);
  return {
    output: output || "[No content returned]",
    durationMs,
    telemetry,
  };
}

function getAverageLatency(caseMetrics: Record<string, { durationMs?: number }>): number {
  const durations = Object.values(caseMetrics)
    .map((metric) => Number(metric.durationMs))
    .filter((duration) => Number.isFinite(duration) && duration >= 0);

  if (durations.length === 0) return 0;
  return Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length);
}

export async function runEvalSuiteAgainstTarget(input: {
  suiteId: string;
  target?: EvalTargetInput | null;
  apiKeyId?: string;
  runGroupId?: string | null;
}): Promise<PersistedEvalRun> {
  const suite = getSuite(input.suiteId);
  if (!suite) {
    throw new Error(`Suite not found: ${input.suiteId}`);
  }

  const normalizedTarget = normalizeEvalTarget(input.target);
  const targetLabel = getEvalTargetLabel(normalizedTarget);

  let resolvedApiKey: string | null = null;
  if (typeof input.apiKeyId === "string" && input.apiKeyId.trim().length > 0) {
    const keyRecord = await getApiKeyById(input.apiKeyId);
    if (!keyRecord || typeof keyRecord.key !== "string" || keyRecord.key.trim().length === 0) {
      throw new Error("Selected API key was not found");
    }
    if (keyRecord.isActive === false) {
      throw new Error("Selected API key is inactive");
    }
    resolvedApiKey = keyRecord.key;
  }

  const outputs: Record<string, string> = {};
  const caseMetrics: Record<string, { durationMs?: number; error?: string }> = {};
  const telemetryByCase: Record<string, EvalTelemetry> = {};

  for (const evalCase of suite.cases || []) {
    const execution = await executeEvalCase(
      input.suiteId,
      (evalCase || {}) as Record<string, unknown>,
      normalizedTarget,
      resolvedApiKey
    );
    outputs[evalCase.id] = execution.output;
    telemetryByCase[evalCase.id] = execution.telemetry;
    caseMetrics[evalCase.id] = {
      durationMs: execution.durationMs,
      ...(execution.error ? { error: execution.error } : {}),
    };
  }

  const evaluated = runSuite(input.suiteId, outputs, caseMetrics);
  const results = evaluated.results.map((result) => ({
    ...result,
    telemetry: telemetryByCase[result.caseId],
  }));
  return saveEvalRun({
    runGroupId: input.runGroupId || null,
    suiteId: evaluated.suiteId,
    suiteName: evaluated.suiteName,
    target: {
      type: normalizedTarget.type,
      id: getNormalizedTargetId(normalizedTarget),
      label: targetLabel,
    },
    apiKeyId: input.apiKeyId || null,
    avgLatencyMs: getAverageLatency(caseMetrics),
    summary: evaluated.summary,
    results: results as Array<Record<string, unknown>>,
    outputs,
  });
}
