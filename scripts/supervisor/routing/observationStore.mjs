import { appendFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { normalizeRoutingObservation, observationKey } from "./observation.mjs";

function groupKey(value) {
  return [
    value.task_type,
    value.executor,
    value.model ?? "",
    value.provider ?? "",
    value.tool_profile ?? "",
  ].join("\0");
}

const RECENT_WINDOW = 5;

function trailingCount(values, predicate) {
  let count = 0;
  for (let index = values.length - 1; index >= 0 && predicate(values[index]); index -= 1) {
    count += 1;
  }
  return count;
}

export class RoutingObservationStore {
  constructor(root) {
    this.root = path.join(root, "empirical-routing");
    this.observationsPath = path.join(this.root, "observations.jsonl");
    this.statsPath = path.join(this.root, "stats.json");
    this.lockPath = path.join(this.root, "write.lock");
  }

  async withLock(action) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let handle;
    for (let attempt = 0; !handle && attempt < 1000; attempt += 1) {
      try {
        handle = await open(this.lockPath, "wx", 0o600);
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`
        );
        await handle.sync();
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const owner = JSON.parse(await readFile(this.lockPath, "utf8"));
          if (Number.isInteger(owner.pid)) {
            try {
              process.kill(owner.pid, 0);
            } catch (probeError) {
              if (probeError?.code === "ESRCH") await unlink(this.lockPath);
            }
          }
        } catch (lockError) {
          if (lockError?.code !== "ENOENT") throw lockError;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    if (!handle) throw new Error("Routing observation store is busy");
    try {
      return await action();
    } finally {
      await handle.close();
      await unlink(this.lockPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  async list() {
    try {
      const text = await readFile(this.observationsPath, "utf8");
      return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => normalizeRoutingObservation(JSON.parse(line)));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  aggregate(values) {
    const groups = new Map();
    for (const value of values) {
      const key = groupKey(value);
      const item = groups.get(key) ?? {
        task_type: value.task_type,
        executor: value.executor,
        model: value.model,
        provider: value.provider,
        tool_profile: value.tool_profile,
        samples: 0,
        successes: 0,
        failures: 0,
        verifier_passes: 0,
        verifier_samples: 0,
        acceptance_passes: 0,
        acceptance_samples: 0,
        retries_total: 0,
        retry_samples: 0,
        retry_exhaustions: 0,
        latency_total_ms: 0,
        latency_samples: 0,
        cost_total: 0,
        cost_samples: 0,
        recent_failures: 0,
        recent: [],
      };
      item.samples += 1;
      item.successes += value.success ? 1 : 0;
      item.failures += value.success ? 0 : 1;
      item.verifier_passes += value.verifier_result === "PASS" ? 1 : 0;
      item.verifier_samples += value.verifier_result === null ? 0 : 1;
      item.acceptance_passes += value.acceptance_result === "PASS" ? 1 : 0;
      item.acceptance_samples += value.acceptance_result === null ? 0 : 1;
      if (value.retries !== null) {
        item.retries_total += value.retries;
        item.retry_samples += 1;
      }
      item.retry_exhaustions +=
        !value.success && /maximum autonomous attempts reached/i.test(value.failure_reason ?? "")
          ? 1
          : 0;
      if (value.latency_ms !== null) {
        item.latency_total_ms += value.latency_ms;
        item.latency_samples += 1;
      }
      if (value.estimated_cost !== null) {
        item.cost_total += value.estimated_cost;
        item.cost_samples += 1;
      }
      item.recent.push(value);
      if (item.recent.length > RECENT_WINDOW) item.recent.shift();
      item.recent_failures = item.recent.filter((entry) => !entry.success).length;
      groups.set(key, item);
    }
    return [...groups.values()].map((item) => {
      const recentLatency = item.recent.filter((entry) => entry.latency_ms !== null);
      const recentRetries = item.recent.filter((entry) => entry.retries !== null);
      const { recent, ...persisted } = item;
      return {
        ...persisted,
        recent_samples: recent.length,
        recent_successes: recent.filter((entry) => entry.success).length,
        recent_failure_streak: trailingCount(recent, (entry) => !entry.success),
        recent_success_streak: trailingCount(recent, (entry) => entry.success),
        recent_retry_exhaustions: recent.filter(
          (entry) =>
            !entry.success &&
            /maximum autonomous attempts reached/i.test(entry.failure_reason ?? "")
        ).length,
        recent_average_latency_ms: recentLatency.length
          ? recentLatency.reduce((sum, entry) => sum + entry.latency_ms, 0) / recentLatency.length
          : null,
        recent_average_retries: recentRetries.length
          ? recentRetries.reduce((sum, entry) => sum + entry.retries, 0) / recentRetries.length
          : null,
        smoothed_success: (item.successes + 1) / (item.samples + 2),
        smoothed_verified: item.verifier_samples
          ? (item.verifier_passes + 1) / (item.verifier_samples + 2)
          : null,
        smoothed_acceptance: item.acceptance_samples
          ? (item.acceptance_passes + 1) / (item.acceptance_samples + 2)
          : null,
        average_latency_ms: item.latency_samples
          ? item.latency_total_ms / item.latency_samples
          : null,
        average_cost: item.cost_samples ? item.cost_total / item.cost_samples : null,
        average_retries: item.retry_samples ? item.retries_total / item.retry_samples : null,
      };
    });
  }

  async stats() {
    return this.aggregate(await this.list());
  }

  async append(value) {
    const normalized = normalizeRoutingObservation(value);
    return this.withLock(async () => {
      const values = await this.list();
      if (values.some((item) => observationKey(item) === observationKey(normalized))) return false;
      await appendFile(this.observationsPath, `${JSON.stringify(normalized)}\n`, { mode: 0o600 });
      const statistics = this.aggregate([...values, normalized]);
      const temporary = `${this.statsPath}.${process.pid}.tmp`;
      const handle = await open(temporary, "w", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(statistics, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.statsPath);
      return true;
    });
  }
}
