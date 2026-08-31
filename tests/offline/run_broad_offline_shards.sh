#!/usr/bin/env bash
# tests/offline/run_broad_offline_shards.sh
# Fail-closed, network-blocked harness for offline test shards.
#
# Isolation strategy: run every test inside an unprivileged user+network
# namespace (unshare -Urn), which gives the child process a REAL dead
# network stack — no outbound DNS/TCP/provider traffic can possibly leak.
# Provider credentials are ALSO neutralized (defense in depth). A mandatory
# canary proves the sandbox is live before any shard runs; if the canary
# succeeds, the harness aborts. Nothing in this script contacts production,
# model, eval, or provider endpoints.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HARNESS_DIR="$(mktemp -d)"
trap 'rm -rf "$HARNESS_DIR"' EXIT
RUNTIME_PATH=${PATH:?PATH is required for the offline runtime}
RUNTIME_HOME=${HOME:?HOME is required for the offline runtime}

echo "=== OFFLINE BROAD SHARD HARNESS ==="
echo "Repo: $REPO_ROOT"
echo "Harness dir: $HARNESS_DIR"

# ---------------------------------------------------------------
# Step 0: Acquire a real outbound-network sandbox
# ---------------------------------------------------------------
if ! unshare -Urn true 2>/dev/null; then
  echo "ABORT: unshare -Urn (user+network namespace) unavailable on this host."
  echo "Cannot guarantee offline isolation. No broad shards will run."
  exit 1
fi
echo "Offline sandbox: user+network namespace (unshare -Urn) available."

# ---------------------------------------------------------------
# Helper: run a command inside the dead-network sandbox
# ---------------------------------------------------------------
# Only net/user namespaces are isolated; the repo.hppmount namespace is shared
# so tests can read the tree. Args are %q-quoted so arbitrary args survive.
run_in_ns() {
  local cmd=""
  local a
  for a in "$@"; do cmd+="$(printf '%q ' "$a")"; done
  ( unshare -Urn env -i \
      PATH="$RUNTIME_PATH" \
      HOME="$RUNTIME_HOME" \
      DISABLE_SQLITE_AUTO_BACKUP=true \
      OFFLINE_HARNESS=1 \
      NODE_ENV=test \
      bash -c "$cmd" )
}

# ---------------------------------------------------------------
# Step 2: Mandatory network canary — MUST FAIL inside sandbox
# ---------------------------------------------------------------
echo ""
echo "--- Running outbound network canary (inside dead-network sandbox) ---"
CANARY_FAILED=false

# Canary 1: TCP to a literal external IP must fail.
if run_in_ns timeout 3 bash -c 'echo >/dev/tcp/1.1.1.1/443' 2>/dev/null; then
  echo "CANARY FAILURE: literal external TCP succeeded — network leaked!"
  CANARY_FAILED=true
else
  echo "CANARY literal-external-ip: BLOCKED"
fi

# Canary 2: external DNS resolution must fail.
if run_in_ns timeout 3 getent hosts example.com >/dev/null 2>&1; then
  echo "CANARY FAILURE: external DNS resolution succeeded — network leaked!"
  CANARY_FAILED=true
else
  echo "CANARY external-dns: BLOCKED"
fi

# Canary 3: HTTPS to a provider hostname must fail.
if run_in_ns curl -s --max-time 3 https://api.openai.com/v1/models >/dev/null 2>&1; then
  echo "CANARY FAILURE: HTTPS request to api.openai.com succeeded — network leaked!"
  CANARY_FAILED=true
else
  echo "CANARY provider-https: BLOCKED"
fi

# Canary 4: an independent UDP path must fail.
if run_in_ns timeout 3 bash -c 'echo probe >/dev/udp/8.8.8.8/53' 2>/dev/null; then
  echo "CANARY FAILURE: independent external UDP succeeded — network leaked!"
  CANARY_FAILED=true
else
  echo "CANARY independent-udp: BLOCKED"
fi

# Canary 5: provider/API credential names with nonempty values must be absent.
if run_in_ns sh -c 'env | grep -Eiq "(OPENAI|ANTHROPIC|GEMINI|GOOGLE|DEEPSEEK|GROQ|XAI|MISTRAL|OPENROUTER|TOGETHER|AZURE|AWS|BEDROCK|COHERE).*(KEY|TOKEN|SECRET|CREDENTIAL)="'; then
  echo "CANARY FAILURE: provider credential variable exists in child environment!"
  CANARY_FAILED=true
else
  echo "CANARY provider-credentials: ABSENT"
fi

# Canary 6: a normal local command must work in the same isolation.
if run_in_ns sh -c 'test "$OFFLINE_HARNESS" = 1 && printf local-ok' >/dev/null; then
  echo "CANARY local-command: PASS"
