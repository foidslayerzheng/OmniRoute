---
title: "Evaluations (Evals)"
version: 3.8.49
lastUpdated: 2026-09-07
---

# Evaluations (Evals)

> **Source of truth:** `src/lib/evals/`, `src/lib/db/evals.ts`, `src/app/api/evals/`
> **Last updated:** 2026-09-07 — v3.8.49

OmniRoute ships a generic evaluation framework you can use to benchmark routing
configurations, single providers/models, or the bundled "golden set" suites.
Use it to verify routing changes, validate new providers, and gate releases
before promoting them to production traffic.

The framework is implemented as:

- A pure runner (`src/lib/evals/evalRunner.ts`) that registers in-memory
  built-in suites, evaluates outputs against expected criteria, and aggregates
  scorecards.
- A persistence layer (`src/lib/db/evals.ts`) for custom (user-defined) suites
  and historical runs in SQLite.
- An orchestration layer (`src/lib/evals/runtime.ts`) that executes each case
  by dispatching real calls to `POST /v1/chat/completions`, captures latency
  and outputs, and persists the run.
- REST endpoints under `/api/evals/*` (management-auth only).
- A dashboard surface at `Dashboard → Usage → Evals` (`EvalsTab.tsx`).

## Concepts

### Suite

A suite is a named collection of test cases with a `description` and one or
more cases. Suites come from two sources:

| Source     | Where defined                                 | Mutable at runtime? |
| ---------- | --------------------------------------------- | ------------------- |
| `built-in` | Registered via `registerSuite()` at boot      | No (code-defined)   |
| `custom`   | Stored in SQLite `eval_suites` + `eval_cases` | Yes (via API/UI)    |

The current built-in suites (see `src/lib/evals/evalRunner.ts`):

- `golden-set` — 10 baseline cases across greeting/math/translation/safety
- `coding-proficiency` — Python/JS/SQL/TS/bug detection
- `reasoning-logic` — syllogisms, word problems, pattern recognition
- `multilingual` — translation and language detection
- `safety-guardrails` — PII, jailbreak, refusal, bias awareness
- `instruction-following` — JSON-only, numbered lists, language constraints
- `codex-comparison` — head-to-head coding tasks intended for compare mode
- `jarvis-core` — Jarvis instruction following, routing, memory, and safety cases
- `provider_retry` — 10 deterministic Hermes provider retry cases
- `memory` — 18 deterministic Hermes memory cases
- `browser_tool` — 9 deterministic Hermes browser-tool cases

### Case

Each case carries:

| Field      | Description                                                  |
| ---------- | ------------------------------------------------------------ |
| `id`       | Stable identifier (used to key outputs and metrics)          |
| `name`     | Human-readable label                                         |
| `model`    | Default model when the run uses `suite-default` targeting    |
| `input`    | `{ messages, max_tokens? }` — sent to `/v1/chat/completions` |
| `expected` | `{ strategy, value }` — scoring rubric (see below)           |
| `tags`     | Optional labels (e.g. `safety`, `pii`, `jailbreak`)          |

### Target

The same suite can be run against different targets. The target schema is
`evalTargetSchema` in `src/shared/validation/schemas.ts`:

| Target type     | `id`       | Schema meaning                                |
| --------------- | ---------- | --------------------------------------------- |
| `suite-default` | `null`     | Each case requests its built-in `model` field |
| `model`         | model name | Force every case through one direct model     |
| `combo`         | combo name | Run every case through one combo              |

For `model` and `combo`, the `id` field is required (enforced by Zod
`superRefine`). When `compareTarget` is provided, both targets must differ —
the runner persists both runs under the same `runGroupId` for A/B comparison.

Inference execution is currently fail closed. The only approved target is
`{ "type": "model", "id": "openai/qwen/qwen3.5-9b" }`. Before any case is
dispatched, the API verifies the exact active Local-Qwen connection ID,
provider, default model, normalized LM Studio base URL, and the model returned
by that endpoint's `/models` catalog. The chat handler then locks the request to
that connection and disables affinity, account rotation, and emergency
fallback. `suite-default`, `combo`, aliases, and names ending in `:free` do not
prove zero monetary cost and are rejected for inference. In compare mode, every
target completes this preflight before either run starts.

## Scoring Rubrics

Implemented in `evaluateCase()` (evalRunner.ts):

