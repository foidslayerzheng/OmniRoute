import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { filterRoutingInputs } from "../../scripts/supervisor/routing/inputFilter.mjs";
import {
  CommandJevAdapter,
  FakeJevAdapter,
  NullJevAdapter,
} from "../../scripts/supervisor/routing/jevAdapter.mjs";

test("null and low-confidence Jev fail open without blocking", async () => {
  const fallback = await new NullJevAdapter().rankExecutors({ candidates: ["local"] });
  assert.equal(fallback.fallback, true);
  const low = await new FakeJevAdapter({
    rankExecutors: { selected: ["local"], confidence: 0.2 },
  }).rankExecutors({});
  assert.equal(low.fallback, true);
});

test("command Jev timeout returns fallback instead of throwing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jev-command-"));
  const fixture = path.join(root, "jev.sh");
  await writeFile(fixture, "sleep 1\n");
  const result = await new CommandJevAdapter({
    executable: "/bin/sh",
    args: [fixture],
    timeoutMs: 20,
  }).classifyTask({ description: "hostname" });
  assert.equal(result.fallback, true);
  assert.match(result.fallback_reason, /timeout/i);
});

test("required tools and context survive Jev filtering and savings are measured", async () => {
  const jev = new FakeJevAdapter({
    selectTools: { selected: ["optional-tool"], confidence: 0.9 },
    selectContext: { selected: ["small"], confidence: 0.9 },
  });
  const filtered = await filterRoutingInputs({
    task_description: "test",
    jev,
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
  assert.ok(filtered.metrics.context_bytes_saved > 0);
  assert.ok(filtered.metrics.estimated_tokens_saved > 0);
});

test("unavailable Jev fails open to the full allowed input set", async () => {
  const filtered = await filterRoutingInputs({
    task_description: "test",
    jev: new NullJevAdapter(),
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
