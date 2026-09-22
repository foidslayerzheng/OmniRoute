import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import { redactValue } from "./redaction.mjs";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function cacheKey(spec, fingerprint) {
  const { fresh: _fresh, ...identity } = spec;
  return createHash("sha256").update(canonical({ identity, fingerprint })).digest("hex");
}

export class EvidenceCache {
  constructor(root, { now = Date.now } = {}) {
    this.dir = path.join(root, "evidence-cache");
    this.now = now;
    this.counters = { hits: 0, misses: 0, writes: 0 };
  }

  stats() {
    return { ...this.counters };
  }

  async get(spec, fingerprint) {
    if (spec.fresh || !fingerprint) {
      this.counters.misses += 1;
      return null;
    }
    const file = path.join(this.dir, `${cacheKey(spec, fingerprint)}.json`);
    let entry;
    try {
      entry = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.counters.misses += 1;
        return null;
      }
      throw error;
    }
    const maxAge = Number(spec.max_age_ms ?? 0);
    if (
      entry.fingerprint !== fingerprint ||
      maxAge <= 0 ||
      this.now() - entry.created_ms > maxAge
    ) {
      this.counters.misses += 1;
      return null;
    }
    this.counters.hits += 1;
    return entry;
  }

  async put(spec, fingerprint, result) {
    if (!fingerprint) throw new Error("Evidence cache requires a resource fingerprint");
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const key = cacheKey(spec, fingerprint);
    const entry = redactValue({
      cache_key: key,
      verifier_id: spec.verifier_id,
      resource_id: spec.resource_id ?? null,
      fingerprint,
      created_ms: this.now(),
      timestamp: new Date(this.now()).toISOString(),
      result,
    });
    try {
      const handle = await open(path.join(this.dir, `${key}.json`), "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(entry)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.counters.writes += 1;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    return entry;
  }
}
