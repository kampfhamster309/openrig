#!/usr/bin/env bash
# cleanup.sh -- take the demo apart and show the cluster is back the way it was found.
#
#   deploy/kubernetes/demo/cleanup.sh
#
# It collects and deletes every DEMO team (or repairs the hub's view of one that is already broken),
# removes their volumes, restores the stall threshold the demo lowered, and then checks the end state:
# no demo team left, the hub's registry empty, the threshold back where it was. Safe to run twice, and
# safe to run when there is nothing to clean. It only ever names DEMO-A, DEMO-B and DEMO-C: a team it
# did not start is a team it will not touch, and it says so rather than guessing.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/demo-common.sh"

need jq
need "$KUBECTL"
[ -f "$DISPATCH" ] || die "no rig-dispatch at $DISPATCH (set RIG_DISPATCH)"

ARCHIVE_DIR="${DEMO_ARCHIVE_DIR:-$DEMO_STATE_DIR/tickets}"
mkdir -p "$ARCHIVE_DIR"

fail=0

# The threshold goes back whatever else happens below. A delete that is refused partway through the team
# loop must not leave the hub lowered to ${DEMO_STALL_MINUTES} minutes for the next person to find, so the
# restore sits on the exit path rather than after the loop's verdict. It is idempotent -- it removes its own
# record file -- so the explicit call at the end and this trap do not fight each other.
was=""
[ -f "$THRESHOLD_FILE" ] && was=$(cat "$THRESHOLD_FILE")
trap 'threshold_restore >/dev/null 2>&1 || true' EXIT

# Leftovers a StatefulSet can outlive. `kubectl delete statefulset` takes the pod and -- through the
# retention policy -- the volume, but NOT the Secret: only the dispatcher's own delete removes that, which
# is the thing the hub-sync proof had to learn with HUBP-A. So "no StatefulSet" is not "nothing left".
team_residue() { # <slug> -> 0 when a Secret or a volume of this team is still there
  local slug=$1
  [ -n "$(k get secret "t-$slug" -o name --ignore-not-found)" ] && return 0
  [ -n "$(k get pvc -l "$DEMO_TICKET_LABEL=$slug" -o name --ignore-not-found)" ] && return 0
  return 1
}

# Archive a team and delete it, once, then again if that failed. A refusal is common and is not this
# script's fault: the dispatcher refuses to delete a team that has moved on since its archive, which is
# exactly what a team still working on stage looks like. One retry covers the case where the first collect
# raced the team finishing; anything past that is reported and the run goes on with the other tickets.
remove_team() { # <ticket> <slug> -> 0 removed, 1 could not
  local ticket=$1 slug=$2 attempt
  for attempt in 1 2; do
    if "$DISPATCH" collect "$ticket" --archive "$ARCHIVE_DIR"; then
      "$DISPATCH" delete "$ticket" --dir "$ARCHIVE_DIR" && return 0
    else
      log "$ticket: collect failed, so the pod is probably already gone. Deleting without an archive and repairing the hub's view after."
      "$DISPATCH" delete "$ticket" --force --dir "$ARCHIVE_DIR" && return 0
    fi
    [ "$attempt" = 1 ] && log "$ticket: first attempt refused; retrying once"
  done
  return 1
}

