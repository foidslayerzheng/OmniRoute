import { getProviderConnectionById } from "@/lib/db/providers";

export const APPROVED_LOCAL_QWEN_CONNECTION_ID = "64150d58-65fd-4e47-92e3-8899d5e80ed2";
export const APPROVED_LOCAL_QWEN_MODEL = "qwen/qwen3.5-9b";
export const APPROVED_LOCAL_QWEN_TARGET = `openai/${APPROVED_LOCAL_QWEN_MODEL}`;
export const APPROVED_LOCAL_QWEN_BASE_URL = "http://100.72.112.61:1234/v1";

export interface SafeEvalExecution {
  connectionId: typeof APPROVED_LOCAL_QWEN_CONNECTION_ID;
  model: typeof APPROVED_LOCAL_QWEN_TARGET;
  zeroCostVerified: true;
}

interface EvalTargetLike {
  type: string;
  id?: string | null;
}

interface SafetyDependencies {
  getConnection: (id: string) => Promise<unknown>;
  fetchImpl: typeof fetch;
}

export class EvalTargetSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalTargetSafetyError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseProviderSpecificData(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return asRecord(value);
}

function normalizeApprovedBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "100.72.112.61" ||
      parsed.port !== "1234" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return pathname === "/v1" ? APPROVED_LOCAL_QWEN_BASE_URL : null;
  } catch {
    return null;
  }
}

function requireApprovedTarget(target: EvalTargetLike): void {
  const targetId = typeof target.id === "string" ? target.id.trim() : "";
  if (target.type !== "model" || targetId !== APPROVED_LOCAL_QWEN_TARGET) {
    throw new EvalTargetSafetyError(
      `Eval inference is restricted to model target "${APPROVED_LOCAL_QWEN_TARGET}"`
    );
  }
}

function requireApprovedConnection(value: unknown): string {
  const connection = asRecord(value);
  const providerSpecificData = parseProviderSpecificData(connection?.providerSpecificData);
  const baseUrl = normalizeApprovedBaseUrl(
    providerSpecificData?.baseUrl ?? providerSpecificData?.base_url
  );
  if (
    !connection ||
    connection.id !== APPROVED_LOCAL_QWEN_CONNECTION_ID ||
    connection.provider !== "openai" ||
    (connection.isActive !== true && connection.isActive !== 1) ||
    connection.defaultModel !== "local-qwen" ||
    !baseUrl
  ) {
    throw new EvalTargetSafetyError("Approved Local-Qwen connection metadata did not validate");
  }
  return baseUrl;
}

async function requireServedModel(baseUrl: string, fetchImpl: typeof fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/models`, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new EvalTargetSafetyError("Could not verify the Local-Qwen model catalog");
  }
  if (!response.ok) {
    throw new EvalTargetSafetyError("Could not verify the Local-Qwen model catalog");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new EvalTargetSafetyError("Local-Qwen returned an invalid model catalog");
  }
  const data = asRecord(payload)?.data;
  const modelIds = Array.isArray(data)
    ? data.map((entry) => asRecord(entry)?.id).filter((id): id is string => typeof id === "string")
    : [];
  if (!modelIds.includes(APPROVED_LOCAL_QWEN_MODEL)) {
    throw new EvalTargetSafetyError(
      `Local-Qwen is not serving the approved model "${APPROVED_LOCAL_QWEN_MODEL}"`
    );
  }
}

export async function resolveSafeEvalExecution(
  target: EvalTargetLike,
  dependencies: Partial<SafetyDependencies> = {}
): Promise<SafeEvalExecution> {
  requireApprovedTarget(target);
  const getConnection = dependencies.getConnection ?? getProviderConnectionById;
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const connection = await getConnection(APPROVED_LOCAL_QWEN_CONNECTION_ID);
  const baseUrl = requireApprovedConnection(connection);
  await requireServedModel(baseUrl, fetchImpl);
  return {
    connectionId: APPROVED_LOCAL_QWEN_CONNECTION_ID,
    model: APPROVED_LOCAL_QWEN_TARGET,
    zeroCostVerified: true,
  };
}
