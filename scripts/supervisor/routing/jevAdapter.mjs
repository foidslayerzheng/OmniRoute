import { spawn } from "node:child_process";

import { redactValue } from "../redaction.mjs";

const METHODS = [
  "classifyTask",
  "rankExecutors",
  "selectTools",
  "selectContext",
  "recommendNextAction",
];

function fallback(reason, latency = 0) {
  return {
    selected: [],
    confidence: null,
    categories: {},
    latency_ms: latency,
    fallback: true,
    fallback_reason: reason,
  };
}

function normalize(value, started, threshold) {
  const latency = performance.now() - started;
  if (!value || !Array.isArray(value.selected)) return fallback("malformed Jev result", latency);
  const confidence = Number.isFinite(value.confidence) ? value.confidence : null;
  if (confidence === null || confidence < threshold)
    return fallback("Jev confidence below threshold", latency);
  return redactValue({
    selected: value.selected.filter((item) => typeof item === "string").slice(0, 100),
    confidence,
    categories: value.categories && typeof value.categories === "object" ? value.categories : {},
    latency_ms: latency,
    fallback: false,
    fallback_reason: null,
  });
}

export class NullJevAdapter {
  async decide() {
    return fallback("Jev unavailable");
  }
}

export class FakeJevAdapter {
  constructor(responses = {}, { confidenceThreshold = 0.6 } = {}) {
    this.responses = responses;
    this.confidenceThreshold = confidenceThreshold;
  }

  async decide(method) {
    const started = performance.now();
    return normalize(this.responses[method], started, this.confidenceThreshold);
  }
}

export class CommandJevAdapter {
  constructor({
    executable,
    args = [],
    timeoutMs = 250,
    maxOutputBytes = 16_384,
    confidenceThreshold = 0.6,
  } = {}) {
    if (!executable) throw new Error("Explicit Jev command executable required");
    this.executable = executable;
    this.args = [...args];
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.confidenceThreshold = confidenceThreshold;
  }

  async decide(method, input) {
    const started = performance.now();
    return new Promise((resolve) => {
      const child = spawn(this.executable, [...this.args, method], {
        shell: false,
        stdio: ["pipe", "pipe", "ignore"],
      });
      let output = "";
      let exceeded = false;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve(fallback("Jev timeout", performance.now() - started));
      }, this.timeoutMs);
      child.stdout.on("data", (chunk) => {
        output += chunk.toString("utf8");
        if (Buffer.byteLength(output) > this.maxOutputBytes) {
          exceeded = true;
          child.kill("SIGTERM");
        }
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(fallback("Jev command unavailable", performance.now() - started));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (exceeded)
          return resolve(fallback("Jev output limit exceeded", performance.now() - started));
        if (code !== 0) return resolve(fallback("Jev command failed", performance.now() - started));
        try {
          resolve(normalize(JSON.parse(output), started, this.confidenceThreshold));
        } catch {
          resolve(fallback("malformed Jev result", performance.now() - started));
        }
      });
      child.stdin.end(JSON.stringify(redactValue(input)));
    });
  }
}

for (const method of METHODS) {
  for (const Adapter of [NullJevAdapter, FakeJevAdapter, CommandJevAdapter]) {
    Adapter.prototype[method] = function invoke(input) {
      return this.decide(method, input);
    };
  }
}