| Strategy   | Pass when…                                                           |
| ---------- | -------------------------------------------------------------------- |
| `exact`    | `actualOutput === expected.value`                                    |
| `contains` | `actualOutput.toLowerCase().includes(expected.value.toLowerCase())`  |
| `regex`    | `new RegExp(expected.value).test(actualOutput)` is truthy            |
| `custom`   | `expected.fn(actualOutput, evalCase)` returns truthy (built-in only) |

**Note:** Custom-function scoring is reserved for code-defined (built-in)
suites because functions cannot be serialized through the API. The
`evalCaseBuilderSchema` only accepts `contains | exact | regex` for
user-created suites.

There is no LLM-as-judge or embedding-based similarity scorer today — it would
be a clean extension point in `evaluateCase()`.

## Database Schema

Three tables (migrations `030_create_eval_runs.sql` and
`031_create_eval_suites.sql`):

| Table         | Purpose                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `eval_suites` | Custom suite metadata (`id`, `name`, `description`)                                                                          |
| `eval_cases`  | Cases per suite — `input_json`, `expected_*`, `tags_json`                                                                    |
| `eval_runs`   | Historical runs — `pass_rate`, `total`, `passed`, `failed`, `avg_latency_ms`, `summary_json`, `results_json`, `outputs_json` |

Built-in suites are **not** stored in the DB. They live in memory and are
re-registered every time `evalRunner.ts` is imported.

## REST API

All endpoints require management auth (`requireManagementAuth`) — they are not
part of the public proxy surface.

| Endpoint                      | Method   | Description                                                   |
| ----------------------------- | -------- | ------------------------------------------------------------- |
| `/api/evals`                  | `GET`    | List suites + recent runs + scorecard + targets + keys        |
| `/api/evals`                  | `POST`   | Run a suite (single or compare) — schema `evalRunSuiteSchema` |
| `/api/evals/{suiteId}`        | `GET`    | Fetch one suite (built-in or custom)                          |
| `/api/evals/suites`           | `POST`   | Create a custom suite — schema `evalSuiteSaveSchema`          |
| `/api/evals/suites/{suiteId}` | `GET`    | Fetch a custom suite                                          |
| `/api/evals/suites/{suiteId}` | `PUT`    | Replace a custom suite (cases get re-inserted)                |
| `/api/evals/suites/{suiteId}` | `DELETE` | Delete a custom suite and its cases                           |

### Running a suite

```bash
curl -X POST http://localhost:20128/api/evals \
  -H "Cookie: auth_token=..." \
  -H "Content-Type: application/json" \
  -d '{
    "suiteId": "golden-set",
    "target": { "type": "model", "id": "openai/qwen/qwen3.5-9b" },
    "apiKeyId": "optional-api-key-uuid"
  }'
```

Optional fields:

- `outputs` — `Record<caseId, string>` of pre-computed outputs. When provided,
  the API **skips dispatch**, requires an exact one-to-one match with the selected
  suite cases, scores the supplied outputs, and persists the run in `eval_runs`
  (useful for offline evaluation).
- `compareTarget` — second target to run in parallel; both runs share a
  generated `runGroupId` for head-to-head viewing.
- `apiKeyId` — internal API key used to authenticate the dispatched
  `/v1/chat/completions` calls. Required when `REQUIRE_API_KEY` is enabled.

### Creating a custom suite

```bash
curl -X POST http://localhost:20128/api/evals/suites \
  -H "Cookie: auth_token=..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Production smoke",
    "description": "Quick sanity check before deploy",
    "cases": [
      {
        "name": "JSON shape",
        "model": "gpt-4o",
        "input": { "messages": [{ "role": "user", "content": "Reply with {\"ok\": true}" }] },
        "expected": { "strategy": "regex", "value": "\"ok\"\\s*:\\s*true" }
      }
    ]
  }'
```

## Dispatch Pipeline

`runEvalSuiteAgainstTarget()` (`src/lib/evals/runtime.ts`):

1. Resolves the suite (built-in or custom).
2. For each case, builds a `Request` to `/v1/chat/completions` with the case's
   `messages`, the resolved `model`, `stream: false`, and `max_tokens: 512`
   (or the case override).
3. Calls the chat handler directly (in-process — no extra HTTP hop).
4. Captures latency and extracts text from either `choices[0].message.content`
   or the Responses-API `output[]` payload.
