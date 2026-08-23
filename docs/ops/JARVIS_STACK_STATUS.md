---
title: "JARVIS / Hermes no-spend completion status"
---

# JARVIS / Hermes no-spend completion status

## Scope and safety boundary

This record covers the constrained JARVIS evaluation conducted against the
isolated `jarvis-phase-d` OmniRoute source checkout. It does not authorize a
deployment, a provider purchase, paid fallback, Governor-limit change, secret
access, or Task Observer deployment.

- Routing implementation: `open-sse/services/` in the OmniRoute source tree.
- Routing telemetry: `open-sse/services/comboMetrics.ts`.
- Deterministic cache: the committed Phase E change below.
- Local persistence and backup implementation: `src/lib/db/backup.ts`.
- Host Operator implementation: the separately allowlisted `jarvis-admin`
  plugin; it is intentionally outside this repository.
- Task Observer remains proposal-only; deployment was not enabled or modified.

## Committed implementation

The verified source history contains:

- `235be21d7` — Phase D: integrate task-aware OmniRoute routing.
- `a5ff8a3f1` — Phase D: add task-aware routing telemetry.
- `7afc18d70` — Phase E: restrict deterministic semantic cache.

The focused Phase D routing/telemetry checkpoint previously passed with 13
passing tests and no failures. The task-aware policy retains explicit-routing,
provider-health, quota/cooldown, context/tool compatibility, existing fallback,
and Governor boundaries. Paid candidates have no automatic task-aware boost;
transient HTTP 429 outcomes are excluded from tuner learning.

## Phase F bounded free-only evaluation (2026-08-21)

Execution used the existing `OpenRouter Free` connection and six direct,
connection-pinned `:free` requests. The Host Operator rejects non-`:free`
model IDs before dispatch, pins the named connection, sets `X-OmniRoute-No-Cache`,
and reported `fallback: false` for every result. No paid route or paid fallback
was invoked.

| Task class | Model | Transport result | Validity / interpretation |
| --- | --- | --- | --- |
| simple | nvidia/nemotron-3.5-lightning:free | HTTP 200, 3,589 ms, 164 total tokens | INVALID: emitted internal analysis instead of exactly `17`. |
| coding | poolside/laguna-s-2.1:free | HTTP 502, 9,022 ms, 358 total tokens | BLOCKED: upstream failure; availability failure, not a quality score. |
| reasoning | nvidia/nemotron-3.5-lightning:free | HTTP 200, 3,078 ms, 323 total tokens | INVALID: math was correct but output exhausted before required final line. |
| long-context | nvidia/nemotron-3-ultra-550b-a55b:free | HTTP 200, 14,892 ms, 456 total tokens | INVALID: identified the record facts but exhausted output before the requested two bullets. |
| agent/tool proposal | nvidia/nemotron-3-ultra-550b-a55b:free | HTTP 200, 9,816 ms, 236 total tokens | PASS: returned four lines, named read-only `read_file` before edits, and ended `DEPLOY: NO`. |
| multi-step | nvidia/nemotron-3-ultra-550b-a55b:free | HTTP 200, 6,012 ms, 324 total tokens | INVALID: correctly classified HTTP 429 as transient and non-training, but exhausted output before the exact three-step completion. |

This is a bounded evaluation, not a routing-ranking update. Invalid wrapper/
internal-analysis outputs and upstream availability failures must not be used to
promote or demote routing candidates.

## Phase G evidence

- Host Operator `replace_exact` requires one exact occurrence per operation.
- Host Operator full-file `write` rejects existing files; it is create-only.
- The active Host Operator service allowlist contains only `omniroute.service`,
  `hermes-gateway.service`, `hermes-desktop-backend.service`, and
  `hermes-n8n-bridge.service`.
- The Host Operator success-classifier implementation was inspected previously:
  structured `{ "ok": true }` takes precedence over generic error-text
  heuristics, while actual failure results still hard-stop.
- Focused Hermes classifier tests are `TEST_BLOCKED_MISSING_PYTEST`: the
  configured Hermes virtualenv reports `No module named pytest`. No package was
  installed.
- Hindsight HTTP 401 is `APPROVAL_GATE`: source inspection identifies the retain
  path but cannot establish or replace the required authentication material
  without credential/account remediation.
- Host Operator schema/runtime audit found the bounded free-batch actions and
  create-only/exact-replace protections. Any required edit to the protected
  `jarvis-admin` plugin remains an approval gate when its modification root is
  not allowlisted.
- Hermes credential redaction was previously verified enabled and was not
  changed.

## Phase H verification matrix

| Check | Status | Evidence / boundary |
| --- | --- | --- |
| task-aware general, coding, reasoning routing | PASS | Focused Phase D policy/integration/telemetry checkpoint. |
| low-latency/background routing | PASS | Phase D checkpoint; no routing mutation in this cycle. |
| local/private to local-qwen | PASS | Existing Phase D policy checkpoint. |
| controlled fallback and 429 cooldown semantics | PASS | Existing Phase D checkpoint; current free calls had `fallback: false`. |
| task-aware telemetry | PASS | Phase D telemetry commit and focused checkpoint. |
| deterministic cache restriction | PASS | Phase E commit; live MISS-to-HIT probe not performed. |
| cache bypass | PASS | Free batch sends `X-OmniRoute-No-Cache: true`. |
| Governor authority / no-paid-route invariant | PASS | No Governor mutation; free-only host action rejects paid IDs and reported free-route enforcement. |
| Host Operator safe operation | PASS | Bounded roots/service allowlist, exact replacement, and create-only write inspected. |
| Task Observer proposal path and deployment disabled | PASS | Prior verified checkpoint; no mutation in this cycle. |
| fake/unknown approval rejection | BLOCKED | No safe exposed endpoint to exercise without creating an approval artifact. |
| Hindsight retain/retrieve | BLOCKED | HTTP 401 requires secret/account remediation. |
| agent/tool proposal path | PASS | Bounded free-only agent proposal returned read-only-first plan and `DEPLOY: NO`. |
| observability / service health | BLOCKED | Current constrained service/read APIs do not expose an allowlisted health result. |
| backup/restore-test evidence | PASS | Source implements local backup restore in `src/lib/db/backup.ts`; operational restore evidence is separately protected. |

## Recovery and troubleshooting

Use the source-controlled backup implementation and `docs/ops/DATABASE_GUIDE.md`
for OmniRoute recovery procedures. Do not infer host-specific credentials,
locations, service names beyond the Host Operator allowlist, or backup encryption
state from this document. For a Hindsight 401, obtain explicit authorization for
credential/account remediation; never print or replace authentication material in
chat or source control. For unavailable free models, record the provider status
as availability only and do not update quality routing weights.

## Remaining approval gates

1. Hindsight HTTP 401 remediation requires explicitly authorized credential or
   external-account action.
2. Any source/schema change within the protected `jarvis-admin` plugin requires
   its modification root to be allowlisted.
3. Live service-health, approval-rejection, and operational restore evidence
   require a safe read-only endpoint or explicit operator authorization.
