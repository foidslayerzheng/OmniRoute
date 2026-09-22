import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { redactValue } from "./redaction.mjs";
import { SupervisorStateSchema } from "./schema.mjs";

const ALLOWED = {
  PENDING: ["RUNNING", "BLOCKED", "FAILED"],
  RUNNING: ["WAITING_RESULT", "VERIFYING", "BLOCKED", "FAILED"],
  WAITING_RESULT: ["VERIFYING", "BLOCKED", "FAILED"],
  VERIFYING: ["COMPLETE", "CORRECTING", "WAITING_APPROVAL", "BLOCKED", "FAILED"],
  CORRECTING: ["RUNNING", "BLOCKED", "FAILED"],
  WAITING_APPROVAL: ["RUNNING", "BLOCKED", "FAILED"],
  BLOCKED: [],
  COMPLETE: [],
  FAILED: [],
};

export function transitionState(state, to, reason = "") {
  if (!(ALLOWED[state.status] ?? []).includes(to)) {
    throw new Error(`Invalid state transition ${state.status} -> ${to}`);
  }
  const timestamp = new Date().toISOString();
  return SupervisorStateSchema.parse({
    ...state,
    status: to,
    transition_timestamps: { ...state.transition_timestamps, [to]: timestamp },
    transition_history: [
      ...state.transition_history,
      { from: state.status, to, timestamp, reason },
    ],
    updated_at: timestamp,
    sequence: state.sequence + 1,
  });
}

export class MissionStateStore {
  constructor(root, missionId) {
    this.root = root;
    this.missionId = missionId;
    this.missionDir = path.join(root, missionId);
    this.statePath = path.join(this.missionDir, "state.json");
    this.auditPath = path.join(this.missionDir, "audit.jsonl");
  }

  async load() {
    return SupervisorStateSchema.parse(JSON.parse(await readFile(this.statePath, "utf8")));
  }

  async save(state, options = {}) {
    const parsed = SupervisorStateSchema.parse(redactValue(state));
    await mkdir(this.missionDir, { recursive: true, mode: 0o700 });
    try {
      const existing = await this.load();
      if (
        JSON.stringify(existing.authoritative_facts) !==
          JSON.stringify(parsed.authoritative_facts) &&
        !options.authoritativeFactsMigration
      ) {
        throw new Error("authoritative_facts are immutable without approved migration");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.statePath);
    const directory = await open(this.missionDir, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return parsed;
  }

  async migrateAuthoritativeFacts(facts, { userApproved = false } = {}) {
    if (!userApproved) throw new Error("authoritative fact migration requires user approval");
    const state = await this.load();
    return this.save(
      { ...state, authoritative_facts: facts, updated_at: new Date().toISOString() },
      { authoritativeFactsMigration: true }
    );
  }
}

export async function acquireMissionLock(root, missionId) {
  const missionDir = path.join(root, missionId);
  await mkdir(missionDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(missionDir, "mission.lock");
  const owner = `${process.pid}:${randomUUID()}`;
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify({ owner, pid: process.pid, timestamp: new Date().toISOString() })}\n`
    );
    await handle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`Mission ${missionId} is locked`);
    throw error;
  } finally {
    await handle?.close();
  }
  let released = false;
  return {
    owner,
    async release() {
      if (released) return;
      const current = JSON.parse(await readFile(lockPath, "utf8"));
      if (current.owner !== owner)
        throw new Error("Cannot release a lock owned by another process");
      await unlink(lockPath);
      released = true;
    },
  };
}
