import assert from "node:assert/strict";
import test from "node:test";

import { MAX_AUTONOMOUS_ATTEMPTS, TASK_STATUSES } from "../../scripts/supervisor/constants.mjs";
import { hashEvidence, redactValue } from "../../scripts/supervisor/redaction.mjs";
import { formatHermesPrompt, parseHermesResult } from "../../scripts/supervisor/resultContract.mjs";
import { createInitialState, SupervisorStateSchema } from "../../scripts/supervisor/schema.mjs";

const input = {
  mission_id: "mission-1",
  milestone: "Supervisor V1",
  goal: "Prove a bounded task",
  authoritative_facts: ["Use only the authoritative checkout"],
  current_task: { description: "Inspect repository", mutating: false, scope: ["repo"] },
  acceptance_criteria: [
    {
      id: "criterion-1",
      description: "Repository was inspected",
      required_evidence: ["git status"],
      status: "pending",
    },
  ],
  forbidden_topics: ["memory evals"],
  forbidden_paths: [".hermes/worktrees"],
  forbidden_actions: ["production restart"],
};

test("initial state has stable task identity, structured criteria, and bounded attempts", () => {
  const first = createInitialState(input);
  const second = createInitialState(input);
  assert.equal(first.current_task.task_id, second.current_task.task_id);
  assert.equal(first.current_task.attempt_id, null);
  assert.equal(first.status, "PENDING");
  assert.deepEqual(first.authoritative_facts, input.authoritative_facts);
  assert.equal(first.acceptance_criteria[0].status, "pending");
  assert.equal(first.max_attempts, MAX_AUTONOMOUS_ATTEMPTS);
  assert.ok(TASK_STATUSES.includes(first.status));
  assert.doesNotThrow(() => SupervisorStateSchema.parse(first));
  assert.throws(() => createInitialState({ ...input, max_attempts: 4 }));
});

test("parses strict JSON and line Hermes result contracts", () => {
  const json = parseHermesResult(
    JSON.stringify({
      status: "COMPLETE",
      task: "Inspect repository",
      evidence: [{ type: "git_state", source: "git status", summary: "clean" }],
      changes: [],
      tests: ["node --test: pass"],
      blocker: null,
      next_action: "none",
      requires_approval: false,
    })
  );
  assert.equal(json.status, "COMPLETE");
  assert.equal(json.evidence[0].source, "git status");

  const line = parseHermesResult(`STATUS=COMPLETE
TASK=Inspect repository
EVIDENCE=[{"type":"git_state","source":"git status","summary":"clean"}]
CHANGES=[]
TESTS=["pass"]
BLOCKER=NONE
NEXT_ACTION=none
REQUIRES_APPROVAL=NO`);
  assert.equal(line.requires_approval, false);
  assert.equal(line.blocker, null);
  assert.equal(line.evidence[0].type, "git_state");
});

test("rejects missing, duplicate, and oversized result fields", () => {
  assert.throws(() => parseHermesResult('{"status":"COMPLETE"}'), /missing|required/i);
  const duplicate = `STATUS=COMPLETE
STATUS=FAILED
TASK=x
EVIDENCE=[]
CHANGES=[]
TESTS=[]
BLOCKER=NONE
NEXT_ACTION=none
REQUIRES_APPROVAL=NO`;
  assert.throws(() => parseHermesResult(duplicate), /duplicate/i);
  assert.throws(() =>
    parseHermesResult(
      JSON.stringify({
        status: "COMPLETE",
        task: "x".repeat(70_000),
        evidence: [],
        changes: [],
        tests: [],
        blocker: null,
        next_action: "none",
        requires_approval: false,
      })
    )
  );
});

test("prompt is compact and mandates the universal contract", () => {
  const prompt = formatHermesPrompt(createInitialState(input));
  for (const field of [
    "STATUS=",
    "TASK=",
    "EVIDENCE=",
    "CHANGES=",
    "TESTS=",
    "BLOCKER=",
    "NEXT_ACTION=",
    "REQUIRES_APPROVAL=YES/NO",
  ]) {
    assert.match(prompt, new RegExp(field.replace("/", "\\/")));
  }
  assert.match(prompt, /Use only the authoritative checkout/);
  assert.match(prompt, /\.hermes\/worktrees/);
});

test("private acceptance expectations persist but are excluded from the Hermes prompt", () => {
  const expectedHostname = "host-private-value";
  const state = createInitialState({
    ...input,
    acceptance_criteria: [
      {
        ...input.acceptance_criteria[0],
        expected_evidence: [expectedHostname],
      },
    ],
  });
  assert.deepEqual(state.acceptance_criteria[0].expected_evidence, [expectedHostname]);
  assert.doesNotMatch(formatHermesPrompt(state), new RegExp(expectedHostname));
});

test("redacts nested secrets and hashes compact evidence deterministically", () => {
  const value = {
    token: "top-secret-token",
    nested: [{ authorization: "Bearer abcdefghijklmnop" }],
    summary: "api_key=sk-12345678901234567890",
    safe: "git status",
  };
  const redacted = redactValue(value);
  assert.equal(redacted.token, "[REDACTED]");
  assert.equal(redacted.nested[0].authorization, "[REDACTED]");
  assert.doesNotMatch(redacted.summary, /sk-|123456/);
  assert.equal(redacted.safe, "git status");
  const evidence = { type: "test", source: "node --test", summary: "pass", timestamp: "now" };
  assert.match(hashEvidence(evidence), /^[a-f0-9]{64}$/);
  assert.equal(hashEvidence(evidence), hashEvidence(evidence));
});
