import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

import { hashEvidence } from "../redaction.mjs";
import { parseHermesResult } from "../resultContract.mjs";

const execFileAsync = promisify(execFile);

function evidence(type, source, summary) {
  const timestamp = new Date().toISOString();
  const record = { type, source, summary: String(summary), timestamp };
  return { ...record, hash: hashEvidence(record) };
}

function outputResult(spec, type, source, observed) {
  const matches =
    spec.expected === undefined || String(observed).trim() === String(spec.expected).trim();
  return {
    verifier_id: spec.verifier_id,
    status: matches ? "PASS" : "FAIL",
    evidence: [evidence(type, source, observed)],
    reason: matches ? "Observed value matched" : "Observed value did not match",
    retryable: !matches,
    cache_hit: false,
  };
}

async function shellFree(spec, executable, args, options = {}) {
  const { stdout } = await execFileAsync(executable, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: options.maxOutputBytes,
    encoding: "utf8",
    shell: false,
    env: options.env,
  });
  return outputResult(spec, options.type ?? "command_output", options.source, stdout);
}

async function fileFingerprint(file, withHash = false) {
  const metadata = await stat(file);
  const base = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
  if (!withHash) return base;
  return `${base}:${createHash("sha256")
    .update(await readFile(file))
    .digest("hex")}`;
}

export class VerifierHarness {
  constructor({ cache = null, timeoutMs = 10_000, maxOutputBytes = 65_536 } = {}) {
    this.cache = cache;
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.count = 0;
  }

  async fingerprint(spec) {
    if (["fileExists"].includes(spec.verifier_id)) return fileFingerprint(spec.path, false);
    if (["fileHash", "artifactHash"].includes(spec.verifier_id))
      return fileFingerprint(spec.path, true);
    return spec.fingerprint ?? null;
  }

  async run(spec, context = {}) {
    this.count += 1;
    if (!spec || typeof spec.verifier_id !== "string")
      return this.blocked("unknown", "Invalid verifier");
    if (spec.mutating && !context.approved) {
      return this.blocked(spec.verifier_id, "Mutating verifier requires approval");
    }
    let fingerprint = null;
    try {
      fingerprint = await this.fingerprint(spec);
    } catch {
      // The verifier reports the missing/unreadable resource below.
    }
    if (this.cache && fingerprint) {
      const hit = await this.cache.get(spec, fingerprint);
      if (hit) return { ...hit.result, cache_hit: true };
    }
    let result;
    try {
      result = await this.execute(spec, context);
    } catch (error) {
      result = {
        verifier_id: spec.verifier_id,
        status: "FAIL",
        evidence: [],
        reason: String(error?.message ?? error).slice(0, 500),
        retryable: true,
        cache_hit: false,
      };
    }
    if (this.cache && fingerprint && result.status === "PASS" && spec.max_age_ms > 0) {
      await this.cache.put(spec, fingerprint, result);
    }
    return result;
  }

  blocked(verifierId, reason) {
    return {
      verifier_id: verifierId,
      status: "BLOCKED",
      evidence: [],
      reason,
      retryable: false,
      cache_hit: false,
    };
  }

  async execute(spec) {
    const options = { timeoutMs: this.timeoutMs, maxOutputBytes: this.maxOutputBytes };
    if (spec.verifier_id === "fileExists") {
      await access(spec.path);
      return outputResult(spec, "file", spec.path, spec.path);
    }
    if (["fileHash", "artifactHash"].includes(spec.verifier_id)) {
      const digest = createHash("sha256")
        .update(await readFile(spec.path))
        .digest("hex");
      return outputResult(spec, "file", spec.path, digest);
    }
    if (spec.verifier_id === "commandTest") {
      if (!spec.executable || !Array.isArray(spec.args ?? []))
        return this.blocked(spec.verifier_id, "Invalid command verifier");
      return shellFree(spec, spec.executable, spec.args ?? [], {
        ...options,
        cwd: spec.cwd,
        source: spec.executable,
        type: "test",
      });
    }
    if (spec.verifier_id === "gitStatus") {
      return shellFree(spec, "git", ["status", "--short"], {
        ...options,
        cwd: spec.cwd,
        source: `git status:${spec.cwd}`,
        type: "git_state",
      });
    }
    if (spec.verifier_id === "gitDiff") {
      return shellFree(spec, "git", ["diff", "--no-ext-diff"], {
        ...options,
        cwd: spec.cwd,
        source: `git diff:${spec.cwd}`,
        type: "git_state",
      });
    }
    if (spec.verifier_id === "serviceState") {
      return shellFree(spec, "systemctl", ["is-active", spec.service], {
        ...options,
        source: `systemctl is-active:${spec.service}`,
        type: "service_state",
      });
    }
    if (spec.verifier_id === "httpCheck") {
      const url = new URL(spec.url);
      if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
        return this.blocked(spec.verifier_id, "HTTP verifier is restricted to loopback");
      }
      const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      const expected = spec.expected_status ?? 200;
      return outputResult({ ...spec, expected }, "service_state", spec.url, response.status);
    }
    if (spec.verifier_id === "sqliteReadOnly") {
      const { default: Database } = await import("better-sqlite3");
      const database = new Database(spec.path, { readonly: true, fileMustExist: true });
      try {
        if (!/^\s*(?:SELECT|PRAGMA\b(?!.*=))/i.test(spec.query)) {
          return this.blocked(spec.verifier_id, "SQLite verifier permits read-only queries only");
        }
        const rows = database.prepare(spec.query).all(spec.params ?? []);
        return outputResult(spec, "other", `sqlite:${spec.path}`, JSON.stringify(rows));
      } finally {
        database.close();
      }
    }
    if (spec.verifier_id === "resultContract") {
      const parsed = parseHermesResult(spec.value);
      return outputResult(spec, "other", "result-contract", parsed.status);
    }
    return this.blocked(spec.verifier_id, "Unknown verifier");
  }
}
