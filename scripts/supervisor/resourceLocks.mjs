import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";

import { redactValue } from "./redaction.mjs";

const MODES = new Set(["read", "write"]);

function normalizeResource(id) {
  if (typeof id !== "string" || !id.includes(":")) throw new Error("Invalid resource ID");
  const separator = id.indexOf(":");
  const scheme = id.slice(0, separator).toLowerCase();
  const value = id.slice(separator + 1);
  if (!scheme || !value) throw new Error("Invalid resource ID");
  if (["path", "repo"].includes(scheme)) {
    return { id: `${scheme}:${path.resolve(value)}`, scheme, value: path.resolve(value) };
  }
  return { id: `${scheme}:${value}`, scheme, value };
}

function hierarchical(resource) {
  return resource.scheme === "path" || resource.scheme === "repo";
}

function sameOrAncestor(left, right) {
  const relative = path.relative(left, right);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function overlaps(left, right) {
  if (hierarchical(left) && hierarchical(right)) {
    return sameOrAncestor(left.value, right.value) || sameOrAncestor(right.value, left.value);
  }
  return left.id === right.id;
}

function conflicts(request, record) {
  if (!overlaps(normalizeResource(request.id), normalizeResource(record.resource_id))) return false;
  return request.mode === "write" || record.mode === "write";
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export class ResourceLockManager {
  constructor(root, { managerTimeoutMs = 5_000 } = {}) {
    this.root = root;
    this.lockDir = path.join(root, "resource-locks");
    this.managerPath = path.join(this.lockDir, "manager.lock");
    this.managerTimeoutMs = managerTimeoutMs;
  }

  async initialize() {
    await mkdir(this.lockDir, { recursive: true, mode: 0o700 });
  }

  async withManagerLock(action) {
    await this.initialize();
    const started = Date.now();
    let handle;
    while (!handle) {
      try {
        handle = await open(this.managerPath, "wx", 0o600);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (Date.now() - started >= this.managerTimeoutMs) {
          throw new Error("Resource lock manager is busy");
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    try {
      return await action();
    } finally {
      await handle.close();
      await unlink(this.managerPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  async inspectUnlocked() {
    await this.initialize();
    const names = (await readdir(this.lockDir)).filter(
      (name) => name.endsWith(".json") && name !== "manager.lock"
    );
    const records = [];
    for (const name of names.sort()) {
      try {
        records.push(JSON.parse(await readFile(path.join(this.lockDir, name), "utf8")));
      } catch {
        throw new Error(`Malformed resource lock: ${name}`);
      }
    }
    return records;
  }

  async inspect() {
    return this.inspectUnlocked();
  }

  async acquire(requests, owner) {
    if (!Array.isArray(requests) || !requests.length) {
      return { owner_token: randomUUID(), lock_ids: [] };
    }
    const normalized = requests.map((request) => {
      if (!MODES.has(request.mode)) throw new Error("Invalid resource lock mode");
      return { ...request, ...normalizeResource(request.id) };
    });
    return this.withManagerLock(async () => {
      const existing = await this.inspectUnlocked();
      for (const request of normalized) {
        const collision = existing.find((record) => conflicts(request, record));
        if (collision) throw new Error(`Resource conflict: ${request.id}`);
      }
      const ownerToken = randomUUID();
      const created = [];
      try {
        for (const request of normalized) {
          const lockId = randomUUID();
          const record = redactValue({
            lock_id: lockId,
            owner_token: ownerToken,
            resource_id: request.id,
            mode: request.mode,
            mission_id: owner.mission_id,
            lane_id: owner.lane_id,
            task_id: owner.task_id,
            attempt_id: owner.attempt_id,
            pid: owner.pid ?? process.pid,
            process_start: owner.process_start ?? null,
            acquired_at: new Date().toISOString(),
          });
          const file = path.join(this.lockDir, `${lockId}.json`);
          const handle = await open(file, "wx", 0o600);
          try {
            await handle.writeFile(`${JSON.stringify(record)}\n`);
            await handle.sync();
          } finally {
            await handle.close();
          }
          created.push(lockId);
        }
      } catch (error) {
        await Promise.all(
          created.map((lockId) => unlink(path.join(this.lockDir, `${lockId}.json`)).catch(() => {}))
        );
        throw error;
      }
      return { owner_token: ownerToken, lock_ids: created };
    });
  }

  async release(lease) {
    return this.withManagerLock(async () => {
      for (const lockId of lease.lock_ids ?? []) {
        const file = path.join(this.lockDir, `${lockId}.json`);
        let record;
        try {
          record = JSON.parse(await readFile(file, "utf8"));
        } catch (error) {
          if (error?.code === "ENOENT") throw new Error(`Resource lock ${lockId} does not exist`);
          throw error;
        }
        if (record.owner_token !== lease.owner_token) {
          throw new Error("Cannot release a resource lock owned by another owner");
        }
      }
      await Promise.all(
        (lease.lock_ids ?? []).map((lockId) => unlink(path.join(this.lockDir, `${lockId}.json`)))
      );
    });
  }

  async recoverStale(lockId, proof) {
    if (!proof) throw new Error("Dead-owner proof is required for stale lock recovery");
    return this.withManagerLock(async () => {
      const file = path.join(this.lockDir, `${lockId}.json`);
      let record;
      try {
        record = JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
      if (!proof.owner_dead || pidAlive(record.pid)) {
        throw new Error("Resource lock owner is not proven dead");
      }
      if (
        record.process_start &&
        proof.process_start !== undefined &&
        proof.process_start === record.process_start
      ) {
        throw new Error("Resource lock process identity still matches");
      }
      await unlink(file);
      return true;
    });
  }
}
