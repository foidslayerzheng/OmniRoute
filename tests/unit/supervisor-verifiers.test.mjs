import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { VerifierHarness } from "../../scripts/supervisor/verifiers/index.mjs";

test("file, hash, artifact, command, git, and result-contract verifiers return structured results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "verifiers-"));
  const file = path.join(root, "artifact.txt");
  await writeFile(file, "hello\n");
  const harness = new VerifierHarness();
  for (const spec of [
    { verifier_id: "fileExists", path: file },
    {
      verifier_id: "fileHash",
      path: file,
      expected: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
    },
    {
      verifier_id: "artifactHash",
      path: file,
      expected: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
    },
    { verifier_id: "commandTest", executable: "/usr/bin/printf", args: ["ok"], expected: "ok" },
    { verifier_id: "gitStatus", cwd: process.cwd() },
    { verifier_id: "gitDiff", cwd: process.cwd() },
    {
      verifier_id: "resultContract",
      value: JSON.stringify({
        status: "COMPLETE",
        task: "x",
        evidence: ["proof"],
        changes: [],
        tests: [],
        blocker: null,
        next_action: "none",
        requires_approval: false,
      }),
    },
  ]) {
    const verified = await harness.run(spec, {});
    assert.equal(verified.status, "PASS", `${spec.verifier_id}: ${verified.reason}`);
    assert.equal(verified.verifier_id, spec.verifier_id);
    assert.ok(verified.evidence.length > 0);
  }
});

test("expected mismatch fails and mutating verifier is blocked", async () => {
  const harness = new VerifierHarness();
  assert.equal(
    (
      await harness.run(
        { verifier_id: "commandTest", executable: "/usr/bin/printf", args: ["x"], expected: "y" },
        {}
      )
    ).status,
    "FAIL"
  );
  assert.equal(
    (
      await harness.run(
        { verifier_id: "commandTest", executable: "/usr/bin/printf", args: ["x"], mutating: true },
        {}
      )
    ).status,
    "BLOCKED"
  );
});

test("service, HTTP, and sqlite verifiers fail closed on unavailable targets", async () => {
  const harness = new VerifierHarness({ timeoutMs: 100 });
  assert.equal(
    (
      await harness.run(
        { verifier_id: "serviceState", service: "definitely-missing.service", expected: "active" },
        {}
      )
    ).status,
    "FAIL"
  );
  assert.equal(
    (
      await harness.run(
        { verifier_id: "httpCheck", url: "http://127.0.0.1:1", expected_status: 200 },
        {}
      )
    ).status,
    "FAIL"
  );
  assert.equal(
    (
      await harness.run(
        { verifier_id: "sqliteReadOnly", path: "/missing/database.sqlite", query: "SELECT 1" },
        {}
      )
    ).status,
    "FAIL"
  );
});

test("unknown verifier and non-loopback HTTP are blocked", async () => {
  const harness = new VerifierHarness();
  assert.equal((await harness.run({ verifier_id: "unknown" }, {})).status, "BLOCKED");
  assert.equal(
    (await harness.run({ verifier_id: "httpCheck", url: "https://example.com" }, {})).status,
    "BLOCKED"
  );
});
