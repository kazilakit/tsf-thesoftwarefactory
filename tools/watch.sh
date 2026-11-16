#!/usr/bin/env bash
# Watch the Board for factory work and start a headless /factory:run step only when there is some.
#
# The check is `factory next --peek`: plain node against the store, no model, so an idle minute costs no tokens.
# When it reports work (exit 0) and fewer than --max runs are going, one `claude -p "/factory:run --loop"` starts.
# Each run does one step of one task, as an interactive /factory:run does; the session-start hook gives it its own
# claimant, so parallel runs never take the same task.
#
# Usage: tools/watch.sh [--every <seconds>] [--factory <id>] [--max <runs>] [--once]
#   --every   seconds between checks (default 60, at least 10)
#   --factory only this factory (default: every active factory)
#   --max     runs at the same time (default 1, at most 10; match the factories' maxParallel to fill them)
#   --once    check once, start a run if there is work, and exit (for cron or a systemd timer)
# Env: FACTORY_STORE (default local); FACTORY_CLAUDE_ARGS, the flags for `claude -p`
#   (default `--permission-mode auto`). FACTORY_CLI, FACTORY_CLAUDE and FACTORY_WATCH_DIR replace the commands and
#   the state folder (tests only).
# Logs: runs/.watch/watch.log (only changes) and one runs/.watch/run-<time>.log per run. Stop with Ctrl-C.
set -u

root=$(cd "$(dirname "$0")/.." && pwd)
every=60 factory="" max=1 once=false
while [ $# -gt 0 ]; do
  case "$1" in
    --every) every=${2:-}; shift 2 ;;
    --factory) factory=${2:-}; shift 2 ;;
    --max) max=${2:-}; shift 2 ;;
    --once) once=true; shift ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "watch: unknown argument $1 (see --help)" >&2; exit 2 ;;
  esac
done
[[ "$every" =~ ^[0-9]+$ ]] && [ "$every" -ge 10 ] || { echo "watch: --every must be a whole number of seconds, at least 10" >&2; exit 2; }
[[ "$max" =~ ^[0-9]+$ ]] && [ "$max" -ge 1 ] && [ "$max" -le 10 ] || { echo "watch: --max must be 1 to 10" >&2; exit 2; }
[ -z "$factory" ] || [[ "$factory" =~ ^[a-z][a-z0-9-]{0,39}$ ]] || { echo "watch: --factory must be a factory id" >&2; exit 2; }

export FACTORY_ROOT="$root"
export FACTORY_STORE="${FACTORY_STORE:-local}"
cli=${FACTORY_CLI:-node "$root/core/dist/cli.js"}
claude_cmd=${FACTORY_CLAUDE:-claude}
claude_args=${FACTORY_CLAUDE_ARGS:---permission-mode auto}
dir=${FACTORY_WATCH_DIR:-"$root/runs/.watch"}
mkdir -p "$dir"

# One watcher per factory root.
exec 9>"$dir/lock"
if ! flock -n 9; then echo "watch: another watcher is running for $root" >&2; exit 3; fi

last=""
note() {
  # Log a check's result only when it changes, so a quiet Board leaves a quiet log.
  if [ "$1" != "$last" ]; then printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" | tee -a "$dir/watch.log"; last=$1; fi
}

running() {
  local n=0 f
  for f in "$dir"/*.pid; do
    [ -e "$f" ] || continue
    if kill -0 "$(cat "$f")" 2>/dev/null; then n=$((n + 1)); else rm -f "$f"; fi
  done
  echo "$n"
}

check() {
  if [ "$(running)" -ge "$max" ]; then note "busy: $max run(s) going"; return; fi
  local out code
  # shellcheck disable=SC2086 # $cli is a command line
  out=$(HUSKY=0 $cli --mode loop next --peek ${factory:+--factory "$factory"} 2>&1); code=$?
  case $code in
    0)
      local log="$dir/run-$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM.log"
      note "$out: starting /factory:run"
      last="" # the next check reports again, whatever it finds
      # shellcheck disable=SC2086 # $claude_args is a flag list
      (cd "$root" && exec $claude_cmd -p $claude_args -- "/factory:run --loop${factory:+ $factory}") >"$log" 2>&1 </dev/null &
      echo $! >"$dir/$!.pid"
      ;;
    1) note "idle: $out" ;;
    *) note "check failed (exit $code): $(printf '%s' "$out" | tail -n 1)" ;;
  esac
}

if $once; then check; wait; exit 0; fi
trap 'echo; echo "watch: stopped (runs already started finish on their own)"; exit 0' INT TERM
while true; do
  check
  sleep "$every" &
  wait $! 2>/dev/null
done