# 1. The teams. Each one is archived before it goes, because that is the only way to keep what the team
# did, and the dispatcher refuses to delete an unarchived ticket for the same reason. A team whose pod
# is already unreachable cannot be archived, so it goes the other way: deleted by force, and the hub's
# registry repaired afterwards by hub-sync, which is what that verb is for.
removed=0
for ticket in "${DEMO_TICKETS[@]}"; do
  slug=$(demo_ticket "$ticket" | tr '[:upper:]' '[:lower:]')

  if ! team_exists "$ticket"; then
    # Not running is not the same as nothing left: this is the path a run sheet step 7 leaves behind.
    if team_residue "$slug"; then
      log "$ticket: no StatefulSet, but its Secret or volume is still there; clearing the residue"
      "$DISPATCH" delete "$ticket" --force --dir "$ARCHIVE_DIR" ||
        { log "FAIL: $ticket: residue is still there. Clear it with: $KUBECTL -n $NS delete secret t-$slug; $KUBECTL -n $NS delete pvc -l $DEMO_TICKET_LABEL=$slug"; fail=1; }
    fi
    continue
  fi

  log "$ticket: $(team_phase "$ticket"), archiving into $ARCHIVE_DIR"
  if remove_team "$ticket" "$slug"; then
    # The volume goes with the StatefulSet when the dispatcher deletes it; this covers a StatefulSet that
    # went away by some other route, which is exactly the case that leaves a PVC behind holding a team's
    # whole history.
    k delete pvc -l "$DEMO_TICKET_LABEL=$slug" --ignore-not-found >/dev/null
    removed=$((removed + 1))
  else
    log "FAIL: $ticket: would not archive or delete it. Look at $DISPATCH delete $ticket --dir $ARCHIVE_DIR"
    fail=1
  fi
done
[ "$removed" = 0 ] && log "no DEMO team to remove"

# 2. The hub's registry. Anything still listed with no team behind it is residue from a team that was
# removed by force, and hub-sync is the verb that reconciles it.
if ! registry_is_empty; then
  log "the hub still lists something ($(registry_snapshot)); running hub-sync to bring it back in line"
  "$DISPATCH" hub-sync || log "hub-sync did not finish; check it with: $DISPATCH hub-sync --dry-run"
fi

# 3. The setting the demo changed, restored through the hub's own CLI the same way it was lowered. The trap
# would have done it on any earlier exit; this is the orderly path, and it says out loud what it restored.
threshold_restore || log "note: the hub would not take the threshold back; set it by hand with: $KUBECTL -n $NS exec $HUB_POD -c daemon -- rig config set fleet.stall_threshold_minutes <minutes>"

# 4. The end state, checked rather than asserted.
demo_left=$(k get statefulsets -l openrig.dev/role=team -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' |
  grep -E '^t-demo-[abc]$' || true)
if [ -n "$demo_left" ]; then log "FAIL: demo teams are still running: $(tr '\n' ' ' <<<"$demo_left")"; fail=1; fi
if [ -n "$(foreign_teams)" ]; then
  log "note: teams that were not the demo's are still running, untouched as promised: $(foreign_teams | tr '\n' ' ')"
fi
if ! registry_is_empty; then
  log "FAIL: the hub's registry is not back to empty, or could not be read: $(registry_snapshot)"; fail=1
fi
now=$(threshold_get)
if [ -n "$was" ] && [ "$now" != "$was" ]; then
  log "FAIL: fleet.stall_threshold_minutes is ${now}, not the ${was} the demo found on arrival"; fail=1
fi
pvc_left=$(k get pvc -l openrig.dev/role=team -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null |
  grep -E '^home-t-demo-' || true)
if [ -n "$pvc_left" ]; then log "FAIL: demo volumes are still there: $pvc_left"; fail=1; fi
# The check the residue case needed. A StatefulSet deleted by kubectl leaves its Secret behind, and a run
# that stopped at "no team is running" would have called that clean with a live credential still in the
# namespace -- so the Secret is part of the end state, not a detail of the delete path.
secret_left=$(k get secrets -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null |
  grep -E '^t-demo-[abc]$' || true)
if [ -n "$secret_left" ]; then
  log "FAIL: demo Secrets are still there: $(tr '\n' ' ' <<<"$secret_left")"; fail=1
fi

if [ "$fail" = 0 ]; then
  log "done: $removed team(s) removed, the hub's registry is $(registry_snapshot), the stall threshold is ${now:-unchanged}"
else
  die "the cluster is not back to its starting state; the FAIL lines above say what is left"
fi
