import { redactValue } from "../redaction.mjs";

export const TYPESAFE_JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_JEV_MODEL = "jev-latest";

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
    model: TYPESAFE_JEV_MODEL,
    usage: null,
  };
}

function strings(values) {
  return (values ?? [])
    .map((value) => (typeof value === "string" ? value : (value?.executor ?? value?.id)))
    .filter((value) => typeof value === "string" && value.length > 0)
    .slice(0, 100);
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
  return {
    [method]: {
      type: "choice",
      instructions:
        method === "classifyTask"
          ? "Classify this task"
          : method === "rankExecutors"
            ? "Select the best executor"
            : "Recommend the next action",
      criteria: Object.fromEntries(choices.map((choice) => [choice, choice])),
    },
  };
}

function finiteNonnegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function probability(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function usageFrom(value) {
  const usage = value?.usage;
  if (!usage || typeof usage !== "object") return null;
  return {
    input_tokens: finiteNonnegative(usage.input_tokens),
    output_tokens: finiteNonnegative(usage.output_tokens),
    estimated_cost: finiteNonnegative(usage.estimated_cost ?? usage.cost),
  };
}

function decisionFrom(value, method, questions, threshold, started) {
  if (!value || !value.answers || typeof value.answers !== "object") {
    return fallback("malformed Jev result", started);
  }
  const selected = [];
  const confidences = [];
  for (const [questionId, question] of Object.entries(questions)) {
    const entry = value.answers[questionId];
    if (method === "selectTools" || method === "selectContext") {
      if (!entry || entry.type !== "noul" || !probability(entry.noul)) {
        return fallback("malformed Jev result", started);
      }
      const calibratedConfidence = Math.max(entry.noul, 1 - entry.noul);
      confidences.push(calibratedConfidence);
      if (entry.noul >= 0.5) selected.push(questionId.slice(method.length + 1));
    } else {
      if (
        !entry ||
        entry.type !== "choice" ||
        !Object.hasOwn(question.criteria, entry.choice) ||
        !probability(entry.confidence)
      ) {
        return fallback("malformed Jev result", started);
      }
      confidences.push(entry.confidence);
      selected.push(entry.choice);
    }
  }
  const confidence = Math.min(...confidences);
  if (confidence < threshold) return fallback("Jev confidence below threshold", started);
  return redactValue({
    selected,
    confidence,
    categories: {},
    latency_ms: performance.now() - started,
    fallback: false,
    fallback_reason: null,
    model: TYPESAFE_JEV_MODEL,
    usage: usageFrom(value),
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class TypeSafeJevAdapter {
  #apiKey;

  constructor({
    enabled = false,
    apiKey,
    endpoint = TYPESAFE_JEV_ENDPOINT,
    timeoutMs = 1_500,
    maxRequestBytes = 32_768,
    maxResponseBytes = 32_768,
    confidenceThreshold = 0.6,
    maxCalls = 0,
    spendCeiling = 0,
    maxRetries = 1,
    retryDelayMs = 50,
    fetchFn = globalThis.fetch,
  } = {}) {
    this.enabled = enabled === true;
    this.#apiKey = apiKey;
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.maxRequestBytes = maxRequestBytes;
    this.maxResponseBytes = maxResponseBytes;
    this.confidenceThreshold = confidenceThreshold;
    this.maxCalls = maxCalls;
    this.spendCeiling = spendCeiling;
    this.maxRetries = Math.min(Math.max(maxRetries, 0), 1);
    this.retryDelayMs = retryDelayMs;
    this.fetchFn = fetchFn;
    this.usage = {
      calls: 0,
      http_attempts: 0,
      input_tokens: 0,
      output_tokens: 0,
      estimated_spend: 0,
    };
  }

  getUsage() {
    return { ...this.usage };
  }

  async decide(method, input = {}) {
    const started = performance.now();
    if (!this.enabled) return fallback("real Jev disabled", started);
    if (!this.#apiKey) return fallback("TypeSafe API key unavailable", started);
    if (this.usage.calls >= this.maxCalls) return fallback("Jev call limit reached", started);
    if (this.usage.estimated_spend >= this.spendCeiling) {
      return fallback("Jev spend ceiling reached", started);
    }
    const questions = questionsFor(method, input);
    if (!Object.keys(questions).length) {
      return fallback("Jev question has no choices", started);
    }
    const body = JSON.stringify({
      model: TYPESAFE_JEV_MODEL,
      state: redactValue(input.state ?? input),
      questions,
    });
    if (Buffer.byteLength(body, "utf8") > this.maxRequestBytes) {
      return fallback("Jev request limit exceeded", started);
    }
    this.usage.calls += 1;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("Jev timeout")), this.timeoutMs);
      let response;
      try {
        this.usage.http_attempts += 1;
        response = await this.fetchFn(this.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            "content-type": "application/json",
          },
          body,
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        return fallback(controller.signal.aborted ? "Jev timeout" : "Jev unavailable", started);
      }
      const transient = response.status === 429 || response.status >= 500;
      if (transient && attempt < this.maxRetries) {
        clearTimeout(timer);
        if (this.retryDelayMs > 0) await delay(this.retryDelayMs);
        continue;
      }
      if (!response.ok) {
        clearTimeout(timer);
        return fallback(`Jev HTTP ${response.status}`, started);
      }
      let text;
      try {
        text = await response.text();
      } catch {
        clearTimeout(timer);
        return fallback(
          controller.signal.aborted ? "Jev timeout" : "malformed Jev result",
          started
        );
      }
      clearTimeout(timer);
      if (Buffer.byteLength(text, "utf8") > this.maxResponseBytes) {
        return fallback("Jev response limit exceeded", started);
      }
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        return fallback("malformed Jev result", started);
      }
      const decision = decisionFrom(value, method, questions, this.confidenceThreshold, started);
      const usage = usageFrom(value);
      if (usage) {
        this.usage.input_tokens += usage.input_tokens ?? 0;
        this.usage.output_tokens += usage.output_tokens ?? 0;
        this.usage.estimated_spend += usage.estimated_cost ?? 0;
      }
      return decision;
    }
    return fallback("Jev unavailable", started);
  }
}

for (const method of METHODS) {
  TypeSafeJevAdapter.prototype[method] = function invoke(input) {
    return this.decide(method, input);
  };
}
