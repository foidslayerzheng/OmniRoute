import test from "node:test";
import assert from "node:assert/strict";
import { buildEvalRunBody } from "../../bin/cli/commands/eval.mjs";

test("eval CLI maps --model to API model target", () => {
  assert.deepEqual(
    buildEvalRunBody("jarvis-core-v1", {
      model: "nvidia/nemotron-3.5-lightning:free",
      tag: "task-class:simple",
    }),
    {
      suiteId: "jarvis-core-v1",
      target: {
        type: "model",
        id: "nvidia/nemotron-3.5-lightning:free",
      },
      tag: "task-class:simple",
    }
  );
});

test("eval CLI maps --combo to API combo target", () => {
  assert.deepEqual(
    buildEvalRunBody("jarvis-core-v1", {
      model: "auto",
      combo: "free-pool",
    }),
    {
      suiteId: "jarvis-core-v1",
      target: { type: "combo", id: "free-pool" },
    }
  );
});

test("eval CLI default model remains auto", () => {
  assert.deepEqual(
    buildEvalRunBody("jarvis-core-v1", {}),
    {
      suiteId: "jarvis-core-v1",
      target: { type: "model", id: "auto" },
    }
  );
});
