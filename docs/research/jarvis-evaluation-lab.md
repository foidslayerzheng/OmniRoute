# Jarvis Evaluation Lab

This document defines the opt-in evaluation and optimization integrations used by the Jarvis/Hermes stack. These integrations are deliberately separated from production routing and deployment.

## Safety contract

1. No evaluation suite may deploy to production.
2. No optimization suite may edit production prompts, routing policy, credentials, or agent configuration automatically.
3. Candidate changes must produce retained artifacts and pass existing regression gates before promotion.
4. External tools run only from a manually dispatched evaluation workflow unless a later reviewed change explicitly enables scheduling.
5. Missing credentials cause a suite to skip or fail closed; credentials are never embedded in the repository.
6. External repositories/packages are pinned to reviewed commits in CI. Do not execute floating `main`/`latest` code in privileged jobs.
7. Browser and agent-security evaluations use bounded test tasks and test accounts. They do not receive production credentials by default.

## Existing foundations we reuse

The repository already contains a router evaluation system under `scripts/router-eval/` and the `check:router-eval` regression gate. The nightly LLM security workflow already uses promptfoo and NVIDIA garak. The lab extends these systems instead of creating parallel replacements.

## Hermes upstream audit

Purpose: detect capabilities that current upstream Hermes already provides before Jarvis custom-builds an overlapping subsystem.

The audit is read-only. It scans a pinned upstream checkout for capability evidence and records the upstream ref. It does not run `hermes update`, change packages, restart services, or deploy anything.

An upstream Hermes upgrade remains a candidate change and must be staged and pass Jarvis regression/evaluation suites before adoption.

## LLMRouterBench -> Empirical OmniRoute

Canonical upstream: `ynulihao/LLMRouterBench`.

`scripts/router-eval/import-llmrouterbench.py` converts LLMRouterBench JSON/JSONL records into OmniRoute's existing `RouterObservation` NDJSON format. The imported corpus then feeds the normal `eval:router` and router regression tooling.

A record with explicit router fields (`router`, `router_name`, `routing_algorithm`, or `configId`) is grouped under that router configuration. A plain model-response record is treated as a best-single-model baseline. This deliberately does not enable learned routing in production.

## Agent Lightning -> controlled improvement experiments

Canonical upstream: `microsoft/agent-lightning`.

Agent Lightning is permitted only in an experiment workspace. Candidate prompts/policies produced by an optimizer are artifacts, not deployed configuration.

Lifecycle:

`observe -> quantify -> optimize -> experiment -> regress -> promote`

`scripts/jarvis-eval/candidate_gate.py` provides a fail-closed boundary between optimization output and review. It compares baseline/candidate success, latency, cost, security failures, and optional browser success. It emits `promotionAllowed`; it has no code path that performs promotion.

## Agent security extension

Existing garak coverage remains in place. Extended evaluation adds:

- Snyk Agent Scan, the current successor to Invariant Labs MCP-Scan, for MCP/agent/skill inventory and scanning.
- AgentDojo for indirect prompt-injection attack/defense evaluation.

Canonical upstream repositories:

- `snyk/agent-scan`
- `sequrity-ai/agentdojo`

Agent Scan analysis may require Snyk authentication. A future live scan job must use a repository secret and must not persist the token in artifacts. Starting arbitrary auto-discovered MCP servers is forbidden in CI unless a reviewed fixture explicitly opts in.

The initial lab workflow only verifies the pinned source layout. This avoids silently starting tools or sending agent metadata to an external analysis API merely because someone ran a smoke test.

## Browser evaluation

Canonical upstream repositories:

- `ServiceNow/BrowserGym`
- `browser-use/benchmark`

BrowserGym supplies standardized browser environments. Browser Use Benchmark supplies bounded browser-agent tasks and includes Browserbase provider support. The initial workflow verifies reviewed pins and expected benchmark entrypoints without accessing live sites or accounts.

A later full benchmark job should use dedicated test credentials/accounts, explicit task limits, and retained traces/results.

## Reviewed external pins

Pins live in `config/jarvis-eval/external-pins.json`. They are intentionally immutable until a human-reviewed change updates the SHA and re-runs the lab smoke suite.

## Promotion gates

A candidate change may be proposed for normal review only after all relevant gates pass:

- functional/unit tests;
- router AIQ/cost/latency regression gate when routing changes;
- prompt-injection and agent-security tests when tools/permissions change;
- browser success/regression evaluation when browser behavior changes;
- explicit verification that no evaluation secret or task artifact contains production credentials;
- rollback path documented for runtime/framework upgrades.

Passing a lab gate does not itself merge, deploy, restart, or promote a candidate.
