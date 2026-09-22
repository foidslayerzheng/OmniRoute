import { createHash, randomUUID } from "node:crypto";

import { appendAuditEvent } from "./auditLog.mjs";
import { decideResult } from "./evaluator.mjs";
import { formatHermesPrompt, parseHermesResult } from "./resultContract.mjs";
import { acquireMissionLock, transitionState } from "./stateStore.mjs";

export class SupervisorEngine {
  constructor({ store, adapter }) {
    this.store = store;
    this.adapter = adapter;
  }

  async persistDecision(state, result, decision, promptHash) {
    let next = {
      ...state,
      latest_result: result,
      evidence: result.evidence,
      blocker: decision.action === "BLOCKED" ? decision.reason : null,
      next_action: result.next_action,
      requires_user_approval: decision.action === "WAITING_APPROVAL",
      permission_decision: decision.permission?.decision ?? state.permission_decision,
      acceptance_criteria: decision.acceptance?.criteria ?? state.acceptance_criteria,
      current_task: { ...state.current_task, dispatch_state: "result_received" },
    };
    if (decision.action === "COMPLETE") next = transitionState(next, "COMPLETE", decision.reason);
    if (decision.action === "WAITING_APPROVAL")
      next = transitionState(next, "WAITING_APPROVAL", decision.reason);
    if (decision.action === "BLOCKED") next = transitionState(next, "BLOCKED", decision.reason);
    if (decision.action === "CORRECT") {
      next.drift_correction_count += 1;
      next = transitionState(next, "CORRECTING", decision.reason);
    }
    if (decision.action === "RETRY_VERIFICATION") {
      next.verification_retry_count += 1;
      if (next.attempt_count >= next.max_attempts) {
        next.blocker = "Maximum autonomous attempts reached without required evidence";
        next = transitionState(next, "BLOCKED", next.blocker);
      } else {
        next = transitionState(next, "CORRECTING", decision.reason);
      }
    }
    await this.store.save(next);
    await appendAuditEvent(this.store.auditPath, {
      mission_id: next.mission_id,
      task_id: next.current_task.task_id,
      attempt_id: next.current_task.attempt_id,
      prompt_hash: promptHash,
      hermes_status: result.status,
      supervisor_decision: next.status,
      evidence: result.evidence,
      approval_stop_reason: next.requires_user_approval ? decision.reason : null,
    });
    return next;
  }

  async persistResultRetrievalFailure(state, promptHash) {
    const exhausted = state.attempt_count >= state.max_attempts;
    const result = {
      status: "FAILED",
      task: state.current_task.description,
      evidence: [],
      changes: [],
      tests: [],
      blocker: "Adapter result retrieval failed",
      next_action: exhausted
        ? "Ask the user to inspect the executor before starting a new task"
        : "Retry the same non-mutating task within the autonomous attempt limit",
      requires_approval: exhausted,
    };
    let next = {
      ...state,
      latest_result: result,
      blocker: result.blocker,
      next_action: result.next_action,
      execution_retry_count: state.execution_retry_count + 1,
      current_task: { ...state.current_task, dispatch_state: "uncertain" },
    };
    next = transitionState(next, "VERIFYING", "adapter result retrieval failed");
    next = transitionState(
      next,
      exhausted ? "BLOCKED" : "CORRECTING",
      exhausted ? "autonomous attempt limit exhausted" : "retry result retrieval failure"
    );
    await this.store.save(next);
    await appendAuditEvent(this.store.auditPath, {
      mission_id: next.mission_id,
      task_id: next.current_task.task_id,
      attempt_id: next.current_task.attempt_id,
      prompt_hash: promptHash,
      hermes_status: result.status,
      supervisor_decision: next.status,
      evidence: [],
      approval_stop_reason: exhausted ? result.blocker : null,
    });
    return next;
  }

  async persistContractFailure(state, promptHash) {
    const exhausted = state.attempt_count >= state.max_attempts;
    const result = {
      status: "FAILED",
      task: state.current_task.description,
      evidence: [],
      changes: [],
      tests: [],
      blocker: "Hermes result contract validation failed",
      next_action: exhausted
        ? "Inspect the Hermes transport contract before starting a new task"
        : "Retry contract verification within the autonomous attempt limit",
      requires_approval: exhausted,
    };
    let next = {
      ...state,
      latest_result: result,
      blocker: result.blocker,
      next_action: result.next_action,
      verification_retry_count: state.verification_retry_count + 1,
      current_task: { ...state.current_task, dispatch_state: "result_received" },
    };
    next = transitionState(
      next,
      exhausted ? "BLOCKED" : "CORRECTING",
      exhausted ? "contract failure attempt limit exhausted" : "retry contract validation failure"
    );
    await this.store.save(next);
    await appendAuditEvent(this.store.auditPath, {
      mission_id: next.mission_id,
      task_id: next.current_task.task_id,
      attempt_id: next.current_task.attempt_id,
      prompt_hash: promptHash,
      hermes_status: result.status,
      supervisor_decision: next.status,
      evidence: [],
      approval_stop_reason: exhausted ? result.blocker : null,
    });
    return next;
  }

