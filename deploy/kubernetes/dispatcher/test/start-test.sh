#!/usr/bin/env bash
# start-test.sh -- exercises `rig-dispatch start`'s handover against ./fake-kubectl, so the one command
# the presenter types on stage is testable with no cluster and no pod: the ticket has to reach the seat as
# a queue item, and what the CLI prints around it must be what the audience needs and nothing more.
#
#   bash deploy/kubernetes/dispatcher/test/start-test.sh
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

PASS=0
FAILED=0
ok() { printf '  ok    %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; FAILED=$((FAILED + 1)); }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2], got [$3])"; fi; }
in_err() { if grep -q -- "$2" "$ERR"; then ok "$1"; else bad "$1 (no [$2] in stderr: $(head -c 300 "$ERR"))"; fi; }
not_in_err() { if grep -q -- "$2" "$ERR"; then bad "$1 (found [$2] in stderr)"; else ok "$1"; fi; }
in_calls() { if grep -q -- "$2" "$CALLS"; then ok "$1"; else bad "$1 (no [$2] in the recorded calls)"; fi; }

# run_start <case> [ENV=VALUE...] -- run `rig-dispatch start DEMO --brief-file ...` against the fake and
# report through RC, ERR (its stderr, which is what the presenter sees) and CALLS (the call log).
# FAKE_STS_NO_QITEM puts the team in the state the handover happens in: pod up, rig up, no ticket yet.
# FAKE_NO_HUB keeps the hub out of this test's way: registration is hub-sync-test's business, and a hub
# that is not Ready is a warning `start` survives rather than a reason to stop handing the ticket over.
run_start() {
  local name=$1
  shift
  CALLS="$WORK/$name.calls"
  : > "$CALLS"
  ERR="$WORK/$name.err"
  export FAKE_CALLS=$CALLS
  ( cd "$WORK" && env "$@" FAKE_STS_NO_QITEM=1 FAKE_NO_HUB=1 KUBECTL=kubectl \
      RIG_DISPATCH_NAMESPACE=openrig "$DISPATCH" start DEMO --brief-file "$BRIEF" ) >"$WORK/$name.out" 2>"$ERR"
  RC=$?
}

BRIEF="$WORK/brief.md"
printf '# Settle the output order with the human, then implement it\n\nAsk first.\n' > "$BRIEF"

echo "== the handover"
run_start handover
eq "start exits 0" 0 "$RC"
in_calls "the ticket was created on the seat's own daemon" "rig queue create"
in_calls "tagged with the ticket, so the team can find its own row" "--tags ticket:demo"
in_calls "with the brief as its body" "--body-file /home/openrig/work/brief.md"
in_calls "and read back as JSON, which is where the id comes from" "--json"
in_err "the seat and the new row are named on the log" "handed DEMO to orch-lead@demo-rig as qitem-handed-over-1"
in_calls "the row is recorded on the StatefulSet, so a re-run does not create a second one" "annotate --overwrite statefulset t-demo openrig.dev/qitem=qitem-handed-over-1"

echo "== what the presenter sees"
# `rig queue create` writes a request-identity note to stderr on every success -- it is a request id and
# not a commit receipt, which is why the CLI puts it there rather than in the JSON. The dispatcher reads
# the real id from stdout, so on stage the note is three lines of noise on every single start.
not_in_err "the queue-create request note is not on the screen" "Queue create request ID"
in_err "and the start's own line still is" "handed DEMO to orch-lead@demo-rig"

echo "== a create that really failed is still a loud failure"
# The same note is printed before the daemon is even asked, so filtering it must not be the same thing as
# swallowing the error that follows it. And on a create that produced no id the note is not noise: the CLI
# says a missing row does not rule out a pending commit, so that request id is the only handle for
# reconciling one. Re-running `start` instead mints a second id, and maybe a second row for the team.
run_start create-failed FAKE_QUEUE_CREATE=fail
eq "start exits non-zero when the row was never created" 1 "$RC"
in_err "it says the create failed, with its exit code" "queue create failed (exit 2)"
in_err "and the CLI's own reason is still on the screen" "destination_unknown"
in_err "with kubectl's line beside it, as it arrives" "command terminated with exit code 2"
in_err "and the request id survives, because it is the handle to reconcile this create" "Queue create request ID"
not_in_err "so no row was written to the StatefulSet" "openrig.dev/qitem=qitem-handed-over-1"

echo "== a create whose stdout is not JSON is a loud failure too, not a silent death"
# `set -euo pipefail` is on, and the create's output is buffered in files rather than streamed live. A jq
# that chokes on a stdout that is not JSON ends the script where it stands, and then nothing the CLI said
# is ever printed: the presenter sees a start that stopped after "waiting for t-demo-0 to be Ready" and no
# reason at all. The old code streamed stderr live, so the error stayed visible even then.
run_start create-garbage FAKE_QUEUE_CREATE=garbage
eq "start exits non-zero when stdout is not the JSON it expected" 1 "$RC"
in_err "it says the create failed, with its exit code" "queue create failed (exit 1)"
in_err "and the CLI's own reason is on the screen" "econnreset"
in_err "and so is what arrived where the id was due" "Error: daemon unreachable"
in_err "and the request id survives, because this create still has to be reconciled" "Queue create request ID"
not_in_err "so no row was written to the StatefulSet" "openrig.dev/qitem=qitem-handed-over-1"

printf '\n%s passed, %s failed\n' "$PASS" "$FAILED"
[ "$FAILED" -eq 0 ] || exit 1
