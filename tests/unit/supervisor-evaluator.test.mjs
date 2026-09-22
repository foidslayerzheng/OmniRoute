import assert from "node:assert/strict";
import test from "node:test";

import {
  decideResult,
  detectDrift,
  evaluateAcceptance,
} from "../../scripts/supervisor/evaluator.mjs";
import { classifyPermission } from "../../scripts/supervisor/policy.mjs";
import { createInitialState } from "../../scripts/supervisor/schema.mjs";

function state(overrides = {}) {
  return {
    ...createInitialState({
      mission_id: "eval",
      milestone: "Supervisor V1",
      goal: "inspect repository",
      authoritative_facts: ["authoritative checkout only"],
      current_task: {
        description: "Run git status",
        mutating: false,
        scope: ["git status", "tests"],
      },
      acceptance_criteria: [
        {
          id: "c1",
          description: "git status proven",
          required_evidence: ["git status"],
          status: "pending",
        },
      ],
      forbidden_topics: ["memory eval"],
      forbidden_paths: [".hermes/worktrees"],
      forbidden_actions: ["deploy"],
    }),
    ...overrides,
  };
}

function result(overrides = {}) {
  return {
    status: "COMPLETE",
    task: "Run git status",
    evidence: [
      {
        type: "git_state",
        source: "git status",
        summary: "clean",
        timestamp: "now",
        hash: "a".repeat(64),
      },
    ],
    changes: [],
    tests: ["node test passed"],
    blocker: null,
    next_action: "none",
    requires_approval: false,
    ...overrides,
  };
}

test("permission precedence allows scoped work, requires approval for production, and forbids scope violations", () => {
  assert.equal(classifyPermission(state(), result()).decision, "AUTO_CONTINUE");
  assert.equal(
    classifyPermission(
      state(),
      result({ next_action: "restart production service", requires_approval: true })
    ).decision,
    "REQUIRES_USER_APPROVAL"
  );
  assert.equal(
    classifyPermission(state(), result({ next_action: "deploy unrelated architecture" })).decision,
    "FORBIDDEN"
  );
});

test("detects wrong task, forbidden path/topic, and irrelevant evidence as drift", () => {
  assert.equal(detectDrift(state(), result()).drift, false);
  assert.equal(detectDrift(state(), result({ task: "Run memory eval suite" })).drift, true);
  assert.equal(
    detectDrift(state(), result({ changes: ["used .hermes/worktrees/old"] })).drift,
    true
  );
  assert.equal(
    detectDrift(
      state(),
      result({ evidence: [{ type: "test", source: "npm test", summary: "pass" }] })
    ).drift,
    true
  );
});

test("drift matching uses token boundaries, phrase boundaries, and path prefixes", () => {
  const evalState = state({ forbidden_topics: ["eval"], forbidden_paths: [] });
  for (const value of ["eval", "eval work", "run eval", "/eval/", "eval-suite", "EVAL!"]) {
    const drift = detectDrift(evalState, result({ next_action: value }));
    assert.equal(drift.drift, true, `expected forbidden token match for ${value}`);
    assert.match(drift.reasons.join("; "), /forbidden context: eval/);
  }
  for (const value of ["evaluate", "evaluation", "reevaluate", "evaluator"]) {
    assert.equal(
      detectDrift(evalState, result({ next_action: value })).drift,
      false,
      `expected no forbidden token match for ${value}`
    );
  }

  const memoryState = state({ forbidden_topics: ["memory"], forbidden_paths: [] });
  assert.equal(detectDrift(memoryState, result({ next_action: "in-memory cache" })).drift, true);
  assert.equal(detectDrift(memoryState, result({ next_action: "memorable output" })).drift, false);

  const phraseState = state({ forbidden_topics: ["memory eval"], forbidden_paths: [] });
  assert.equal(detectDrift(phraseState, result({ next_action: "Run MEMORY EVAL." })).drift, true);
  assert.equal(detectDrift(phraseState, result({ next_action: "memory evaluation" })).drift, false);

  const pathState = state({ forbidden_topics: [], forbidden_paths: [".hermes/worktrees"] });
  assert.equal(detectDrift(pathState, result({ changes: ["used .hermes/worktrees"] })).drift, true);
  assert.equal(
    detectDrift(pathState, result({ changes: ["used .hermes/worktrees/old"] })).drift,
    true
  );
  assert.equal(
    detectDrift(pathState, result({ changes: ["used .hermes/worktrees-old"] })).drift,
    false
  );
});

test("acceptance requires concrete matching provenance and rejects hedged or missing proof", () => {
  assert.equal(evaluateAcceptance(state(), result()).complete, true);
  assert.equal(evaluateAcceptance(state(), result({ evidence: [] })).complete, false);
  assert.equal(
    evaluateAcceptance(
      state(),
      result({
        evidence: [{ type: "git_state", source: "other", summary: "git status probably clean" }],
      })
    ).complete,
    false
  );
});

test("acceptance requires private expected evidence as well as public provenance", () => {
  const privateState = state({
    acceptance_criteria: [
      {
        id: "hostname",
        description: "hostname matches pre-dispatch observation",
        required_evidence: ["hermes-local stdout"],
        expected_evidence: ["host-expected"],
        status: "pending",
      },
    ],
  });
  const baseEvidence = {
    type: "command_output",
    source: "hermes-local stdout",
    summary: "host-other",
    timestamp: "now",
    hash: "a".repeat(64),
  };
  assert.equal(
    evaluateAcceptance(privateState, result({ evidence: [baseEvidence] })).complete,
    false
  );
  assert.equal(
    evaluateAcceptance(
      privateState,
      result({ evidence: [{ ...baseEvidence, summary: "host-expected" }] })
    ).complete,
    true
  );
  assert.equal(
    evaluateAcceptance(
      privateState,
      result({ evidence: [{ ...baseEvidence, summary: "host-expected-extra" }] })
    ).complete,
    false
  );
});

test("decision handles blocker, approval, drift, correction, and proven completion", () => {
  assert.equal(decideResult(state(), result()).action, "COMPLETE");
  assert.equal(
    decideResult(state(), result({ blocker: "tool missing", status: "BLOCKED" })).action,
    "BLOCKED"
  );
  assert.equal(
    decideResult(state(), result({ next_action: "restart production" })).action,
    "WAITING_APPROVAL"
  );
  assert.equal(decideResult(state(), result({ task: "memory eval" })).action, "CORRECT");
  assert.equal(
    decideResult(state({ drift_correction_count: 1 }), result({ task: "memory eval" })).action,
    "BLOCKED"
  );
  assert.equal(decideResult(state(), result({ evidence: [] })).action, "RETRY_VERIFICATION");
});
