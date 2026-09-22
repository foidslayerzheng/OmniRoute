import { routeTask } from "./empiricalRouter.mjs";

const TASKS = [
  "shell-read",
  "coding-edit",
  "test-debug",
  "research",
  "verifier-heavy",
  "failure-retry",
];

const OUTCOMES = {
  local: {
    "shell-read": [true, 30, 0, 0],
    "coding-edit": [false, 80, 0, 1],
    "test-debug": [true, 70, 0, 0],
    research: [false, 90, 0, 1],
    "verifier-heavy": [true, 55, 0, 0],
    "failure-retry": [false, 100, 0, 2],
  },
  codex: Object.fromEntries(
    TASKS.map((task, index) => [
      task,
      [true, 120 + index * 10, 0.02, task === "failure-retry" ? 1 : 0],
    ])
  ),
};

function statistics(taskType) {
  const localSuccess = ["shell-read", "test-debug", "verifier-heavy"].includes(taskType) ? 9 : 2;
  return [
    {
      task_type: taskType,
      executor: "local",
      model: "qwen",
      provider: "custom",
      samples: 10,
      successes: localSuccess,
      verifier_passes: localSuccess,
      acceptance_passes: localSuccess,
      smoothed_success: (localSuccess + 1) / 12,
      smoothed_verified: (localSuccess + 1) / 12,
      average_latency_ms: 60,
      average_cost: 0,
      average_retries: localSuccess > 5 ? 0 : 1,
      recent_failures: 10 - localSuccess,
    },
    {
      task_type: taskType,
      executor: "codex",
      model: "codex",
      provider: "omniroute",
      samples: 10,
      successes: 9,
      verifier_passes: 9,
      acceptance_passes: 9,
      smoothed_success: 10 / 12,
      smoothed_verified: 10 / 12,
      average_latency_ms: 140,
      average_cost: 0.02,
      average_retries: 0.1,
      recent_failures: 1,
    },
  ];
}

function summarize(rows, overhead) {
  const completed = rows.filter((row) => row.success).length;
  return {
    tasks: rows.length,
    completion_rate: completed / rows.length,
    verifier_pass_rate: completed / rows.length,
    retries: rows.reduce((sum, row) => sum + row.retries, 0),
    runtime_ms: rows.reduce((sum, row) => sum + row.runtime, 0),
    context_bytes: rows.reduce((sum, row) => sum + row.context, 0),
    estimated_cost: rows.reduce((sum, row) => sum + row.cost, 0),
    routing_overhead_ms: overhead,
  };
}

function outcome(executor, taskType, context) {
  const [success, runtime, cost, retries] = OUTCOMES[executor][taskType];
  return { success, runtime, cost, retries, context };
}

export async function runRoutingBenchmark() {
  const baseline = TASKS.map((taskType) => outcome("codex", taskType, 8_000));
  const empirical = [];
  const empiricalLaya = [];
  const empiricalStarted = performance.now();
  for (const taskType of TASKS) {
    const base = {
      task_type: taskType,
      candidates: [
        {
          executor: "local",
          model: "qwen",
          provider: "custom",
          available: true,
          tools: [],
          context_ids: [],
          estimated_cost: 0,
        },
        {
          executor: "codex",
          model: "codex",
          provider: "omniroute",
          available: true,
          tools: [],
          context_ids: [],
          estimated_cost: 0.02,
        },
      ],
      statistics: statistics(taskType),
      permission_decision: "AUTO_CONTINUE",
      conservative_fallback: "codex",
      minimum_samples: 5,
      exploration_interval: 0,
      exploration_sequence: 1,
    };
    empirical.push(outcome(routeTask(base).selected.executor, taskType, 8_000));
  }
  const empiricalOverhead = performance.now() - empiricalStarted;
  const layaStarted = performance.now();
  for (const taskType of TASKS) {
    const selected = routeTask({
      task_type: taskType,
      candidates: [
        {
          executor: "local",
          model: "qwen",
          provider: "custom",
          available: true,
          tools: [],
          context_ids: [],
          estimated_cost: 0,
        },
        {
          executor: "codex",
          model: "codex",
          provider: "omniroute",
          available: true,
          tools: [],
          context_ids: [],
          estimated_cost: 0.02,
        },
      ],
      statistics: statistics(taskType),
      permission_decision: "AUTO_CONTINUE",
      conservative_fallback: "codex",
      minimum_samples: 5,
      exploration_interval: 0,
      exploration_sequence: 1,
      laya: { selected: ["local"], confidence: 0.9, fallback: false },
    }).selected.executor;
    empiricalLaya.push(outcome(selected, taskType, 5_000));
  }
  const layaOverhead = performance.now() - layaStarted;
  return {
    task_classes: TASKS,
    baseline: summarize(baseline, 0),
    empirical: summarize(empirical, empiricalOverhead),
    empirical_laya: summarize(empiricalLaya, layaOverhead),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${JSON.stringify(await runRoutingBenchmark(), null, 2)}\n`);
}
