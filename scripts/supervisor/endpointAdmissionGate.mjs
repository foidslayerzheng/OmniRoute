import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";

const POLL_INTERVAL_MS = 10;

function endpointHash(endpointKey) {
  return createHash("sha256").update(endpointKey).digest("hex");
}

async function processStart(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    return stat.slice(close + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

async function ownerAlive(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return false;
  const currentStart = await processStart(owner.pid);
  return currentStart !== null && currentStart === owner.process_start;
}

function cancelledError() {
  const error = new Error("Endpoint admission queue wait cancelled");
  error.code = "ABORT_ERR";
  return error;
}

async function waitPoll(signal) {
  if (signal?.aborted) throw cancelledError();
  await new Promise((resolve, reject) => {
    let abort = null;
    const finish = () => {
      if (abort) signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, POLL_INTERVAL_MS);
    if (!signal) return;
    abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(cancelledError());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export class EndpointAdmissionGate {
  constructor({ root, endpointKey, capacity = 1, queueTimeoutMs = 300_000 } = {}) {
    if (!root) throw new Error("Endpoint admission root is required");
    if (!endpointKey) throw new Error("Endpoint admission key is required");
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Endpoint admission capacity must be a positive integer");
    }
    this.root = root;
    this.endpointKey = endpointKey;
    this.capacity = capacity;
    this.queueTimeoutMs = queueTimeoutMs;
    this.endpointDir = path.join(root, endpointHash(endpointKey));
  }

  async reclaimIfDead(slotPath) {
    let owner;
    try {
      owner = JSON.parse(await readFile(path.join(slotPath, "owner.json"), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw new Error("Endpoint admission owner record is malformed");
    }
    if (await ownerAlive(owner)) return false;
    const abandoned = `${slotPath}.abandoned-${randomUUID()}`;
    try {
      await rename(slotPath, abandoned);
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }
    await rm(abandoned, { recursive: true });
    return true;
  }

  async acquire(owner = {}, { signal } = {}) {
    await mkdir(this.endpointDir, { recursive: true, mode: 0o700 });
    const started = Date.now();
    const processStartValue = await processStart(process.pid);
    while (true) {
      if (signal?.aborted) throw cancelledError();
      for (let slot = 0; slot < this.capacity; slot += 1) {
        const slotPath = path.join(this.endpointDir, `slot-${slot}`);
        try {
          await mkdir(slotPath, { mode: 0o700 });
          const ownerToken = randomUUID();
          await writeFile(
            path.join(slotPath, "owner.json"),
            `${JSON.stringify({
              endpoint_key: this.endpointKey,
              slot,
              owner_token: ownerToken,
              task_id: owner.task_id ?? null,
              attempt_id: owner.attempt_id ?? null,
              pid: process.pid,
              process_start: processStartValue,
              acquired_at: new Date().toISOString(),
            })}\n`,
            { mode: 0o600 }
          );
          let released = false;
          return {
            slot,
            slotPath,
            waitedMs: Date.now() - started,
            release: async () => {
              if (released) return;
              const persisted = JSON.parse(
                await readFile(path.join(slotPath, "owner.json"), "utf8")
              );
              if (persisted.owner_token !== ownerToken) {
                throw new Error("Cannot release endpoint admission owned by another process");
              }
              await rm(path.join(slotPath, "owner.json"));
              await rmdir(slotPath);
              released = true;
            },
          };
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
          await this.reclaimIfDead(slotPath);
        }
      }
      if (Date.now() - started >= this.queueTimeoutMs) {
        throw new Error("Endpoint admission queue wait timed out");
      }
      await waitPoll(signal);
    }
  }
}
