#!/usr/bin/env bash
# Deterministic SSH/SCP failure classification and bounded retry helper.
# Source this file, then call ssh_retry_run -- command args...

ssh_failure_classify() {
  local status=$1 stderr=${2:-}
  if (( status == 0 )); then printf '%s\n' success; return 0; fi
  if (( status != 255 )); then printf '%s\n' permanent_remote_command; return 0; fi

  case "$stderr" in
    *"Permission denied"*|*"Host key verification failed"*|*"REMOTE HOST IDENTIFICATION HAS CHANGED"*|*"Bad configuration option"*|*"no such identity"*|*"Could not resolve hostname"*)
      printf '%s\n' permanent_transport ;;
    *"Connection timed out"*|*"Operation timed out"*|*"Connection refused"*|*"Connection reset"*|*"Broken pipe"*|*"Network is unreachable"*|*"No route to host"*|*"Temporary failure in name resolution"*)
      printf '%s\n' transient_transport ;;
    *) printf '%s\n' permanent_unknown ;;
  esac
}

ssh_retry_run() {
  local attempts=${SSH_RETRY_ATTEMPTS:-3}
  local delay=${SSH_RETRY_INITIAL_DELAY:-1}
  local cap=${SSH_RETRY_MAX_DELAY:-8}
  local sleep_cmd=${SSH_RETRY_SLEEP_CMD:-sleep}
  [[ ${1:-} == -- ]] || { printf '%s\n' "usage: ssh_retry_run -- command [args...]" >&2; return 64; }
  shift
  (( attempts >= 1 )) || { printf '%s\n' "SSH_RETRY_ATTEMPTS must be >= 1" >&2; return 64; }

  local attempt=1 status stderr_file stderr classification
  while :; do
    stderr_file=$(mktemp)
    if "$@" 2>"$stderr_file"; then status=0; else status=$?; fi
    stderr=$(<"$stderr_file")
    rm -f "$stderr_file"
    [[ -z "$stderr" ]] || printf '%s\n' "$stderr" >&2
    classification=$(ssh_failure_classify "$status" "$stderr")
    printf 'ssh-attempt=%d classification=%s status=%d\n' "$attempt" "$classification" "$status" >&2
    (( status == 0 )) && return 0
    [[ $classification == transient_transport ]] || return "$status"
    (( attempt < attempts )) || return "$status"
    "$sleep_cmd" "$delay"
    delay=$((delay * 2))
    (( delay > cap )) && delay=$cap
    attempt=$((attempt + 1))
  done
}
