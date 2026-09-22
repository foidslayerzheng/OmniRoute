import { access } from "node:fs/promises";

import { redactValue } from "../redaction.mjs";

const METHODS = [
  "classifyTask",
  "rankExecutors",
  "selectTools",
  "selectContext",
  "recommendNextAction",
];

function fallback(reason, started = performance.now()) {
  return {
    selected: [],
    confidence: null,
    categories: {},
    latency_ms: performance.now() - started,
    fallback: true,
    fallback_reason: reason,
    model: "local-laya",
    usage: null,
  };
}

function strings(values) {
  return (values ?? [])
    .map((value) => (typeof value === "string" ? value : (value?.executor ?? value?.id)))
    .filter((value) => typeof value === "string" && value.length > 0)
    .slice(0, 20);
}

function questionsFor(method, input) {
  if (method === "selectTools" || method === "selectContext") {
    return Object.fromEntries(
      strings(input.available).map((id) => [
        `${method}:${id}`,
        {
          type: "noul",
          instructions: `Should ${id} be included for this task?`,
        },
      ])
    );
  }
  const choices =
    method === "rankExecutors"
      ? strings(input.candidates)
      : method === "classifyTask"
        ? strings(input.choices ?? input.task_types)
        : strings(input.choices ?? ["retry", "escalate", "stop"]);
  return choices.length
    ? {
        [method]: {
          type: "choice",
          instructions:
            method === "classifyTask"
              ? "Classify this task"
              : method === "rankExecutors"
                ? "Recommend an executor from the policy-allowed candidates"
                : "Recommend the next action",
          criteria: Object.fromEntries(choices.map((choice) => [choice, choice])),
        },
      }
    : {};
}

function probability(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function normalize(result, method, questions, threshold, started) {
  if (!result?.answers || typeof result.answers !== "object") {
    return fallback("malformed Laya result", started);
  }
  const selected = [];
  const confidences = [];
  for (const [questionId, question] of Object.entries(questions)) {
    const answer = result.answers[questionId];
    if (question.type === "noul") {
      if (!answer || answer.type !== "noul" || !probability(answer.noul)) {
        return fallback("malformed Laya result", started);
      }
      confidences.push(Math.max(answer.noul, 1 - answer.noul));
      if (answer.noul >= 0.5) selected.push(questionId.slice(method.length + 1));
      continue;
    }
    if (
      !answer ||
      answer.type !== "choice" ||
      !Object.hasOwn(question.criteria, answer.choice) ||
      !answer.probabilities ||
      !probability(answer.probabilities[answer.choice])
    ) {
      return fallback("malformed Laya result", started);
    }
    selected.push(answer.choice);
    confidences.push(answer.probabilities[answer.choice]);
  }
  const confidence = confidences.length ? Math.min(...confidences) : null;
  if (confidence === null || confidence < threshold) {
    return fallback("Laya confidence below threshold", started);
  }
  return redactValue({
    selected,
    confidence,
    categories: {},
    latency_ms: performance.now() - started,
    fallback: false,
    fallback_reason: null,
    model: "local-laya",
    usage: result.usage ?? null,
  });
}

async function defaultPathExists(modelDir) {
  try {
    await access(modelDir);
    return true;
  } catch {
    return false;
  }
}

async function defaultLoadLaya(options) {
  const { Laya } = await import("@receptron/laya");
  return Laya.load(options);
}

function within(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Laya timeout")), timeoutMs);
    }),
  ]);
}

export class NullLayaAdapter {
  async decide() {
    return fallback("Laya unavailable");
  }
}

export class FakeLayaAdapter {
  constructor(responses = {}, { confidenceThreshold = 0.6 } = {}) {
    this.responses = responses;
    this.confidenceThreshold = confidenceThreshold;
  }

  async decide(method) {
    const started = performance.now();
    const value = this.responses[method];
    if (!value || !Array.isArray(value.selected)) return fallback("malformed Laya result", started);
    const confidence = Number.isFinite(value.confidence) ? value.confidence : null;
    if (confidence === null || confidence < this.confidenceThreshold) {
      return fallback("Laya confidence below threshold", started);
    }
    return redactValue({
      selected: value.selected.filter((item) => typeof item === "string").slice(0, 20),
      confidence,
      categories: value.categories && typeof value.categories === "object" ? value.categories : {},
      latency_ms: performance.now() - started,
      fallback: false,
      fallback_reason: null,
      model: "fake-laya",
      usage: null,
    });
  }
}

export class LocalLayaAdapter {
  constructor({
    enabled = false,
    modelDir,
    timeoutMs = 1_500,
    confidenceThreshold = 0.6,
    pathExists = defaultPathExists,
    loadLaya = defaultLoadLaya,
  } = {}) {
    this.enabled = enabled === true;
    this.modelDir = modelDir;
    this.timeoutMs = timeoutMs;
    this.confidenceThreshold = confidenceThreshold;
    this.pathExists = pathExists;
    this.loadLaya = loadLaya;
    this.runtime = null;
  }

  async decide(method, input = {}) {
    const started = performance.now();
    if (!this.enabled) return fallback("local Laya disabled", started);
    if (!this.modelDir) return fallback("local Laya model directory is required", started);
    if (!(await this.pathExists(this.modelDir))) {
      return fallback("local Laya model directory is unavailable", started);
    }
    const questions = questionsFor(method, input);
    if (!Object.keys(questions).length) return fallback("Laya question has no choices", started);
    try {
      this.runtime ??= await within(this.loadLaya({ modelDir: this.modelDir }), this.timeoutMs);
      const state = redactValue(input.state ?? input);
      const result = await within(this.runtime.systemOne(state, questions), this.timeoutMs);
      return normalize(result, method, questions, this.confidenceThreshold, started);
    } catch (error) {
      this.runtime = null;
      return fallback(
        /timeout/i.test(error?.message) ? "Laya timeout" : "Laya unavailable",
        started
      );
    }
  }
}

for (const method of METHODS) {
  for (const Adapter of [NullLayaAdapter, FakeLayaAdapter, LocalLayaAdapter]) {
    Adapter.prototype[method] = function invoke(input) {
      return this.decide(method, input);
    };
  }
}
