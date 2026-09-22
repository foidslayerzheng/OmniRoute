import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  FakeLayaAdapter,
  LocalLayaAdapter,
  NullLayaAdapter,
} from "../../scripts/supervisor/routing/layaAdapter.mjs";
import { filterRoutingInputs } from "../../scripts/supervisor/routing/inputFilter.mjs";

const choiceResult = (choice, probabilities = { local: 0.9, codex: 0.1 }) => ({
  answers: {
    rankExecutors: {
      type: "choice",
      choice,
      probabilities,
    },
  },
  usage: { input_tokens: 12 },
});

test("Laya is disabled by default and does not load a runtime", async () => {
  let loads = 0;
  const adapter = new LocalLayaAdapter({
    modelDir: "/models/laya",
    loadLaya: async () => {
      loads += 1;
      throw new Error("must not load");
    },
  });
  const result = await adapter.rankExecutors({ candidates: ["local"] });
  assert.equal(result.fallback, true);
  assert.match(result.fallback_reason, /disabled/i);
  assert.equal(loads, 0);
});

test("null Laya fallback is safe and advisory", async () => {
  const result = await new NullLayaAdapter().rankExecutors({ candidates: ["local"] });
  assert.equal(result.fallback, true);
  assert.deepEqual(result.selected, []);
});

test("enabled local Laya requires an existing explicit model directory", async () => {
  let loads = 0;
  const adapter = new LocalLayaAdapter({
    enabled: true,
    loadLaya: async () => {
      loads += 1;
    },
  });
  const result = await adapter.rankExecutors({ candidates: ["local"] });
  assert.equal(result.fallback, true);
  assert.match(result.fallback_reason, /model directory/i);
  assert.equal(loads, 0);
});

test("local Laya converts typed choice probabilities into bounded advice", async () => {
  const calls = [];
  const adapter = new LocalLayaAdapter({
    enabled: true,
    modelDir: "/models/laya",
    pathExists: async () => true,
    loadLaya: async (options) => {
      calls.push(options);
      return {
        async systemOne(state, questions) {
          calls.push({ state, questions });
          return choiceResult("local");
        },
      };
    },
  });
  const result = await adapter.rankExecutors({
    description: "read repository status",
    candidates: ["local", "codex"],
  });
  assert.deepEqual(result.selected, ["local"]);
  assert.equal(result.confidence, 0.9);
  assert.equal(result.fallback, false);
  assert.equal(result.model, "local-laya");
  assert.deepEqual(calls[0], { modelDir: "/models/laya" });
  assert.equal(calls[1].questions.rankExecutors.type, "choice");
});

test("malformed, low-confidence, unavailable, and timed-out Laya fail safely", async () => {
  const fixtures = [
    async () => ({}),
    async () => choiceResult("local", { local: 0.4, codex: 0.6 }),
    async () => {
      throw new Error("unavailable");
    },
    async () => new Promise(() => {}),
  ];
  for (const [index, systemOne] of fixtures.entries()) {
    const adapter = new LocalLayaAdapter({
      enabled: true,
      modelDir: "/models/laya",
      pathExists: async () => true,
      timeoutMs: index === 3 ? 10 : 100,
      confidenceThreshold: 0.8,
      loadLaya: async () => ({ systemOne }),
    });
    const result = await adapter.rankExecutors({ candidates: ["local", "codex"] });
    assert.equal(result.fallback, true);
    assert.deepEqual(result.selected, []);
  }
});

test("Laya receives redacted state and can return typed noul inclusion advice", async () => {
  let seen;
  const adapter = new LocalLayaAdapter({
    enabled: true,
    modelDir: "/models/laya",
    pathExists: async () => true,
    loadLaya: async () => ({
      async systemOne(state, questions) {
        seen = { state, questions };
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: "noul", noul: id.endsWith(":required") ? 0.9 : 0.1 },
            ])
          ),
        };
      },
    }),
  });
  const result = await adapter.selectTools({
    state: { token: "super-secret-token" },
    available: ["required", "optional"],
  });
  assert.deepEqual(result.selected, ["required"]);
  assert.doesNotMatch(JSON.stringify(seen), /super-secret-token/);
  assert.ok(Object.values(seen.questions).every((question) => question.type === "noul"));
});

test("required tools and context survive Laya filtering", async () => {
  const filtered = await filterRoutingInputs({
    task_description: "test",
    laya: new FakeLayaAdapter({
      selectTools: { selected: ["optional-tool"], confidence: 0.9 },
      selectContext: { selected: ["small"], confidence: 0.9 },
    }),
    contexts: [
      { id: "required", content: "x".repeat(100), required: true },
      { id: "small", content: "small", required: false },
      { id: "large", content: "y".repeat(200), required: false },
    ],
    tools: [
      { id: "required-tool", required: true },
      { id: "optional-tool", required: false },
      { id: "unused-tool", required: false },
    ],
    required_context_ids: ["required"],
    required_tool_ids: ["required-tool"],
  });
  assert.deepEqual(
    filtered.context.map((item) => item.id),
    ["required", "small"]
  );
  assert.deepEqual(
    filtered.tools.map((item) => item.id),
    ["required-tool", "optional-tool"]
  );
});

test("unavailable Laya preserves the full policy-allowed input set", async () => {
  const filtered = await filterRoutingInputs({
    task_description: "test",
    laya: new NullLayaAdapter(),
    contexts: [
      { id: "a", content: "a" },
      { id: "b", content: "b" },
    ],
    tools: [{ id: "one" }, { id: "two" }],
  });
  assert.deepEqual(
    filtered.context.map((item) => item.id),
    ["a", "b"]
  );
  assert.deepEqual(
    filtered.tools.map((item) => item.id),
    ["one", "two"]
  );
});

test("Supervisor has no hosted advisory secret path or bundled Laya model dependency", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const inspected = await Promise.all(
    [
      "scripts/supervisor/cli.mjs",
      "scripts/supervisor/README.md",
      "scripts/supervisor/routing/layaAdapter.mjs",
      "package.json",
    ].map((file) => readFile(path.join(root, file), "utf8"))
  );
  const retiredSecret = ["TYPE", "SAFE_API_KEY"].join("");
  const retiredAdapter = ["type", "safe", "J", "evAdapter.mjs"].join("");
  assert.equal(inspected.join("\n").includes(retiredSecret), false);
  assert.doesNotMatch(await readFile(path.join(root, "package.json"), "utf8"), /@receptron\/laya/);
  await assert.rejects(
    () => access(path.join(root, "scripts/supervisor/routing", retiredAdapter)),
    { code: "ENOENT" }
  );
});
