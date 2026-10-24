#!/usr/bin/env bash
# prepare.sh -- make the cluster ready for the talk, and have the two teams that must be finished or
# waiting before anyone arrives. Run it about an hour before; run it again freely, it re-checks rather
# than starting a second team.
#
#   deploy/kubernetes/demo/prepare.sh
#
# What it does, in order: checks the cluster is the one the demo assumes, applies the kit, lowers the
# hub's stall threshold (remembering what it was), starts DEMO-A and DEMO-B one at a time, waits until
# A is waiting for a human and B is done, and prints the port-forward and TUI commands to paste next.
# Nothing here starts DEMO-C: that one is started live, on stage.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/demo-common.sh"

need jq
need "$KUBECTL"
[ -f "$DISPATCH" ] || die "no rig-dispatch at $DISPATCH (set RIG_DISPATCH)"
for f in "$HERE/briefs/DEMO-A.md" "$HERE/briefs/DEMO-B.md" "$HERE/repo"; do
  [ -e "$f" ] || die "$f is missing, so there is nothing to hand the teams"
done

# 1. The cluster: the hub is up, and nothing that is not the demo is running here.
k get pod "$HUB_POD" >/dev/null 2>&1 || die "no pod $HUB_POD in $NS: the demo reads the hub through it"
k wait --for=condition=Ready "pod/$HUB_POD" --timeout=60s >/dev/null 2>&1 ||
  die "$HUB_POD is not Ready; the demo has no fleet view without it"
foreign=$(foreign_teams)
[ -z "$foreign" ] || die "teams that are not the demo are running in $NS: $(tr '\n' ' ' <<<"$foreign"). The demo's end state is 'only the hub left', which cannot be reached while they run, and this script will not touch them."

# 2. The kit: the one-seat spec and the guidance files every team pod mounts. Idempotent by design.
log "applying the kit and the shared objects from $HERE/.."
"$KUBECTL" apply -k "$HERE/.." >/dev/null

# 3. The hub's registry. A team that is not there means the registry holds residue from an earlier run;
# `hub-sync` is the shipped repair, so say that rather than editing the hub by hand from here.
if ! registry_is_empty && ! team_exists DEMO-A && ! team_exists DEMO-B && ! team_exists DEMO-C; then
  die "the hub's registry is not empty ($(registry_snapshot)) while no team runs. Repair it first: $DISPATCH hub-sync --dry-run, then $DISPATCH hub-sync"
fi

# 4. The stall threshold, through the hub's own CLI, with the value it replaces kept on disk.
threshold_record
log "setting fleet.stall_threshold_minutes to ${DEMO_STALL_MINUTES}m so a quiet team shows as stalled during the talk"
threshold_set "$DEMO_STALL_MINUTES"

# 5. The two prepared teams, one at a time: a small cluster starts two pods at once badly, and the
# audience never sees this part anyway.
start_team() { # <ticket>
  local t
  t=$(demo_ticket "$1")
  log "starting $1 ($DEMO_SPEC, $DEMO_CPU / $DEMO_MEMORY)"
  "$DISPATCH" start "$t" --repo "$DEMO_REPO" --ref "$DEMO_REF" --spec "$DEMO_SPEC" \
    --brief-file "$HERE/briefs/$1.md" \
    --cpu "$DEMO_CPU" --memory "$DEMO_MEMORY" --storage "$DEMO_STORAGE"
}

start_team DEMO-A
start_team DEMO-B

# 6. Until the talk can actually start: A must be the one asking a question, B must be finished.
# A's check reads the queue row, not the result file, and that distinction is the whole point. The
# dispatcher's completion contract tells a seat to write `needs-human` into the result file while it asks
# on the queue, so a seat that obeys its contract has BOTH a parked row and a result file -- and `probe`
# lets the file win, so the phase reads `result:needs-human` while the team is waiting perfectly well.
# Waiting on the phase would call that "finished without asking" and kill a rehearsal that is going fine.
log "waiting for DEMO-A to be waiting for a human (up to $((DEMO_WAIT_SECONDS / 60))m)"
if ! wait_until "$DEMO_WAIT_SECONDS" "DEMO-A to park a question on the human" team_asks_human DEMO-A; then
  die "DEMO-A never parked a question on the human in $((DEMO_WAIT_SECONDS / 60))m (last phase: $(team_phase DEMO-A)). Its brief is the first thing to look at: $HERE/briefs/DEMO-A.md"
fi
log "DEMO-A has a queue item parked on human@host, which is what the audience will answer"

log "waiting for DEMO-B to finish (up to $((DEMO_WAIT_SECONDS / 60))m)"
# Not `wait_phase` alone. A one-seat team can close its own row and stop with the tree uncommitted and no
# result file -- measured in the rehearsal -- and a phase-only wait would sit through the whole timeout and
# then name the phase, which is not the fault. `wait_result` notices that state, asks the seat for the two
# contract steps it skipped, and keeps waiting.
phase=$(wait_result DEMO-B) || die "DEMO-B did not finish in $((DEMO_WAIT_SECONDS / 60))m (last phase: $phase). If its row is closed and the tree is uncommitted, the seat skipped its commit and its result file -- read it with: $DISPATCH status DEMO-B --json"
log "DEMO-B is done, which is what the archive-and-delete step shows"

# 7. The presenter's own commands. These run in the presenter's terminal, not here.
printf '\nThe cluster is ready. Paste these next, in the terminal you will present from:\n\n'
print_view_commands
printf '\nThen, on stage, start the third team (this is step 1 of the run sheet):\n\n'
printf '  %s start DEMO-C --repo %s --ref %s --spec %s --brief-file %s/briefs/DEMO-C.md --cpu %s --memory %s --storage %s\n\n' \
  "$DISPATCH" "$DEMO_REPO" "$DEMO_REF" "$DEMO_SPEC" "$HERE" "$DEMO_CPU" "$DEMO_MEMORY" "$DEMO_STORAGE"
printf 'After the talk: %s/cleanup.sh\n' "$HERE"
