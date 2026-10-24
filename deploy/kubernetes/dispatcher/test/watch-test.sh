#!/usr/bin/env bash
# watch-test.sh -- exercises `rig-dispatch watch` against ./fake-kubectl, so the event stream, its
# resume and its replay-gap fallback are testable with no cluster and no pod.
#
#   bash deploy/kubernetes/dispatcher/test/watch-test.sh
#
# The recorded streams in ./fixtures stand for the team daemon's /api/events. Each connection the
# watcher makes appends the Last-Event-ID it was given to $FAKE_EVENTS_SEEN, so resume is asserted
# from what the watcher actually asked for rather than from what it says it did.
#
# One line per check on stdout; exits non-zero if any check failed.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
DISPATCH="$HERE/../rig-dispatch"
FIXTURES="$HERE/fixtures"
[ -f "$DISPATCH" ] || { echo "no rig-dispatch at $DISPATCH" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"
mkdir -p "$BIN"
cp "$HERE/fake-kubectl" "$BIN/kubectl"
chmod +x "$BIN/kubectl" "$HERE/fake-kubectl"
export PATH="$BIN:$PATH"
export FAKE_FIXTURES=$FIXTURES
# Marks every fake kubectl this run starts, so the reader check below can tell its own processes from
# another run's. See ./fake-kubectl.
export FAKE_RUN_TAG="$(basename "$WORK")-$$"

PASS=0
FAILED=0
ok() { printf '  ok    %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; FAILED=$((FAILED + 1)); }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2], got [$3])"; fi; }
in_err() { # in_err <desc> <pattern> -- the watcher logs to stderr
  if grep -q -- "$2" "$ERR"; then ok "$1"; else bad "$1 (no [$2] in stderr: $(head -c 300 "$ERR"))"; fi
}
not_in_err() {
  if grep -q -- "$2" "$ERR"; then bad "$1 (found [$2] in stderr)"; else ok "$1"; fi
}
in_out() { # in_out <desc> <pattern> -- the ticket's result goes to stdout
  if grep -q -- "$2" "$OUT"; then ok "$1"; else bad "$1 (no [$2] in stdout: $(head -c 300 "$OUT"))"; fi
}

# run_watch <name> <watch argv...> -- runs `rig-dispatch watch` against the fake with a state
# directory of its own, and reports through RC, ERR, OUT, ELAPSED, STATE (the per-ticket id store)
# and SEEN (the Last-Event-ID of each connection). Knobs go in ENVV; SEED_LINE pre-stores the whole
# id file, which is how a test stands for a watcher that restarted -- or for one whose stored id came
# from a ticket instance that no longer exists.
ENVV=()
SEED_LINE=""
run_watch() {
  local name=$1
  shift
  local T0=$SECONDS
  CALLS="$WORK/$name.calls"; : >"$CALLS"; export FAKE_CALLS=$CALLS
  SEEN="$WORK/$name.seen"; : >"$SEEN"; export FAKE_EVENTS_SEEN=$SEEN
  REAP="$WORK/$name.reap"; : >"$REAP"; export FAKE_REAP=$REAP
  STATE="$WORK/$name.state"; mkdir -p "$STATE"
  if [ -n "$SEED_LINE" ]; then printf '%s\n' "$SEED_LINE" >"$STATE/demo.id"; fi
  ( cd "$WORK" && env ${ENVV[@]+"${ENVV[@]}"} KUBECTL=kubectl RIG_DISPATCH_NAMESPACE=openrig \
      RIG_DISPATCH_WATCH_DIR="$STATE" "$DISPATCH" watch "$@" ) \
      >"$WORK/$name.out" 2>"$WORK/$name.err"
  RC=$?
  ELAPSED=$((SECONDS - T0))
  ERR="$WORK/$name.err"
  OUT="$WORK/$name.out"
}

# leftover_readers -- how many fake-kubectl stream readers are still running. A `kubectl exec` that
# outlives its watch leaves an in-pod curl open on the team's daemon, so the reader has to die with
# the command that started it. Counted through this run's marker rather than by the pattern alone:
# `ps` sees the whole machine, so a machine-wide count makes two concurrent runs of this test each fail
# on the other's readers -- a false failure, and the kind that teaches people to ignore a check.
leftover_readers() {
  ps -eo args 2>/dev/null | grep "exec -i t-demo-0" | grep -F "$FAKE_RUN_TAG" | grep -v grep |
    wc -l | tr -d ' '
}

printf '# terminal event, on a stream that never ends\n'
ENVV=(); SEED_LINE=""
run_watch terminal DEMO --reconnect 1
eq "a terminal event ends the watch" 0 "$RC"
in_err "names the queue item that reached the terminal state" "qitem-a reached done"
in_err "reports the ticket verdict" "result:done"
in_out "prints the result file on stdout" "0123456789abcdef"
eq "stores the last event id with the ticket instance that produced it" "qitem-a 2" "$(cat "$STATE/demo.id" 2>/dev/null)"
not_in_err "a contiguous stream claims no gap" "replay gap"
if [ "$ELAPSED" -lt 10 ]; then ok "it returns on the verdict, not when the stream ends (${ELAPSED}s)"
else bad "it waited ${ELAPSED}s instead of returning on the verdict"; fi
sleep 1
eq "no stream reader outlives the watch" "0" "$(leftover_readers)"
eq "the in-pod reader was reaped by name" "1" "$(wc -l < "$REAP" | tr -d ' ')"

printf '# human needed\n'
ENVV=(FAKE_EVENTS=events-human.sse FAKE_NO_RESULT=1); SEED_LINE=""
run_watch human DEMO --reconnect 1 --timeout 2
eq "a block alone does not end the ticket" 4 "$RC"
in_err "names the queue item that needs a human" "qitem-b is blocked"
in_err "says what a block means" "a human may be needed"
in_err "still reads the ticket status after the block" "working (human)"

printf '# a status probe must not drink the stream it is watching\n'
# The probe is a `kubectl exec -i` like every other pod read, and it runs INSIDE the loop that reads
# the event stream. Real kubectl copies the caller's stdin into the pod whether or not the command
# inside it reads, so a probe that inherits the stream eats the events still sitting in the pipe.
# Here that is the terminal one: the fake drains stdin the way the real kubectl does, so without the
# read closing stdin the verdict is delivered and lost, and the watch waits out its deadline for an
# event that already came and went. FAKE_NO_RESULT keeps the verdict off the probe so only the stream
# can bring it, and the backstop is pushed past the timeout so the event is the only probe trigger.
ENVV=(FAKE_EVENTS=events-steal.sse FAKE_NO_RESULT=1 RIG_DISPATCH_WATCH_BACKSTOP=999); SEED_LINE=""
run_watch steal DEMO --reconnect 1 --timeout 3
in_err "the event after the probe still arrives" "qitem-a reached done"
eq "and its id is stored, not skipped" "qitem-a 2" "$(cat "$STATE/demo.id" 2>/dev/null)"
in_err "the probe ran and said what it saw" "working (human)"
eq "the watch is waiting on a verdict, not on a stolen event" 4 "$RC"

printf '# the deadline is honoured while the stream is open\n'
# Nothing arrives at all, so nothing can trigger a reconcile: the only thing that can end this watch
# is its own deadline, and a stream that stays open never gives the loop any other chance to look.
ENVV=(RIG_DISPATCH_WATCH_BACKSTOP=999 FAKE_EVENTS=events-empty.sse); SEED_LINE=""
run_watch quiet DEMO --reconnect 1 --timeout 3
eq "a watch with no event to act on ends on its timeout" 4 "$RC"
if [ "$ELAPSED" -lt 10 ]; then ok "and it ends at the timeout, not whenever the stream ends (${ELAPSED}s of 3s)"
else bad "--timeout was ignored: it ran ${ELAPSED}s"; fi
in_err "says that it timed out" "timed out after 3s"
sleep 1
eq "a timed-out watch leaves no reader behind" "0" "$(leftover_readers)"

printf '# a dropped stream resumes where it stopped\n'
ENVV=(FAKE_EVENTS_END=1 FAKE_EVENTS=events-drop.sse FAKE_EVENTS2=events-resume.sse); SEED_LINE=""
run_watch resume DEMO --reconnect 1
eq "the verdict still arrives after a dropped stream" 0 "$RC"
eq "the first connection asked for no replay" "none" "$(sed -n 1p "$SEEN")"
eq "the reconnect asks for the last event it already saw" "2" "$(sed -n 2p "$SEEN")"
not_in_err "contiguous replay is not called a gap" "replay gap"
eq "the id stored across both streams is the last one" "qitem-a 3" "$(cat "$STATE/demo.id" 2>/dev/null)"

printf '# a stored id from another ticket instance is not resumed\n'
# The realistic stale-id case: the ticket key was deleted and started again, so the pod's event store
# begins at 1 again while the dispatcher still holds a high id for that key. Resuming it would make
# the daemon replay nothing at all, so the id has to be recognised as belonging to another instance.
ENVV=(); SEED_LINE="qitem-gone 500"
run_watch staleinstance DEMO --reconnect 1
eq "a stale id does not stop the verdict arriving" 0 "$RC"
eq "the watcher starts from 0 instead of the stored 500" "none" "$(sed -n 1p "$SEEN")"
in_err "says the stored id belongs to another instance" "belongs to ticket instance qitem-gone"
eq "and the store is rewritten for the live instance" "qitem-a 2" "$(cat "$STATE/demo.id" 2>/dev/null)"

printf '# a fresh volume under the same ticket: silence, and the backstop answers\n'
# This is what a pod that came back on a new volume actually looks like from the stream: the daemon
# replays only ids above the one it was given, so it sends nothing at all until its own ids pass it.
# No event can reveal that gap, so the slow status read is what has to find the ticket.
ENVV=(RIG_DISPATCH_WATCH_BACKSTOP=2 FAKE_EVENTS=events-empty.sse); SEED_LINE="qitem-a 500"
run_watch freshvolume DEMO --reconnect 1 --timeout 30
eq "the backstop reaches the verdict on a silent stream" 0 "$RC"
in_err "and says it was the backstop that found it" "result:done (backstop)"
not_in_err "a silent stream is not invented as a replay gap" "replay gap"

printf '# no stream at all\n'
ENVV=(FAKE_EVENTS_FAIL=1); SEED_LINE=""
run_watch noevents DEMO --reconnect 1 --timeout 30
eq "with no stream the ticket still comes in, by polling" 0 "$RC"
in_err "says it is falling back to polling" "falling back to polling"
in_out "the polling fallback prints the result too" "0123456789abcdef"

printf '# every team at once\n'
ENVV=(); SEED_LINE=""
run_watch allteams --all --reconnect 1
eq "--all reaches the verdict of the one team pod" 0 "$RC"
in_err "--all names the team it watched" "qitem-a reached done"
sleep 1
eq "--all leaves no reader behind either" "0" "$(leftover_readers)"

printf '# no caller sends stdin through a helper that closes it\n'
# `inpod` and `hub_exec` close stdin themselves; a caller that means to send stdin has to say so with
# the `_stdin` variant. The way that gets forgotten is always the same shape -- a pipe, a heredoc or a
# redirect into the plain name, which then sends nothing at all and usually exits 0 doing it. The one
# sender here with no test of its own is `start`'s brief handover: a silent empty send would leave the
# team with an empty brief and a queue item quoting an empty first line, and every test would stay
# green. So the rule is checked against the source, not only against behaviour.
# A name ends at a non-word character, not only at whitespace: `runner=hub_exec;` is exactly the bug and
# a `[[:space:]]$` boundary would walk past it.
GUARD=""
guard_scan() { # <regex> -- the lines that match, with their numbers, minus comments
  grep -nE "$1" "$DISPATCH" | grep -vE '^[0-9]+:[[:space:]]*#' || true
}
GUARD=$(guard_scan '\|&?[[:space:]]*(inpod|hub_exec)([^[:alnum:]_]|$)')
GUARD="${GUARD}${GUARD:+
}$(guard_scan '(^|[[:space:]])(inpod|hub_exec)([^[:alnum:]_]|$).*<<')"
GUARD="${GUARD}${GUARD:+
}$(guard_scan '[[:alnum:]_]+=(inpod|hub_exec)([^[:alnum:]_]|$)')"
if [ -z "$GUARD" ]; then
  ok "nothing pipes, heredocs or assigns its way into a helper that closes stdin"
else
  bad "a caller sends stdin through a helper that closes it: $(tr '\n' '|' <<<"$GUARD" | head -c 300)"
fi
# The indirect form is the one a plain grep on the call sites misses: `runner=hub_exec` and then a pipe
# into "$runner". Naming the helper as a value is only ever done to run it with a pipe, so the
# assignment above is what catches it -- and the registry rewrite is the place that does it, so if that
# line ever changes shape the check above has silently stopped covering the indirect case.
if [ -n "$(guard_scan '[[:alnum:]_]+=hub_exec_stdin([^[:alnum:]_]|$)')" ] &&
   [ -n "$(grep -nF '| "$runner"' "$DISPATCH")" ]; then
  ok "the runner assigned by name is the sending one, and something still pipes through it"
else
  bad "the runner-by-name pattern no longer looks like the runner-by-name pattern; re-read the guard above"
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAILED"
[ "$FAILED" = 0 ] || exit 1
