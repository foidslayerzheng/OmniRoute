#!/usr/bin/env bash
# Fail-closed, credential-neutral, network-blocked offline shard harness.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CALLER_HOME=${HOME:-}
RUNTIME_PATH=${PATH:?PATH is required for the offline runtime}
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ] && [ -n "$CALLER_HOME" ] && [ -x "$CALLER_HOME/.hermes/node/bin/node" ]; then
  NODE_BIN="$CALLER_HOME/.hermes/node/bin/node"
fi
if [ -n "$NODE_BIN" ] && [[ "$NODE_BIN" != /* ]]; then
  echo "PREFLIGHT FAILURE: resolved node runtime is not an absolute path."
  exit 1
fi
TSX_LOADER="$REPO_ROOT/node_modules/tsx/dist/esm/index.mjs"
if [ ! -f "$TSX_LOADER" ]; then
  echo "PREFLIGHT FAILURE: repository tsx loader is missing: $TSX_LOADER"
  exit 1
fi
HARNESS_DIR="$(mktemp -d -t omniroute-offline-harness-XXXXXX)"
FRESH_HOME="$(mktemp -d "$HARNESS_DIR/offline-home-XXXXXX")"
RESULTS_DIR=${OFFLINE_RESULTS_DIR:-"$(mktemp -d -t omniroute-offline-results-XXXXXX)"}
MANIFEST="$RESULTS_DIR/manifest.jsonl"
trap 'rm -rf "$HARNESS_DIR"' EXIT
if [ -L "$RESULTS_DIR" ]; then
  echo "PREFLIGHT FAILURE: results directory must not be a symlink: $RESULTS_DIR"
  exit 1
fi
mkdir -p "$RESULTS_DIR" "$FRESH_HOME/.cache" "$FRESH_HOME/.config" "$FRESH_HOME/.local/share" "$FRESH_HOME/tmp"
if [ -e "$MANIFEST" ] || [ -L "$MANIFEST" ]; then
  echo "PREFLIGHT FAILURE: manifest path already exists: $MANIFEST"
  exit 1
fi
: >"$MANIFEST"

SHARD_TIMEOUT=${OFFLINE_SHARD_TIMEOUT_SECONDS:-60}
if [[ ! "$SHARD_TIMEOUT" =~ ^[1-9][0-9]*$ ]]; then
  echo "PREFLIGHT FAILURE: OFFLINE_SHARD_TIMEOUT_SECONDS must be a positive integer."
  exit 1
fi

printf '%s\n' "=== OFFLINE BROAD SHARD HARNESS ===" "Repo: $REPO_ROOT" \
  "Fresh HOME: $FRESH_HOME" "Results: $RESULTS_DIR"

preflight_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "PREFLIGHT FAILURE: required tool '$1' is missing or not executable."
    exit 1
  fi
}

# Every command used by isolation and canaries must exist before a failed probe
# can be interpreted as genuine network denial.
for tool in unshare env bash sh timeout getent curl grep mktemp date python3 find sort tr; do
  preflight_tool "$tool"
done
if [ -n "${OFFLINE_PREFLIGHT_EXTRA_TOOL:-}" ]; then
  preflight_tool "$OFFLINE_PREFLIGHT_EXTRA_TOOL"
fi
if ! unshare -Urn true 2>/dev/null; then
  echo "PREFLIGHT FAILURE: unshare -Urn is unavailable or broken; no shards started."
  exit 1
fi
if ! timeout --version >/dev/null 2>&1 || ! curl --version >/dev/null 2>&1; then
  echo "PREFLIGHT FAILURE: timeout or curl exists but is not functional."
  exit 1
fi
echo "Offline sandbox: user+network namespace (unshare -Urn) available."

run_in_ns() {
  local cmd="" a
  for a in "$@"; do cmd+="$(printf '%q ' "$a")"; done
  unshare -Urn env -i \
    PATH="$RUNTIME_PATH" HOME="$FRESH_HOME" TMPDIR="$FRESH_HOME/tmp" \
    XDG_CACHE_HOME="$FRESH_HOME/.cache" XDG_CONFIG_HOME="$FRESH_HOME/.config" \
    XDG_DATA_HOME="$FRESH_HOME/.local/share" \
    DISABLE_SQLITE_AUTO_BACKUP=true OFFLINE_HARNESS=1 NODE_ENV=test \
    bash -c "cd $(printf '%q' "$REPO_ROOT") && exec $cmd"
}

probe_must_be_denied() {
  local label=$1; shift
  local rc=0
  set +e
  run_in_ns "$@" >/dev/null 2>&1
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "CANARY FAILURE: $label succeeded — network leaked!"
    return 1
  fi
  if [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ]; then
    echo "CANARY TOOLING FAILURE: $label could not execute (exit $rc)."
    return 2
  fi
  echo "CANARY $label: BLOCKED"
}

echo "--- Running outbound network canary (inside dead-network sandbox) ---"
CANARY_FAILED=false
probe_must_be_denied literal-external-ip timeout 3 bash -c 'echo >/dev/tcp/1.1.1.1/443' || CANARY_FAILED=true
probe_must_be_denied external-dns timeout 3 getent hosts example.com || CANARY_FAILED=true
probe_must_be_denied provider-https timeout 5 curl -fsS --max-time 3 https://api.openai.com/v1/models || CANARY_FAILED=true
probe_must_be_denied independent-udp timeout 3 bash -c 'echo probe >/dev/udp/8.8.8.8/53' || CANARY_FAILED=true
if run_in_ns sh -c 'env | grep -Eiq "(OPENAI|ANTHROPIC|GEMINI|GOOGLE|DEEPSEEK|GROQ|XAI|MISTRAL|OPENROUTER|TOGETHER|AZURE|AWS|BEDROCK|COHERE).*(KEY|TOKEN|SECRET|CREDENTIAL)="'; then
  echo "CANARY FAILURE: provider credential variable exists in child environment!"
  CANARY_FAILED=true
else
  echo "CANARY provider-credentials: ABSENT"
fi
if run_in_ns sh -c 'test "$OFFLINE_HARNESS" = 1 && test "$HOME" = "$XDG_CONFIG_HOME/../.."' >/dev/null 2>&1; then
  # The exact relationship is not portable; this branch is intentionally unused.
  :
fi
if run_in_ns sh -c 'test "$OFFLINE_HARNESS" = 1 && test -d "$HOME" && printf local-ok' >/dev/null; then
  echo "CANARY local-command: PASS"
else
  echo "CANARY FAILURE: normal local command failed inside isolation!"
  CANARY_FAILED=true
fi
if [ "$CANARY_FAILED" != false ]; then
  echo "ABORT: canary/preflight did not prove safe isolation. No shards started."
  exit 1
fi
if [ "${OFFLINE_CANARY_ONLY:-0}" = 1 ]; then
  echo "CANARY-ONLY COMPLETE — no shards started"
  exit 0
fi

if [ "${OFFLINE_SKIP_FOCUSED:-0}" != 1 ]; then
  echo "--- Running focused offline tests ---"
  run_in_ns timeout "$SHARD_TIMEOUT" python3 "$REPO_ROOT/tests/offline/test_ssh_retry.py"
fi

validate_relative_path() {
  local rel=$1
  if [ -z "$rel" ] || [[ "$rel" = /* ]] || [[ "/$rel/" = *"/../"* ]] || [[ "$rel" != */* ]]; then
    echo "ABORT: shard must be an exact repo-relative path (not absolute, parent-relative, or basename): $rel"
    exit 1
  fi
  case "$rel" in
    tests/unit/*.test.ts|tests/unit/*.test.mjs|tests/offline/test_*.py|tests/offline/.harness-fixture-*.py) ;;
    *) echo "ABORT: shard is outside allowed test paths or has unsupported type: $rel"; exit 1 ;;
  esac
  if [ ! -f "$REPO_ROOT/$rel" ]; then
    echo "ABORT: exact repo-relative shard does not exist: $rel"
    exit 1
  fi
  if [ -L "$REPO_ROOT/$rel" ]; then
    echo "ABORT: shard must not be a symlink: $rel"
    exit 1
  fi
}

SHARDS=()
if [ -n "${OFFLINE_SHARD_LIST_FILE:-}" ]; then
  while IFS= read -r rel || [ -n "$rel" ]; do
    [ -z "$rel" ] && continue
    validate_relative_path "$rel"
    SHARDS+=("$rel")
  done <"$OFFLINE_SHARD_LIST_FILE"
else
  while IFS= read -r rel; do SHARDS+=("$rel"); done < <(
    cd "$REPO_ROOT"
    find tests/unit -type f \( -name '*.test.ts' -o -name '*.test.mjs' \) -printf '%p\n' | sort
    find tests/offline -maxdepth 1 -type f -name 'test_*.py' -printf '%p\n' | sort
  )
fi

if [ "${#SHARDS[@]}" -eq 0 ]; then
  echo "ABORT: zero shards selected; refusing to report success."
  exit 1
fi

if [ "${#SHARDS[@]}" -gt 0 ] && [ -z "$NODE_BIN" ]; then
  for rel in "${SHARDS[@]}"; do
    case "$rel" in *.ts|*.mjs) echo "PREFLIGHT FAILURE: node is required for selected shards."; exit 1;; esac
  done
fi

echo "--- Running ${#SHARDS[@]} exact offline shards ---"
PASSED=0 FAILED=0 SKIPPED=0 INDEX=0
for rel in "${SHARDS[@]}"; do
  INDEX=$((INDEX + 1))
  safe_name=$(printf '%s' "$rel" | tr '/ ' '__' | tr -cd 'A-Za-z0-9_.-')
  output="$RESULTS_DIR/$(printf '%04d' "$INDEX")-$safe_name.log"
  if [[ "$rel" == *.py ]]; then
    count_report="$RESULTS_DIR/$(printf '%04d' "$INDEX")-$safe_name.counts.json"
    command=(python3 "$REPO_ROOT/tests/offline/run_python_unittest_shard.py" "$count_report" "$REPO_ROOT/$rel")
  else
    count_report=""
    command=("$NODE_BIN" --import "$TSX_LOADER" --import "$REPO_ROOT/open-sse/utils/setupPolyfill.ts" --test "$REPO_ROOT/$rel")
  fi
  printf -v command_text '%q ' "${command[@]}"
  started_ns=$(python3 -c 'import time; print(time.monotonic_ns())')
  set +e
  run_in_ns timeout "$SHARD_TIMEOUT" "${command[@]}" >"$output" 2>&1
  exit_status=$?
  set -e
  ended_ns=$(python3 -c 'import time; print(time.monotonic_ns())')
  duration_ms=$(((ended_ns - started_ns) / 1000000))

  counts=$(python3 - "$output" "$rel" "$count_report" <<'PY'
import json, re, sys
text=open(sys.argv[1], errors='replace').read()
if sys.argv[2].endswith('.py'):
    try:
        with open(sys.argv[3], encoding='utf-8') as f: report=json.load(f)
        total=int(report['total_tests']); executed=int(report['executed_tests']); skipped=int(report['skipped_tests'])
        if min(total, executed, skipped) < 0 or executed + skipped != total: raise ValueError
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        total=executed=skipped=0
else:
    def last(label):
        found=re.findall(rf'(?:^|\n)(?:ℹ|#)\s*{label}\s+(\d+)', text)
        return int(found[-1]) if found else 0
    total=last('tests'); skipped=last('skipped')
    executed=last('pass')+last('fail')
print(total, executed, skipped)
PY
)
  read -r total_tests executed_tests skipped_tests <<<"$counts"
  status=PASS
  if [ "$exit_status" -ne 0 ]; then status=FAIL_EXIT
  elif [ "$total_tests" -eq 0 ]; then status=FAIL_ZERO_TESTS
  elif [ "$executed_tests" -eq 0 ] && [ "$skipped_tests" -gt 0 ]; then status=FAIL_ONLY_SKIPPED
  fi
  if [ "$status" = PASS ]; then PASSED=$((PASSED + 1)); else FAILED=$((FAILED + 1)); fi

  python3 - "$MANIFEST" "$rel" "$command_text" "$exit_status" "$duration_ms" "$total_tests" "$executed_tests" "$skipped_tests" "$status" "$output" <<'PY'
import json,sys
keys=('path','command','exit_status','duration_ms','total_tests','executed_tests','skipped_tests','status','output_file')
vals=sys.argv[2:]
for i in (2,3,4,5,6): vals[i]=int(vals[i])
with open(sys.argv[1],'a') as f: f.write(json.dumps(dict(zip(keys,vals)),sort_keys=True)+'\n')
PY
  printf '[%d/%d] %s %s (exit=%d tests=%d executed=%d skipped=%d duration_ms=%d)\n' \
    "$INDEX" "${#SHARDS[@]}" "$rel" "$status" "$exit_status" "$total_tests" "$executed_tests" "$skipped_tests" "$duration_ms"
done

echo "=== BROAD SHARD RESULTS ==="
echo "Total: ${#SHARDS[@]}"
echo "Passed: $PASSED"
echo "Failed: $FAILED"
echo "Skipped shards: $SKIPPED"
echo "Manifest: $MANIFEST"
if [ "$FAILED" -gt 0 ]; then exit 1; fi
exit 0
