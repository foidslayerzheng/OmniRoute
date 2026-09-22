import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../../scripts/supervisor/cli.mjs";

async function capture(args) {
  let output = "";
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    await main(args);
    return output;
  } finally {
    process.stdout.write = original;
  }
}

function config() {
  return {
    milestone: "Supervisor V1",
    goal: "inspect",
    authoritative_facts: ["local only"],
    current_task: { description: "Run git status", mutating: false, scope: ["git status"] },
    acceptance_criteria: [
      { id: "c1", description: "status", required_evidence: ["git status"], status: "pending" },
    ],
    forbidden_topics: ["memory eval"],
    forbidden_paths: [".hermes/worktrees"],
    forbidden_actions: ["deploy"],
  };
}

test("CLI initializes, reports status, and dry-run prints prompt without changing state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervisor-cli-"));
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, JSON.stringify(config()));
  await capture(["init", "--state-root", root, "--mission", "m1", "--config", configPath]);
  const before = await readFile(path.join(root, "m1", "state.json"), "utf8");
  const dry = await capture(["run", "--state-root", root, "--mission", "m1", "--dry-run"]);
  assert.match(dry, /STATUS=/);
  assert.match(dry, /SIMULATED_DECISION=AUTO_CONTINUE/);
  assert.equal(await readFile(path.join(root, "m1", "state.json"), "utf8"), before);
  const status = await capture(["status", "--state-root", root, "--mission", "m1"]);
  assert.match(status, /"status": "PENDING"/);
});

test("CLI requires explicit adapter and fake integration completes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervisor-cli-fake-"));
  const configPath = path.join(root, "config.json");
  const responsePath = path.join(root, "response.txt");
  await writeFile(configPath, JSON.stringify(config()));
  await writeFile(
    responsePath,
    JSON.stringify({
      status: "COMPLETE",
      task: "Run git status",
      evidence: [{ type: "git_state", source: "git status", summary: "clean" }],
      changes: [],
      tests: ["pass"],
      blocker: null,
      next_action: "none",
      requires_approval: false,
    })
  );
  await capture(["init", "--state-root", root, "--mission", "m1", "--config", configPath]);
  await assert.rejects(
    () => main(["run", "--state-root", root, "--mission", "m1"]),
    /explicit --adapter/i
  );
  const run = await capture([
    "run",
    "--state-root",
    root,
    "--mission",
    "m1",
    "--adapter",
    "fake",
    "--response-file",
    responsePath,
  ]);
  assert.match(run, /"status": "COMPLETE"/);
});

test("CLI selects hermes-local only explicitly and requires its executable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervisor-cli-hermes-local-"));
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, JSON.stringify(config()));
  await capture(["init", "--state-root", root, "--mission", "m1", "--config", configPath]);
  await assert.rejects(
    () => main(["run", "--state-root", root, "--mission", "m1", "--adapter", "hermes-local"]),
    /hermes-local adapter requires --executable/i
  );
});
