import { mock } from "node:test";

// Block outbound network before any application code loads
globalThis.fetch = async (...args) => {
  throw new Error("BLOCKED: outbound network disabled in tests");
};

// Mock runEvalSuiteAgainstTarget WITHOUT importing the real runtime module.
// Importing runtime.ts would transitively load core.ts and lock SQLITE_FILE
// to isolateDataDir's temp path, preventing test-level DATA_DIR isolation.
const inferenceFn = mock.fn(async (opts) => ({
  suiteId: opts.suiteId,
  suiteName: "mocked-suite",
  target: { key: "mocked-target", label: "Mocked Target" },
  results: [
    {
      caseId: "mock-case-1",
      input: { messages: [{ role: "user", content: "hello" }] },
      output: "mocked response",
      expected: { strategy: "exact", value: "mocked" },
      passed: true,
      latencyMs: 42,
    },
  ],
  summary: { total: 1, passed: 1, failed: 0, passRate: 100 },
}));

mock.module("../../src/lib/evals/runtime", {
  defaultExport: false,
  namedExports: {
    buildEvalTargetOptions: async () => [],
    runEvalSuiteAgainstTarget: inferenceFn,
  },
});

// Expose for tests
globalThis.__inferenceMock = inferenceFn;

console.log("[mock-inference] fetch blocked, inference runner mocked (no real runtime loaded)");