5. Scores all outputs via `runSuite()`, then persists via `saveEvalRun()`.

For pre-computed `outputs`, `POST /api/evals` validates the selected case IDs,
scores the supplied values without entering the inference runtime, and persists
the result through the same `saveEvalRun()` storage path.

Cases run **sequentially**. There is no concurrency flag today.

### Hermes deterministic offline suites

The `provider_retry`, `memory`, and `browser_tool` built-ins accept only
externally computed outputs. Runtime inference rejects suites tagged
`offline-only` before target preflight or dispatch. Their case IDs and exact
pytest node IDs share one manifest at
`src/lib/evals/evalRunner/hermesOfflineSuites.json`.

Run the bridge from the OmniRoute repository:

```bash
node scripts/evals/run-hermes-offline.mjs \
  --hermes-root /home/louis/.hermes/hermes-agent
```

The default is a dry run: it runs the three deterministic pytest files and
prints suite totals without contacting OmniRoute. Add `--submit` to send one
management-authenticated `{ suiteId, outputs }` request per suite through the
supported `/api/evals` ingestion path. The bridge never writes SQLite directly,
and submitted results use the existing `eval_runs` storage.

## Dashboard

The UI lives at `Dashboard → Usage → Evals`
(`src/app/(dashboard)/dashboard/usage/components/EvalsTab.tsx`). From there you
can:

- Browse built-in and custom suites with case-by-case preview.
- Create/edit/delete custom suites with the case builder.
- Run inference through the advertised verified Local-Qwen target, optionally
  with an API key, or ingest externally computed outputs.
- Inspect run history, per-case pass/fail, latency, and captured outputs.
- See the rolling scorecard aggregated across the latest run per
  `(suite, target)` scope.

## Relationship with the Auto-Assessment RFC

A separate, narrower assessment subsystem lives at `src/domain/assessment/`
(see also [AUTO-COMBO.md](../routing/AUTO-COMBO.md) for the live scoring engine).
That subsystem targets the Auto Combo engine — automatically scoring providers and
models so combos can self-heal when upstreams fail. It uses its own runner,
its own categorizer, and its own scoring logic.

The Evals framework documented here is the **broader, general-purpose
testing surface**. Prefer it for arbitrary regression suites, A/B comparisons,
and per-release smoke tests. Use the Auto-Assessment subsystem when you need
real-time provider health to influence routing decisions.

## CI Integration

There is no dedicated `eval:ci` npm script today. Two paths if you want to
gate releases on eval results:

- **HTTP path**: stand up the server, hit `POST /api/evals` with a known
  `suiteId` + `target`, and assert `runs[].summary.passRate >= N` in the
  response.
- **In-process path**: import `runEvalSuiteAgainstTarget()` from
  `@/lib/evals/runtime` from a script, run against a test DB, and check the
  returned `PersistedEvalRun.summary`.

Tests covering the route and history live at
`tests/unit/evals-route.test.ts` and `tests/unit/evals-history.test.ts`.

## Extension Points

Common changes and where to make them:

- **New scoring strategy** — extend the `switch (evalCase.expected.strategy)`
  block in `evaluateCase()` (`evalRunner.ts`) and widen `EvalCaseStrategy` in
  `src/lib/db/evals.ts` plus `evalCaseBuilderSchema` in `schemas.ts`.
- **New built-in suite** — define a suite object and include it in
  `builtInSuites` in `evalRunner/builtinSuites.ts`. It will be auto-discovered
  by `listSuites()`.
- **Run with concurrency** — change the sequential `for` loop in
  `runEvalSuiteAgainstTarget()` to a bounded `Promise.all` (no concurrency
  control exists today).
- **Stream/tool-call cases** — currently the runner forces `stream: false`.
  Streaming or tool-aware evaluation would require changes in `runtime.ts`
  (capture and aggregate SSE chunks before scoring).

## See Also

- [USER_GUIDE.md](../guides/USER_GUIDE.md) — overall product walkthrough
- [ARCHITECTURE.md](../architecture/ARCHITECTURE.md) — request pipeline reference
- [AUTO-COMBO.md](../routing/AUTO-COMBO.md) — Auto Combo scoring engine (live runtime)
- Source: `src/lib/evals/`, `src/lib/db/evals.ts`, `src/app/api/evals/`
- UI: `src/app/(dashboard)/dashboard/usage/components/EvalsTab.tsx`
