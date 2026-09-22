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

test("V2 CLI initializes DAG with default concurrency three and dry-run does not dispatch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervisor-v2-cli-"));
  const config = path.join(root, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      goal: "test",
      tasks: [
        {
          task_id: "a",
          description: "Run a",
          depends_on: [],
          resources: [],
          can_parallelize: true,
          acceptance_criteria: [
            { id: "a", description: "a", required_evidence: ["a"], status: "pending" },
          ],
          verifiers: [],
          max_attempts: 3,
          requires_approval: false,
        },
      ],
    })
  );
  await capture(["dag-init", "--state-root", root, "--mission", "m", "--config", config]);
  const before = await readFile(path.join(root, "m", "dag-state.json"), "utf8");
  const dry = await capture(["dag-run", "--state-root", root, "--mission", "m", "--dry-run"]);
  assert.match(dry, /SIMULATED_DAG_DISPATCH/);
  assert.equal(JSON.parse(before).max_concurrency, 3);
  assert.equal(await readFile(path.join(root, "m", "dag-state.json"), "utf8"), before);
  await assert.rejects(
    () => main(["dag-run", "--state-root", root, "--mission", "m"]),
    /explicit --adapter/i
  );
});
