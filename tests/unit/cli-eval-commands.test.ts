import test from "node:test";
import assert from "node:assert/strict";

const SUITE = {
  id: "suite-001",
  name: "Chat quality",
  samples: 50,
  rubric: "accuracy",
  updatedAt: "2026-05-14T10:00:00Z",
};

const RUN = {
  id: "run-001",
  suiteId: "suite-001",
  status: "completed",
  target: { type: "model", id: "gpt-4o", key: "model:gpt-4o", label: "Model: gpt-4o" },
  summary: { total: 50, passed: 43, failed: 7, passRate: 86 },
  avgLatencyMs: 840,
  createdAt: "2026-05-14T10:00:00Z",
};

const RUN_2 = {
  ...RUN,
  id: "run-002",
  target: { type: "combo", id: "fast", key: "combo:fast", label: "Combo: fast" },
};

const RUN_ENVELOPE = {
  suiteId: "suite-001",
  runGroupId: null,
  runs: [RUN, RUN_2],
  scorecard: { overallPassRate: 87 },
  recentRuns: [RUN],
  historyScorecard: { overallPassRate: 87 },
};

const SAMPLES = [
  { id: "s1", score: 0.9, passed: true, input: "Hello", output: "Hi there" },
  { id: "s2", score: 0.4, passed: false, input: "2+2=?", output: "5" },
];

function makeResp(data: unknown, status = 200) {
  const obj = {
    ok: status < 400,
    status,
    exitCode: status < 400 ? 0 : 1,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: new Headers(),
  };
  obj.json = obj.json.bind(obj);
  obj.text = obj.text.bind(obj);
  return obj;
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c: string | Uint8Array) => {
    if (typeof c === "string") chunks.push(c);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

function makeCmd(output = "json") {
  return { optsWithGlobals: () => ({ output, quiet: output !== "table" }) };
}

test("runEvalSuitesList retorna lista de suites", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    assert.ok(url.includes("/api/evals/suites"));
    return Promise.resolve(makeResp({ items: [SUITE] }));
  }) as any;

  const { runEvalSuitesList } = await import("../../bin/cli/commands/eval.mjs");
  const out = await captureStdout(() => runEvalSuitesList({}, makeCmd() as any));

  globalThis.fetch = origFetch;
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed[0].id, "suite-001");
});

test("runEvalSuitesGet busca suite por id", async () => {
  let capturedUrl = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    capturedUrl = url;
    return Promise.resolve(makeResp(SUITE));
  }) as any;

  const { runEvalSuitesGet } = await import("../../bin/cli/commands/eval.mjs");
  const out = await captureStdout(() => runEvalSuitesGet("suite-001", {}, makeCmd() as any));

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("/api/evals/suites/suite-001"));
  const parsed = JSON.parse(out);
  assert.equal(parsed.id, "suite-001");
});

test("runEvalRun envia suiteId e model no body", async () => {
  let capturedBody: any = null;
  let capturedUrl = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, opts: any) => {
    capturedUrl = url;
    if (opts?.body) capturedBody = JSON.parse(opts.body);
    return Promise.resolve(makeResp(RUN_ENVELOPE));
  }) as any;

  const { runEvalRun } = await import("../../bin/cli/commands/eval.mjs");
  await captureStdout(() =>
    runEvalRun("suite-001", { model: "gpt-4o", concurrency: 4 }, makeCmd() as any)
  );

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("/api/evals"));
  assert.deepEqual(capturedBody, {
    suiteId: "suite-001",
    target: { type: "model", id: "gpt-4o" },
  });
});

test("runEvalRun renders the creation envelope and does not poll completed runs with --watch", async () => {
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string) => {
    calls += 1;
    return Promise.resolve(makeResp(RUN_ENVELOPE));
  }) as any;

  try {
    const { runEvalRun } = await import("../../bin/cli/commands/eval.mjs");
    const out = await captureStdout(() =>
      runEvalRun("suite-001", { model: "gpt-4o", watch: true }, makeCmd() as any)
    );
    assert.deepEqual(JSON.parse(out), RUN_ENVELOPE);
  } finally {
    globalThis.fetch = origFetch;
  }

  assert.equal(calls, 1);
});

test("runEvalRun renders completed envelope runs with persisted target and summary fields in table mode", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string) => Promise.resolve(makeResp(RUN_ENVELOPE))) as any;

  try {
    const { runEvalRun } = await import("../../bin/cli/commands/eval.mjs");
    const out = await captureStdout(() =>
      runEvalRun(
        "suite-001",
        { model: "gpt-4o" },
        { optsWithGlobals: () => ({ output: "table", quiet: false }) } as any
      )
    );
    assert.match(out, /Model: gpt-4o/);
    assert.match(out, /86\.0%/);
    assert.match(out, /Combo: fast/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("runEvalRun propagates global transport options and uses one bounded creation attempt", async () => {
  let calls = 0;
  let capturedUrl = "";
  let capturedOptions: any = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, options: any) => {
    calls += 1;
    capturedUrl = url;
    capturedOptions = options;
    return Promise.resolve(makeResp(RUN_ENVELOPE));
  }) as any;

  try {
    const { runEvalRun } = await import("../../bin/cli/commands/eval.mjs");
    await captureStdout(() =>
      runEvalRun(
        "suite-001",
        { model: "gpt-4o" },
        {
          optsWithGlobals: () => ({
            output: "json",
            baseUrl: "https://evals.example.test/root/",
            apiKey: "eval-secret",
            timeout: 17,
            idempotencyKey: "eval-create-001",
          }),
        } as any
      )
    );
  } finally {
    globalThis.fetch = origFetch;
  }

  assert.equal(calls, 1);
  assert.equal(capturedUrl, "https://evals.example.test/root/api/evals");
  assert.equal(capturedOptions.headers.get("authorization"), "Bearer eval-secret");
  assert.equal(capturedOptions.headers.get("idempotency-key"), "eval-create-001");
  assert.ok(capturedOptions.signal instanceof AbortSignal);
});

