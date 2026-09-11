export const TASK_CONTRACT_VERSION = 1 as const;

export interface TaskContractV1 {
  contract_version: 1;
  mission_id: string;
  task_id: string;
  correlation_id: string;
  parent_task_id?: string;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

function readId(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  if (value === null) return null;
  const normalized = value.trim();
  return ID_PATTERN.test(normalized) ? normalized : null;
}

export function readTaskContract(headers: Headers): TaskContractV1 | null {
  if (headers.get("x-omniroute-contract-version") !== String(TASK_CONTRACT_VERSION)) return null;
  const missionId = readId(headers, "x-omniroute-mission-id");
  const taskId = readId(headers, "x-omniroute-task-id");
  const correlationId = readId(headers, "x-omniroute-correlation-id");
  const parentHeader = headers.get("x-omniroute-parent-task-id");
  const parentTaskId = parentHeader === null ? null : readId(headers, "x-omniroute-parent-task-id");
  if (!missionId || !taskId || !correlationId || taskId !== correlationId) return null;
  if (parentHeader !== null && !parentTaskId) return null;
  return {
    contract_version: TASK_CONTRACT_VERSION,
    mission_id: missionId,
    task_id: taskId,
    correlation_id: correlationId,
    ...(parentTaskId ? { parent_task_id: parentTaskId } : {}),
  };
}

export function resolveCallLogCorrelationId(headers: Headers, apiRequestId: string): string {
  return readTaskContract(headers)?.correlation_id ?? apiRequestId;
}