  async runOnce() {
    const lock = await acquireMissionLock(this.store.root, this.store.missionId);
    try {
      let state = await this.store.load();
      if (["COMPLETE", "BLOCKED", "WAITING_APPROVAL", "FAILED"].includes(state.status))
        return state;
      if (["RUNNING", "WAITING_RESULT", "VERIFYING"].includes(state.status))
        return this.recoverUnlocked(state);
      if (state.attempt_count >= state.max_attempts) {
        state = transitionState(
          { ...state, blocker: "Maximum autonomous attempts reached" },
          "BLOCKED",
          "attempt limit"
        );
        await this.store.save(state);
        return state;
      }
      const prompt = formatHermesPrompt(state);
      const promptHash = createHash("sha256").update(prompt).digest("hex");
      const attemptId = `attempt-${randomUUID()}`;
      state = transitionState(
        {
          ...state,
          attempt_count: state.attempt_count + 1,
          current_task: {
            ...state.current_task,
            attempt_id: attemptId,
            dispatch_state: "dispatched",
          },
        },
        "RUNNING",
        "dispatch"
      );
      await this.store.save(state);
      let handle;
      try {
        handle = await this.adapter.send_task({
          prompt,
          description: state.current_task.description,
          task_id: state.current_task.task_id,
          attempt_id: attemptId,
          correlation_id: attemptId,
          mutating: state.current_task.mutating,
          permission_decision: state.permission_decision,
        });
      } catch (error) {
        state.execution_retry_count += 1;
        state.blocker = `Adapter dispatch failed: ${error.message}`;
        state = transitionState(state, "BLOCKED", state.blocker);
        await this.store.save(state);
        return state;
      }
      state.current_task = { ...state.current_task, adapter_handle: handle };
      state = transitionState(state, "WAITING_RESULT", "dispatched");
      await this.store.save(state);
      let raw;
      try {
        raw = await this.adapter.wait_for_result(handle);
      } catch {
        return this.persistResultRetrievalFailure(state, promptHash);
      }
      state = transitionState(state, "VERIFYING", "result received");
      await this.store.save(state);
      let result;
      try {
        result = parseHermesResult(raw);
      } catch {
        return this.persistContractFailure(state, promptHash);
      }
      return this.persistDecision(state, result, decideResult(state, result), promptHash);
    } finally {
      await lock.release();
    }
  }

  async recover() {
    const lock = await acquireMissionLock(this.store.root, this.store.missionId);
    try {
      return await this.recoverUnlocked(await this.store.load());
    } finally {
      await lock.release();
    }
  }

  async recoverUnlocked(state) {
    if (!["RUNNING", "WAITING_RESULT", "VERIFYING"].includes(state.status)) return state;
    if (state.status !== "VERIFYING") {
      state = transitionState(state, "VERIFYING", "recover uncertain dispatch");
      await this.store.save(state);
    }
    const handle = state.current_task.adapter_handle;
    const status = handle ? await this.adapter.poll_status(handle) : { status: "unknown" };
    if (status.status === "complete") {
      const raw = await this.adapter.wait_for_result(handle);
      let result;
      try {
        result = parseHermesResult(raw);
      } catch {
        return this.persistContractFailure(state, null);
      }
      return this.persistDecision(state, result, decideResult(state, result), null);
    }
    if (state.current_task.mutating) {
      state.requires_user_approval = true;
      state.permission_decision = "REQUIRES_USER_APPROVAL";
      state.blocker = "Mutating task completion is uncertain; verify manually before resend";
      state = transitionState(state, "WAITING_APPROVAL", state.blocker);
      await this.store.save(state);
      return state;
    }
    state.blocker = `Adapter recovery status is ${status.status}; no automatic replay`;
    state = transitionState(state, "BLOCKED", state.blocker);
    await this.store.save(state);
    return state;
  }
}