else
  echo "CANARY FAILURE: normal local command failed inside isolation!"
  CANARY_FAILED=true
fi

if [ "$CANARY_FAILED" = "false" ]; then
  echo "All canary checks passed — outbound network is blocked (dead sandbox confirmed.)"
else
  echo ""
  echo "ABORT: Network canary succeeded. Cannot guarantee offline isolation."
  echo "No broad shards will run. Fix network isolation first."
  exit 1
fi

if [ "${OFFLINE_CANARY_ONLY:-0}" = "1" ]; then
  echo "CANARY-ONLY COMPLETE — no shards started"
  exit 0
fi

# ---------------------------------------------------------------
# Step 3: Run focused offline tests (SSH retry, idempotency)
# ---------------------------------------------------------------
echo ""
echo "--- Running focused offline tests ---"

# SSH retry tests (Python, inside sandbox)
echo "Running SSH retry tests..."
if run_in_ns python3 "$REPO_ROOT/tests/offline/test_ssh_retry.py"; then
  echo "SSH retry tests: PASS"
else
  echo "SSH retry tests: FAIL"
  exit 1
fi

# ---------------------------------------------------------------
# Step 4: Determine which broad shards to run
# ---------------------------------------------------------------
echo ""
echo "--- Identifying deterministic broad shards ---"

# Collect test files that are deterministic:(no network, no provider, no eval traffic)
# We scan tests/unit/ for files that do NOT import provider/network modules.

DETERMINISTIC_SHARDS=()

# Check each test file for network/provider imports (simple grep,
while IFS= read -r testfile; do
  # Skip files that import network/eval/provider modules
  if grep -qlE '(fetch\(|axios|http\.request|net\.connect|dns\.resolve|evalRunner|runEvalSuite|providerApi|createCompletion|global\.fetch|process\.env\.[A-Z].*KEY)' "$testfile" 2>/dev/null; then
    continue
  fi
  DETERMINISTIC_SHARDS+=("$testfile")
done < <(find "$REPO_ROOT/tests/unit" -name '*.test.ts' -o -name '*.test.mjs' 2>/dev/null | sort)

# Add the offline Python tests
for offline_test in "$REPO_ROOT"/tests/offline/test_*.py; do
  [ -f "$offline_test" ] && DETERMINISTIC_SHARDS+=("$offline_test")
done

echo "Found ${#DETERMINISTIC_SHARDS[@]} deterministic shards"

# ---------------------------------------------------------------
# Step 5: Run shards under network-blocked (namespace) environment
# ---------------------------------------------------------------
echo ""
echo "--- Running broad offline shards (inside dead-network sandbox) ---"

PASSED=0
FAILED=0
SKIPPED=0
TOTAL=${#DETERMINISTIC_SHARDS[@]}

for shard in "${DETERMINISTIC_SHARDS[@]}"; do
  shard_name="$(basename "$shard")"
  printf "   [%d/%d] %-55s " $((PASSED + FAILED + SKIPPED + 1)) "$TOTAL" "$shard_name"

  if [[ "$shard" == *.py ]]; then
    # Python test
    if run_in_ns timeout 30 python3 "$shard" >/dev/null 2>&1; then
      echo "PASS"
      PASSED=$((PASSED + 1))
    else
      echo "FAIL"
      FAILED=$((FAILED + 1))
    fi
  elif [[ "$shard" == *.ts || "$shard" == *.mjs ]]; then
    # Node.js test — run in isolation with network-blocked sandbox
    # Node must be launched INSIDE the namespace so none of its I/O leaks.

    if run_in_ns timeout 60 \
        "$HOME/.hermes/node/bin/node" --import tsx/esm --import "$REPO_ROOT/open-sse/utils/setupPolyfill.ts" --test "$shard" \
        >/dev/null 2>&1; then
      echo "PASS"
      PASSED=$((PASSED + 1))
    else
      echo "FAIL"
      FAILED=$((FAILED + 1))
    fi
  else
    echo "SKIP"
    SKIPPED=$((SKIPPED + 1))
  fi
done

# ---------------------------------------------------------------
# Step 6: Summary
# ---------------------------------------------------------------
echo ""
echo "=== BROAD SHARD RESULTS ==="
echo "Total:   $TOTAL"
echo "Passed:  $PASSED"
echo "Failed:  $FAILED"
echo "Skipped: $SKIPPED"

if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo "RESULT: FAIL — $FAILED shard(s) failed"
  exit 1
else
  echo ""
  echo "RESULT: PASS — all $PASSED deterministic shards passed"
  exit 0
fi