test("runEvalList consumes recentRuns and propagates filters plus global transport options", async () => {
  let capturedUrl = "";
  let capturedOptions: any = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, options: any) => {
    capturedUrl = url;
    capturedOptions = options;
    return Promise.resolve(makeResp({
      suites: [],
      recentRuns: [RUN],
      scorecard: null,
      targets: [],
      apiKeys: [],
    }));
  }) as any;

  const { runEvalList } = await import("../../bin/cli/commands/eval.mjs");
  const out = await captureStdout(() =>
    runEvalList(
      { suite: "suite-001", status: "completed", since: "2026-05-01T00:00:00Z", limit: 25 },
      { optsWithGlobals: () => ({ output: "json", baseUrl: "https://evals.example.test" }) } as any
    )
  );

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("suiteId=suite-001"));
  assert.ok(capturedUrl.includes("status=completed"));
  assert.ok(capturedUrl.includes("since=2026-05-01T00%3A00%3A00Z"));
  assert.ok(capturedUrl.includes("limit=25"));
  assert.equal(capturedUrl.startsWith("https://evals.example.test/"), true);
  assert.equal(capturedOptions.method, "GET");
  assert.deepEqual(JSON.parse(out), [RUN]);
});

test("runEvalGet busca run por id", async () => {
  let capturedUrl = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    capturedUrl = url;
    return Promise.resolve(makeResp(RUN));
  }) as any;

  const { runEvalGet } = await import("../../bin/cli/commands/eval.mjs");
  const out = await captureStdout(() => runEvalGet("run-001", {}, makeCmd() as any));

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("/api/evals/runs/run-001"));
  const parsed = JSON.parse(out);
  assert.equal(parsed.id, "run-001");
});

test("runEvalResults mostra amostras", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string) => {
    return Promise.resolve(makeResp({ samples: SAMPLES }));
  }) as any;

  const { runEvalResults } = await import("../../bin/cli/commands/eval.mjs");
  const out = await captureStdout(() => runEvalResults("run-001", {}, makeCmd() as any));

  globalThis.fetch = origFetch;
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 2);
});

test("runEvalResults com --failed envia filter=failed na query", async () => {
  let capturedUrl = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    capturedUrl = url;
    return Promise.resolve(makeResp({ samples: SAMPLES.filter((s) => !s.passed) }));
  }) as any;

  const { runEvalResults } = await import("../../bin/cli/commands/eval.mjs");
  await captureStdout(() => runEvalResults("run-001", { failed: true }, makeCmd() as any));

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("filter=failed"));
});

test("runEvalCancel surfaces immutable 409 as a structured unsupported result", async () => {
  let capturedBody: any = null;
  let capturedUrl = "";
  const origFetch = globalThis.fetch;
  const originalExitCode = process.exitCode;
  globalThis.fetch = ((url: string, opts: any) => {
    capturedUrl = url;
    if (opts?.body) capturedBody = JSON.parse(opts.body);
    return Promise.resolve(
      makeResp(
        { error: { code: "eval_run_immutable", message: "Completed eval runs cannot be cancelled" } },
        409
      )
    );
  }) as any;

  let out = "";
  try {
    out = await captureStdout(async () => {
      const { runEvalCancel } = await import("../../bin/cli/commands/eval.mjs");
      await runEvalCancel("run-001", { yes: true }, makeCmd() as any);
    });
  } finally {
    globalThis.fetch = origFetch;
    process.exitCode = originalExitCode;
  }

  assert.ok(capturedUrl.includes("/api/evals/runs/run-001"));
  assert.equal(capturedBody.op, "cancel");
  assert.deepEqual(JSON.parse(out), {
    error: { code: "eval_run_immutable", message: "Completed eval runs cannot be cancelled" },
  });
  assert.equal(out.includes("Cancelled"), false);
});

test("runEvalScorecard renderiza scorecard em modo table", async () => {
  const scoreData = {
    score: 0.87,
    passed: 43,
    total: 50,
    metrics: { accuracy: 0.87, fluency: 0.92 },
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string) => {
    return Promise.resolve(makeResp(scoreData));
  }) as any;

  const { runEvalScorecard } = await import("../../bin/cli/commands/eval.mjs");
  const out = await captureStdout(() =>
    runEvalScorecard("run-001", {}, { optsWithGlobals: () => ({ output: "table" }) } as any)
  );

  globalThis.fetch = origFetch;
  assert.ok(out.includes("87.0%") || out.includes("Scorecard"));
  assert.ok(out.includes("43/50") || out.includes("43"));
});
