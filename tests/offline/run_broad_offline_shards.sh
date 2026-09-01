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
if ! python3 - "$RESULTS_DIR" <<'PY'
import os, pathlib, sys
p = pathlib.Path(os.path.abspath(sys.argv[1]))
while True:
    if (p.exists() or p.is_symlink()) and p.is_symlink(): raise SystemExit(1)
    if p.parent == p: break
    p = p.parent
PY
then
  echo "PREFLIGHT FAILURE: results directory path must not contain symlinks: $RESULTS_DIR"
  exit 1
fi
mkdir -p "$RESULTS_DIR" "$FRESH_HOME/.cache" "$FRESH_HOME/.config" "$FRESH_HOME/.local/share" "$FRESH_HOME/tmp"
if [ -e "$MANIFEST" ] || [ -L "$MANIFEST" ]; then
  echo "PREFLIGHT FAILURE: manifest path already exists: $MANIFEST"
  exit 1
fi
: >"$MANIFEST"

SHARD_TIMEOUT=${OFFLINE_SHARD_TIMEOUT_SECONDS:-60}
if [[ ! "$SHARD_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || (( SHARD_TIMEOUT > 600 )); then
  echo "PREFLIGHT FAILURE: OFFLINE_SHARD_TIMEOUT_SECONDS must be an integer from 1 through 600."
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
for tool in unshare env bash sh timeout getent curl grep mktemp date python3 find sort tr seq systemd-run systemctl; do
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
  canonical=$(realpath -e -- "$REPO_ROOT/$rel") || { echo "ABORT: cannot resolve shard inside repository: $rel"; exit 1; }
  lexical=$(python3 - "$REPO_ROOT/$rel" <<'PY'
import os, sys
print(os.path.abspath(sys.argv[1]))
PY
)
  case "$canonical" in "$REPO_ROOT"/*) ;; *) echo "ABORT: shard resolves outside repository: $rel"; exit 1;; esac
  if [ "$canonical" != "$lexical" ]; then
    echo "ABORT: shard path contains a symlink: $rel"
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
    if [ -e "$count_report" ] || [ -L "$count_report" ]; then echo "ABORT: count report path already exists: $count_report"; exit 1; fi
    exec {count_fd}>"$count_report"
    command=(python3 "$REPO_ROOT/tests/offline/run_python_unittest_shard.py" "$count_fd" "$REPO_ROOT/$rel")
  else
    count_report=""
    command=("$NODE_BIN" --import "$TSX_LOADER" --import "$REPO_ROOT/open-sse/utils/setupPolyfill.ts" --test "$REPO_ROOT/$rel")
  fi
  if [ -e "$output" ] || [ -L "$output" ]; then echo "ABORT: shard output path already exists: $output"; exit 1; fi
  printf -v command_text '%q ' "${command[@]}"
  scope_nonce=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
  scope_name="omniroute-mode-a-$scope_nonce-$INDEX"
  scope_unit="$scope_name.scope"
  reservation="$HARNESS_DIR/scope-reservations/$scope_unit.json"
  mkdir -m 700 -p "$HARNESS_DIR/scope-reservations"
  python3 - "$reservation" "$scope_nonce" "$scope_unit" "$rel" <<'PY'
import json, os, sys, time
path, nonce, unit, shard = sys.argv[1:]
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump({'nonce': nonce, 'unit': unit, 'shard': shard, 'created_monotonic_ns': time.monotonic_ns()}, f)
    f.flush(); os.fsync(f.fileno())
PY
  scope_created=false
  scope_control_group=""
  scope_invocation_id=""
  initial_identity_json=""
  terminal_identity_json=""
  final_identity_json=""
  initial_cgroup_events=""
  scope_stopped=false
  scope_empty=false
  observed_populated=false
  cleanup_proof_path=""
  cgroup_stat=""
  alive_snapshot="$HARNESS_DIR/scope-alive-$INDEX.show"
  terminal_snapshot_a="$HARNESS_DIR/scope-terminal-a-$INDEX.show"
  terminal_snapshot_b="$HARNESS_DIR/scope-terminal-b-$INDEX.show"
  terminal_state_proven=false
  cgroup_path_absent=false
  no_reuse_proven=false
  cleanup_error=""
  started_ns=$(python3 -c 'import time; print(time.monotonic_ns())')
  set +e
  scoped_cmd=""
  for a in timeout "$SHARD_TIMEOUT" "${command[@]}"; do scoped_cmd+="$(printf '%q ' "$a")"; done
  systemd-run --user --scope --quiet --unit="$scope_name" \
    --property=KillMode=control-group \
    unshare -Urn env -i \
      PATH="$RUNTIME_PATH" HOME="$FRESH_HOME" TMPDIR="$FRESH_HOME/tmp" \
      XDG_CACHE_HOME="$FRESH_HOME/.cache" XDG_CONFIG_HOME="$FRESH_HOME/.config" \
      XDG_DATA_HOME="$FRESH_HOME/.local/share" \
      DISABLE_SQLITE_AUTO_BACKUP=true OFFLINE_HARNESS=1 NODE_ENV=test \
      bash -c "sleep 0.05; cd $(printf '%q' "$REPO_ROOT") && exec $scoped_cmd" >"$output" 2>&1 &
  scope_runner_pid=$!
  for _ in $(seq 1 100); do
    if systemctl --user show "$scope_unit" -p Id -p LoadState -p ActiveState -p SubState -p ControlGroup -p InvocationID >"$alive_snapshot" 2>/dev/null; then
      scope_id=$(grep '^Id=' "$alive_snapshot" | cut -d= -f2-)
      load_state=$(grep '^LoadState=' "$alive_snapshot" | cut -d= -f2-)
      active_state=$(grep '^ActiveState=' "$alive_snapshot" | cut -d= -f2-)
      sub_state=$(grep '^SubState=' "$alive_snapshot" | cut -d= -f2-)
      scope_control_group=$(grep '^ControlGroup=' "$alive_snapshot" | cut -d= -f2-)
      scope_invocation_id=$(grep '^InvocationID=' "$alive_snapshot" | cut -d= -f2-)
      events_path="/sys/fs/cgroup$scope_control_group/cgroup.events"
      if [ "$scope_id" = "$scope_unit" ] && [ "$load_state" = loaded ] \
          && [ "$active_state" = active ] && [ "$sub_state" = running ] \
          && [[ "$scope_invocation_id" =~ ^[0-9a-fA-F]{32}$ ]] \
          && [ "$scope_invocation_id" != 00000000000000000000000000000000 ] \
          && python3 - "$scope_control_group" "$scope_unit" "$events_path" <<'PY'
import os, pathlib, sys
cg, unit, events = sys.argv[1:]
if not cg.startswith('/') or '..' in pathlib.PurePosixPath(cg).parts: raise SystemExit(1)
path='/sys/fs/cgroup'+cg
if os.path.realpath(path) != path or os.path.basename(path) != unit: raise SystemExit(1)
if not os.path.isfile(events): raise SystemExit(1)
PY
      then
        initial_cgroup_events=$(python3 - "$events_path" <<'PY'
import json, os, sys
values={k:int(v) for k,v in (line.split() for line in open(sys.argv[1]))}
if values.get('populated') != 1: raise SystemExit(1)
print(json.dumps(values, sort_keys=True, separators=(',', ':')))
PY
) || initial_cgroup_events=""
        cgroup_stat=$(python3 - "$events_path" <<'PY'
import json, os, sys
s=os.stat(sys.argv[1]); print(json.dumps({'st_dev':s.st_dev,'st_ino':s.st_ino}, separators=(',',':')))
PY
) || cgroup_stat=""
        if [ -n "$initial_cgroup_events" ] && [ -n "$cgroup_stat" ]; then
          initial_identity_json=$(python3 - "$alive_snapshot" <<'PY'
import json, sys
required=('Id','LoadState','ActiveState','SubState','ControlGroup','InvocationID')
d=dict(line.rstrip('\n').split('=',1) for line in open(sys.argv[1]) if '=' in line)
if any(k not in d for k in required): raise SystemExit(1)
print(json.dumps({k:d[k] for k in required}, sort_keys=True, separators=(',',':')))
PY
) || initial_identity_json=""
        fi
        if [ -n "$initial_cgroup_events" ] && [ -n "$cgroup_stat" ] && [ -n "$initial_identity_json" ]; then
          scope_created=true
          observed_populated=true
          break
        fi
      fi
    fi
    kill -0 "$scope_runner_pid" 2>/dev/null || break
    sleep 0.01
  done
  wait "$scope_runner_pid"
  exit_status=$?
  set -e
  ended_ns=$(python3 -c 'import time; print(time.monotonic_ns())')
  duration_ms=$(((ended_ns - started_ns) / 1000000))
  if [ "$scope_created" != true ]; then
    cleanup_error="scope creation or inspection failed"
  fi
  if [ "$scope_created" = true ]; then
    pre_stop="$HARNESS_DIR/scope-pre-stop-$INDEX.show"
    if systemctl --user show "$scope_unit" -p Id -p LoadState -p ActiveState -p SubState -p ControlGroup -p InvocationID >"$pre_stop" 2>/dev/null; then
      pre_active=$(grep '^ActiveState=' "$pre_stop" | cut -d= -f2-)
      pre_id=$(grep '^Id=' "$pre_stop" | cut -d= -f2-)
      pre_cg=$(grep '^ControlGroup=' "$pre_stop" | cut -d= -f2-)
      pre_inv=$(grep '^InvocationID=' "$pre_stop" | cut -d= -f2-)
      if [ "$pre_active" = active ]; then
        if [ "$pre_id" != "$scope_unit" ] || [ "$pre_cg" != "$scope_control_group" ] || [ "$pre_inv" != "$scope_invocation_id" ]; then
          cleanup_error="scope identity changed before stop"
        elif { [ "${OFFLINE_TEST_MODE_A_CLEANUP_FAULT:-}" != stop_failure ] || [[ "$rel" != tests/offline/.harness-fixture-cleanup-* ]]; } \
          && systemctl --user stop "$scope_unit" >/dev/null 2>&1; then scope_stopped=true
        else cleanup_error="scope stop failed"
        fi
      fi
    else cleanup_error="scope pre-stop inspection failed"
    fi
    if [ -z "$cleanup_error" ]; then
      for _ in $(seq 1 200); do
        if systemctl --user show "$scope_unit" -p Id -p LoadState -p ActiveState -p SubState -p ControlGroup -p InvocationID >"$terminal_snapshot_a" 2>/dev/null; then
          if [ "${OFFLINE_TEST_MODE_A_CLEANUP_FAULT:-}" = terminal_timeout ] && [[ "$rel" = tests/offline/.harness-fixture-cleanup-* ]]; then
            printf 'Id=%s\nLoadState=loaded\nActiveState=active\nSubState=running\nControlGroup=%s\nInvocationID=%s\n' \
              "$scope_unit" "$scope_control_group" "$scope_invocation_id" >"$terminal_snapshot_a"
          elif [ "${OFFLINE_TEST_MODE_A_CLEANUP_FAULT:-}" = terminal_identity_mismatch ] && [[ "$rel" = tests/offline/.harness-fixture-cleanup-* ]]; then
            printf 'Id=%s\nLoadState=loaded\nActiveState=inactive\nSubState=dead\nControlGroup=%s\nInvocationID=ffffffffffffffffffffffffffffffff\n' \
              "$scope_unit" "$scope_control_group" >"$terminal_snapshot_a"
          fi
          if ! python3 - "$terminal_snapshot_a" "$scope_unit" "$scope_invocation_id" "$scope_control_group" <<'PY'
import sys
d=dict(line.rstrip('\n').split('=',1) for line in open(sys.argv[1]) if '=' in line)
if d.get('Id')==sys.argv[2] and d.get('LoadState')=='loaded' and \
   (d.get('InvocationID')!=sys.argv[3] or d.get('ControlGroup')!=sys.argv[4]): raise SystemExit(0)
raise SystemExit(1)
PY
          then :
          else cleanup_error="terminal scope identity mismatch"; break
          fi
        fi
        if [ -z "$cleanup_error" ] && python3 - "$terminal_snapshot_a" "$scope_unit" "$scope_invocation_id" "$scope_control_group" <<'PY'
import sys
d=dict(line.rstrip('\n').split('=',1) for line in open(sys.argv[1]) if '=' in line)
same=(d.get('Id')==sys.argv[2] and d.get('InvocationID')==sys.argv[3] and d.get('ControlGroup')==sys.argv[4])
gone=(d.get('LoadState')=='not-found' and d.get('ActiveState')=='inactive' and d.get('SubState')=='dead' and not d.get('InvocationID') and not d.get('ControlGroup'))
dead=(d.get('LoadState')=='loaded' and d.get('ActiveState')=='inactive' and d.get('SubState')=='dead' and same)
raise SystemExit(0 if dead or gone else 1)
PY
        then
          terminal_identity_json=$(python3 - "$terminal_snapshot_a" <<'PY'
import json, sys
required=('Id','LoadState','ActiveState','SubState','ControlGroup','InvocationID')
d=dict(line.rstrip('\n').split('=',1) for line in open(sys.argv[1]) if '=' in line)
if any(k not in d for k in required): raise SystemExit(1)
print(json.dumps({k:d[k] for k in required}, sort_keys=True, separators=(',',':')))
PY
) || terminal_identity_json=""
          if [ -n "$terminal_identity_json" ]; then terminal_state_proven=true; break; fi
        fi
        sleep 0.01
      done
      if [ -n "$cleanup_error" ]; then :
      elif [ "$terminal_state_proven" != true ]; then cleanup_error="exact scope terminal-state observation timed out"
      else
        cgroup_probe_path="/sys/fs/cgroup$scope_control_group"
        if [ "${OFFLINE_TEST_MODE_A_CLEANUP_FAULT:-}" = cgroup_path_present ] && [[ "$rel" = tests/offline/.harness-fixture-cleanup-* ]]; then
          cgroup_probe_path=/sys/fs/cgroup
        fi
        if python3 - "$cgroup_probe_path" <<'PY'
import os, sys
try: os.lstat(sys.argv[1])
except FileNotFoundError: raise SystemExit(0)
except OSError: raise SystemExit(2)
raise SystemExit(1)
PY
        then cgroup_path_absent=true
        else cleanup_error="previously observed cgroup path did not disappear with ENOENT"
        fi
      fi
    fi
    if [ -z "$cleanup_error" ] && systemctl --user show "$scope_unit" -p Id -p LoadState -p ActiveState -p SubState -p ControlGroup -p InvocationID >"$terminal_snapshot_b" 2>/dev/null; then
      if [ "${OFFLINE_TEST_MODE_A_CLEANUP_FAULT:-}" = same_unit_reuse ] && [[ "$rel" = tests/offline/.harness-fixture-cleanup-* ]]; then
        printf 'Id=%s\nLoadState=loaded\nActiveState=active\nSubState=running\nControlGroup=/user.slice/reused/%s\nInvocationID=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n' \
          "$scope_unit" "$scope_unit" >"$terminal_snapshot_b"
      fi
      final_identity_json=$(python3 - "$terminal_snapshot_b" <<'PY'
import json, sys
required=('Id','LoadState','ActiveState','SubState','ControlGroup','InvocationID')
d=dict(line.rstrip('\n').split('=',1) for line in open(sys.argv[1]) if '=' in line)
if any(k not in d for k in required): raise SystemExit(1)
print(json.dumps({k:d[k] for k in required}, sort_keys=True, separators=(',',':')))
PY
) || final_identity_json=""
    fi
    if [ -z "$cleanup_error" ] && [ -n "$final_identity_json" ] \
      && python3 - "$terminal_snapshot_b" "$scope_unit" "$scope_invocation_id" "$scope_control_group" <<'PY'
import sys
d=dict(line.rstrip('\n').split('=',1) for line in open(sys.argv[1]) if '=' in line)
same=(d.get('Id')==sys.argv[2] and d.get('InvocationID')==sys.argv[3] and d.get('ControlGroup')==sys.argv[4])
gone=(d.get('LoadState')=='not-found' and d.get('ActiveState')=='inactive' and d.get('SubState')=='dead' and not d.get('InvocationID') and not d.get('ControlGroup'))
dead=(d.get('LoadState')=='loaded' and d.get('ActiveState')=='inactive' and d.get('SubState')=='dead' and same)
raise SystemExit(0 if dead or gone else 1)
PY
    then
      no_reuse_proven=true
      scope_empty=true
      cleanup_proof_path="systemd_scope_identity_terminal_and_cgroup_path_absent"
    elif [ -z "$cleanup_error" ]; then cleanup_error="same-unit reuse detected in final identity snapshot"
    fi
  fi
  if [ -n "$count_report" ]; then exec {count_fd}>&-; fi

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
    total=last('tests'); skipped=last('skipped')+last('todo')
    executed=last('pass')+last('fail')
print(total, executed, skipped)
PY
)
  read -r total_tests executed_tests skipped_tests <<<"$counts"
  status=PASS
  if [ "$scope_created" != true ] || [ "$scope_empty" != true ]; then status=FAIL_CLEANUP
  elif [ "$exit_status" -ne 0 ]; then status=FAIL_EXIT
  elif [ "$total_tests" -eq 0 ]; then status=FAIL_ZERO_TESTS
  elif [ "$exit_status" -eq 0 ] && [ "$total_tests" -gt 0 ] && [ "$executed_tests" -eq 0 ]; then status=FAIL_ONLY_SKIPPED
  fi
  if [ "$status" = PASS ]; then PASSED=$((PASSED + 1)); else FAILED=$((FAILED + 1)); fi

  python3 - "$MANIFEST" "$rel" "$command_text" "$exit_status" "$duration_ms" "$total_tests" "$executed_tests" "$skipped_tests" "$status" "$output" "$scope_unit" "$scope_control_group" "$scope_invocation_id" "$initial_cgroup_events" "$cgroup_stat" "$observed_populated" "$scope_created" "$scope_stopped" "$terminal_state_proven" "$cgroup_path_absent" "$no_reuse_proven" "$scope_empty" "$cleanup_proof_path" "$cleanup_error" "$initial_identity_json" "$terminal_identity_json" "$final_identity_json" <<'PY'
import json,sys
keys=('path','command','exit_status','duration_ms','total_tests','executed_tests','skipped_tests','status','output_file')
vals=sys.argv[2:11]
for i in (2,3,4,5,6): vals[i]=int(vals[i])
record=dict(zip(keys,vals))
scope_unit, control_group, invocation_id, initial_events, cgstat, observed_populated, created, stopped, terminal, absent, no_reuse, empty, proof_path, cleanup_error = sys.argv[11:25]
initial_identity, terminal_identity, final_identity = sys.argv[25:28]
record.update(
    execution_mode='ordinary_regression',
    mode_a_threat_model_limitation=(
        'Mode A threat-model limitation: ordinary regression shards are treated as cooperative/non-malicious test code. '
        'Mode A does not claim protection against a malicious same-UID workload or another hostile same-UID process '
        'intentionally racing systemd unit/cgroup identity reuse. Runner-reported semantic counts are regression evidence, '
        'not security-trusted attestation. Adversarial/security properties require Mode B/property-specific external verification.'
    ),
    runner_parser_schema_version=1,
    semantic_provenance='runner_reported',
    regression_status=record['status'],
    supervisor_observed_execution={
        'exit_status': record['exit_status'],
        'duration_ms': record['duration_ms'],
        'output_file': record['output_file'],
        'whole_descendant_cleanup': {
            'mechanism': 'systemd_user_scope_cgroup_v2',
            'scope_unit': scope_unit,
            'control_group': control_group,
            'invocation_id': invocation_id or None,
            'initial_live_identity_snapshot': json.loads(initial_identity) if initial_identity else None,
            'terminal_identity_snapshot': json.loads(terminal_identity) if terminal_identity else None,
            'no_reuse_identity_snapshot': json.loads(final_identity) if final_identity else None,
            'initial_cgroup_events': json.loads(initial_events) if initial_events else None,
            'initial_cgroup_stat': json.loads(cgstat) if cgstat else None,
            'externally_observed_populated_tasks': observed_populated == 'true',
            'scope_created_and_inspected': created == 'true',
            'scope_stop_requested': stopped == 'true',
            'terminal_scope_state_proven': terminal == 'true',
            'previously_observed_cgroup_path_absent': absent == 'true',
            'same_unit_reuse_excluded_during_proof': no_reuse == 'true',
            'whole_descendant_cleanup': empty == 'true',
            'tasks_after_cleanup': None,
            'externally_observed_zero_tasks': False,
            'proof_path': proof_path or None,
            'cleanup_proof_failure_reason': cleanup_error or None,
            'error': cleanup_error or None,
        },
    },
    runner_reported_semantics={
        'provenance': 'runner_reported',
        'discovered': record['total_tests'],
        'executed': record['executed_tests'],
        'skipped': record['skipped_tests'],
    },
)
with open(sys.argv[1],'a') as f: f.write(json.dumps(record,sort_keys=True)+'\n')
PY
  systemctl --user reset-failed "$scope_unit" >/dev/null 2>&1 || true
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
