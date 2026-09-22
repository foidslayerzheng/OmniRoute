# Codex–Hermes Supervisor V1

This generic local supervisor dispatches one bounded Hermes task, validates its structured
evidence, and either completes, corrects, blocks, or waits for Louis's approval. It does not
enable a production transport by default.

Initialize a mission from a JSON configuration containing the fields defined by
`createInitialState()`:

```bash
npm run supervisor -- init --state-root /tmp/supervisor-state --mission example --config mission.json
```

Inspect a prompt and simulated decision without invoking Hermes:

```bash
npm run supervisor -- run --state-root /tmp/supervisor-state --mission example --dry-run
```

Run the deterministic local fake adapter:

```bash
npm run supervisor -- run --state-root /tmp/supervisor-state --mission example --adapter fake --response-file result.json
```

Run an explicitly configured local Hermes CLI:

```bash
npm run supervisor -- run --state-root /tmp/supervisor-state --mission example --adapter hermes-local --executable /home/louis/.local/bin/hermes
```

The `hermes-local` adapter invokes the documented non-interactive `hermes chat` interface
without a shell. It includes the stable task ID and unique attempt/correlation ID in Hermes's
source tag, bounds turns, runtime, and output, and deduplicates an attempt within the adapter
process. It implements health, status, wait, and cancellation methods. Crash recovery remains
fail-closed: Supervisor V1 verifies adapter status and never blindly replays an uncertain task.
The executable is never auto-discovered or selected.

Both real adapters are opt-in and shell-free. Supply the executable and each fixed argument
explicitly with `--executable` and repeated `--arg` options. No SSH, Telegram, n8n, paid model,
or production adapter is selected automatically.

Mission directories contain `state.json`, `audit.jsonl`, and an exclusive `mission.lock` while
a supervisor controls the mission. Keep configurations and evidence free of secrets even
though state and audit are recursively redacted.

## V2 parallel DAG execution

V2 extends the same supervisor with persisted lanes, dependency scheduling, resource locks,
read-only verifiers, and immutable evidence caching. Initialize and inspect a DAG mission with:

```bash
npm run supervisor -- dag-init --state-root /tmp/supervisor-state --mission example-dag --config mission-dag.json
npm run supervisor -- dag-status --state-root /tmp/supervisor-state --mission example-dag
```

Preview dispatch without invoking an adapter:

```bash
npm run supervisor -- dag-run --state-root /tmp/supervisor-state --mission example-dag --dry-run
```

Run with an explicit local Hermes adapter and concurrency limit:

```bash
npm run supervisor -- dag-run --state-root /tmp/supervisor-state --mission example-dag --adapter hermes-local --executable /home/louis/.local/bin/hermes --arg --toolsets --arg terminal --max-concurrency 3
```

## Empirical routing (opt-in)

Pass `--routing-config /absolute/path/routing.json` to `dag-run` or `dag-resume`. The config names
currently eligible executor descriptors, an explicit conservative fallback, the minimum sample
threshold (default `5`), and exploration interval. Observations are appended beneath
`<state-root>/empirical-routing/`; production OmniRoute databases are never written.

Jev modes are `null`, `fake`, `command`, and `typesafe`. `null` is the safe default. `command`
requires an explicit executable and never discovers or activates Hermes plugins. The TypeSafe
transport remains off unless its config sets `mode` to `typesafe` and `enabled` to `true`; it
reads only `TYPESAFE_API_KEY` and also requires positive `max_calls_per_mission` and
`spend_ceiling` values. Its bounded HTTPS requests use `jev-latest` at the fixed System One
endpoint. Jev failures, timeouts, malformed output, exhausted usage guards, and low confidence
fall back to empirical routing. Jev cannot approve work, bypass locks or acceptance, change
attempt limits, or mark tasks complete.

No adapter is selected implicitly. Write locks for service, database, and deployment resources
remain approval-gated. Resource locks and `dag-state.json` are persisted beneath the configured
state root; uncertain mutating lanes are verified and never blindly replayed.
