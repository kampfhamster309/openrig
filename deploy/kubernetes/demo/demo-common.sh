# demo-common.sh -- what prepare.sh and cleanup.sh both need. Sourced, not run.
#
# No pod read here uses `kubectl exec -i`. `-i` copies the caller's stdin into the pod whether or not
# the command inside it ever reads, so a script that is itself reading a list from a pipe would lose
# the rest of that list into a pod read that wanted nothing. Nothing here means to send stdin, so the
# reads use plain `exec` and close stdin as well.
#
# Every knob is an environment variable with a working default, so the run sheet can paste the
# commands as written and override one thing when it has to.

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

KUBECTL="${KUBECTL:-kubectl}"
NS="${RIG_DISPATCH_NAMESPACE:-openrig}"
HUB_POD="${RIG_DISPATCH_HUB_POD:-hub-0}"
DISPATCH="${RIG_DISPATCH:-$HERE/../dispatcher/rig-dispatch}"

# The label the dispatcher puts on every team object, so a volume or a Secret can be found by ticket
# without naming a pod that may already be gone.
DEMO_TICKET_LABEL="${DEMO_TICKET_LABEL:-openrig.dev/ticket}"

# The demo repository. The content is in this directory under ./repo; publishing it is somebody else's
# step, so the URL is a variable with the demo repository as its default.
DEMO_REPO="${DEMO_REPO:-https://github.com/kampfhamster309/openrig-demo}"
DEMO_REF="${DEMO_REF:-main}"

# One seat per team, from the kit's one-seat spec, with requests small enough that three teams fit on
# one small cluster together. Measured in rehearsal 1: sampled every 15s from each team
# container's own cgroup over the whole life of three teams: the worst `memory.peak` was 441Mi (t-demo-b),
# and `kubectl top` -- one instantaneous sample -- read about 25% under that, so it is the wrong instrument
# for a limit. `rig-dispatch` writes requests.{cpu,memory} and limits.memory only, so --memory IS the OOM
# line and --cpu is a request with no cap (a working team was measured bursting to 623m against a 200m
# request and was not throttled). 896Mi is 2x the worst peak, and it takes three teams from 4.5Gi of
# requests down to 2.6Gi on a cluster that has to fit them all at once.
DEMO_SPEC="${DEMO_SPEC:-/etc/openrig-kit/rig-one.yaml}"
DEMO_CPU="${DEMO_CPU:-200m}"
DEMO_MEMORY="${DEMO_MEMORY:-896Mi}"
DEMO_STORAGE="${DEMO_STORAGE:-2Gi}"

# The stall threshold the demo lowers the hub to, and where the value it replaces is remembered.
DEMO_STALL_MINUTES="${DEMO_STALL_MINUTES:-3}"
DEMO_STATE_DIR="${DEMO_STATE_DIR:-$HOME/.rig-dispatch/demo}"
THRESHOLD_FILE="$DEMO_STATE_DIR/stall-threshold.previous"

# Where the presenter's port-forward lands, and how long prepare.sh waits for the two prepared teams.
DEMO_PORT="${DEMO_PORT:-17433}"
DEMO_HOME="${DEMO_HOME:-$HOME/.openrig-hub-view}"
DEMO_WAIT_SECONDS="${DEMO_WAIT_SECONDS:-1200}"
# How often the wait re-reads a ticket's status. A test sets it to 0; a presenter leaves it alone.
DEMO_WAIT_POLL="${DEMO_WAIT_POLL:-15}"

# The only tickets this kit will ever name. The cluster also holds real tickets, and a team pod carries
# its volume with it, so a script that guessed at a name would destroy a real ticket's whole history.
DEMO_TICKETS=(DEMO-A DEMO-B DEMO-C)

log() { printf '[demo] %s\n' "$*" >&2; }
die() { printf 'demo: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }

k() { "$KUBECTL" -n "$NS" "$@" </dev/null; }

# The hub's own CLI, in the hub's own pod: the only supported way to change what the hub is told.
hubctl() { "$KUBECTL" -n "$NS" exec "$HUB_POD" -c daemon -- "$@" </dev/null; }

# Refuse anything that is not one of the demo tickets. Called with whatever a caller was handed.
demo_ticket() { # <ticket> -> the ticket, unchanged
  local t=$1 d
  for d in "${DEMO_TICKETS[@]}"; do
    [ "$t" = "$d" ] && { printf '%s' "$t"; return 0; }
  done
  die "refusing to touch '$t': this kit only handles ${DEMO_TICKETS[*]}, and it never works on a ticket it has to guess at"
}

team_exists() { # <ticket> -> 0 when its StatefulSet is there
  [ -n "$("$KUBECTL" -n "$NS" get statefulset "t-$(demo_ticket "$1" | tr '[:upper:]' '[:lower:]')" \
      -o name --ignore-not-found </dev/null 2>/dev/null)" ]
}

# Every team pod in the namespace that is neither the hub nor one of the demo teams. Anything here is
# somebody else's work, and the demo's end-state promise cannot be kept while it is running.
foreign_teams() {
  k get statefulsets -l openrig.dev/role=team -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' |
    grep -v -E '^t-demo-[abc]$' || true
}

# What the hub's registry holds, as one line: the hosts.yaml entries, the bearer files beside them, the
# trust-on-first-use aliases, and the per-host feed subscription nodes -- all four parts of a registration.
# All four at zero is the baseline an end state has to come back to. The files are read out of the hub and
# counted here, because the hub's image has no jq of its own.
#
# MISSING is not UNREADABLE, and the two have opposite consequences. A hub that never wrote a bindings file
# is at its baseline, not broken; calling that "unreadable" would make prepare.sh refuse to start and
# cleanup.sh fail forever on a perfectly clean hub. So each read asks for the file first and exits 0 empty
# when it is not there. What IS an error: the exec itself failing (a dead hub), or a file that exists and
# cannot be parsed. That is the rule hub-sync learned the hard way -- a failed read is not empty -- with
# the absent file put back on the empty side of it.
registry_snapshot() { # -> "hosts=N bearers=N bindings=N subs=N", or non-zero when the hub did not answer
  local out hosts bearers bindings subs

  if ! out=$(hubctl sh -c 'f="$HOME/.openrig/hosts.yaml"; [ -e "$f" ] || exit 0; cat "$f"'); then
    printf 'unreadable (%s would not give hosts.yaml)\n' "$HUB_POD"; return 1
  fi
  hosts=$(grep -cE '^[[:space:]]*-?[[:space:]]*id:' <<<"$out" || true)

  if ! out=$(hubctl sh -c 'd="$HOME/.openrig/hosts.d"; [ -d "$d" ] || exit 0; ls -A "$d"'); then
    printf 'unreadable (%s would not list hosts.d)\n' "$HUB_POD"; return 1
  fi
  bearers=$(grep -c . <<<"$out" || true)

  if ! out=$(hubctl sh -c 'f="$HOME/.openrig/host-bindings.json"; [ -e "$f" ] || exit 0; cat "$f"'); then
    printf 'unreadable (%s would not give host-bindings.json)\n' "$HUB_POD"; return 1
  fi
  bindings=$(jq '(.bindings // {}) | length' <<<"$out" 2>/dev/null) ||
    { printf 'unreadable (host-bindings.json is not JSON)\n'; return 1; }

  # The fourth part. A host listed without its subscription is registered and shows no queue, which
  # misleads in its own way, so an end state that left one behind would be wrongly called clean.
  if ! out=$(hubctl sh -c 'f="$HOME/.openrig/config.json"; [ -e "$f" ] || exit 0; cat "$f"'); then
    printf 'unreadable (%s would not give config.json)\n' "$HUB_POD"; return 1
  fi
  # Only the per-host nodes count as a registration. `feed.subscriptions` also holds the hub's global feed
  # preferences -- actionRequired, approvals, shipped, progress, audit_log (cli/src/config-store.ts) -- and
  # those are booleans, not hosts. Counting every key there would call any hub with a feed preference set
  # permanently not-empty, which fails prepare.sh before it starts and fails cleanup.sh forever. A per-host
  # node is an object (it holds `.enabled`); a preference is not.
  subs=$(jq '[ (.feed.subscriptions // {}) | objects | .[] | objects ] | length' <<<"$out" 2>/dev/null) ||
    { printf 'unreadable (config.json is not JSON)\n'; return 1; }

  printf 'hosts=%s bearers=%s bindings=%s subs=%s\n' \
    "${hosts:-0}" "${bearers:-0}" "${bindings:-0}" "${subs:-0}"
}

registry_is_empty() { local s; s=$(registry_snapshot) || return 1; [ "$s" = "hosts=0 bearers=0 bindings=0 subs=0" ]; }

threshold_get() { hubctl rig config get fleet.stall_threshold_minutes 2>/dev/null | tail -n1; }
threshold_set() { hubctl rig config set fleet.stall_threshold_minutes "$1" >/dev/null; }

# Remember the hub's own value once, in a file, so a second prepare does not record the demo value as
# if it were the original and a later cleanup cannot restore it.
threshold_record() {
  local now
  if [ -f "$THRESHOLD_FILE" ]; then
    log "stall threshold already recorded as $(cat "$THRESHOLD_FILE"); leaving that record alone"
    return 0
  fi
  now=$(threshold_get)
  case "$now" in ''|*[!0-9]*) die "could not read fleet.stall_threshold_minutes from $HUB_POD, so it cannot be restored later";; esac
  mkdir -p "$DEMO_STATE_DIR"
  printf '%s\n' "$now" > "$THRESHOLD_FILE"
  log "recorded the hub's stall threshold as ${now}m in $THRESHOLD_FILE"
}

threshold_restore() {
  [ -f "$THRESHOLD_FILE" ] || { log "no threshold record to restore (nothing was lowered, or it is already restored)"; return 0; }
  local was
  was=$(cat "$THRESHOLD_FILE")
  case "$was" in ''|*[!0-9]*) die "$THRESHOLD_FILE does not hold a number; refusing to write it to the hub";; esac
  threshold_set "$was"
  rm -f "$THRESHOLD_FILE"
  log "restored the hub's stall threshold to ${was}m"
}

# Is this team asking a human? Read the QUEUE ROW, not the result file. A team that parks its question on
# the queue holds an item in state `blocked`, and that row is the question. The result file cannot answer
# this: the dispatcher's own completion contract tells a seat to write `needs-human` into it while it asks,
# so a seat that obeys its contract would look FINISHED to anything reading the file -- and `probe` gives
# the file priority over the row when it builds the phase. Waiting on the row is what makes the wait say
# "waiting for a human" about a team that is genuinely waiting for a human.
team_asks_human() { # <ticket> -> 0 when the team holds a queue item in state blocked
  local out
  out=$("$DISPATCH" status "$(demo_ticket "$1")" --json 2>/dev/null) || return 1
  jq -e '[.[] | (.open // [])[] | select(.state == "blocked")] | length > 0' <<<"$out" >/dev/null 2>&1
}

# Which of this team's seats say they are waiting for input in their own pane? The pod's daemon already
# decides this, and `rig-dispatch status --json` carries the answer per seat: the daemon watches each
# seat's pane and serves `needs_input` for a selection or a permission prompt (`agentActivity.state`,
# whose reason for a menu is `selection_prompt`). Nothing here reads a screen -- this is the daemon's own
# report. A seat that parked its question on the queue shows no dialog; a seat waiting for a keystroke
# from a person who is not in that terminal does, and nobody is ever going to give it. That is the
# recorded failure: DEMO-A's lead opened Claude Code's own question dialog, neither the hub nor anyone
# saw it, and prepare.sh waited its full twenty minutes for a queue row that was never coming.
team_dialog_sessions() { # <ticket> -> one session per seat waiting on a dialog; empty when none
  local out
  out=$("$DISPATCH" status "$(demo_ticket "$1")" --json 2>/dev/null) || return 0
  jq -r '[ .[] | (.seats // [])[] | select(.activity == "needs_input") | (.session // .seat) ] | .[]' \
      <<<"$out" 2>/dev/null || true
}

# What to do about a seat waiting on a dialog, spelled out as the four hand steps that fix it. This is
# the recovery the recorded run used, done by hand: `Esc` in the pane, which chooses nothing, then one
# message pointing the seat back at its brief. Deliberately not automatic -- sending keys into another
# agent's dialog is the riskier path, and prepare.sh runs an hour before an audience, where a clear stop
# costs a minute and a wrong keystroke costs the talk.
dialog_recovery() { # <ticket> <session>
  local slug session ask
  slug=$(demo_ticket "$1" | tr '[:upper:]' '[:lower:]')
  session=$2
  ask='Read step 1 of your brief. The question goes on the queue with rig queue block --on human@host, not on your own screen: nobody is watching this pane, so a dialog there never reaches the human. Press Esc so no option is chosen, then park the row.'
  printf 'Recover it by hand, in about a minute:\n'
  printf '  1. see what it is waiting on:\n     %s -n %s exec t-%s-0 -c daemon -- rig capture %s --lines 40\n' \
    "$KUBECTL" "$NS" "$slug" "$session"
  printf '  2. press Esc in that pane so nothing is chosen (tmux ls inside the pod names the sessions):\n     %s -n %s exec -it t-%s-0 -c daemon -- tmux ls\n' \
    "$KUBECTL" "$NS" "$slug"
  printf '  3. point the seat back at its brief:\n     %s -n %s exec t-%s-0 -c daemon -- rig send %s %s\n' \
    "$KUBECTL" "$NS" "$slug" "$session" "$(printf '%q' "$ask")"
  printf '  4. re-run this script. It re-checks rather than starting a second team.\n'
}

# Wait for a team to park its question on the human, and stop early when it is not going to because it
# asked the wrong place. One reading of a dialog does not stop a run: a prompt the seat clears between two
# polls would kill a healthy team, so this wants the same seat reporting it twice in a row, DEMO_WAIT_POLL
# apart. A detection that never fires costs exactly what it costs today -- the full wait, then a message
# that names the possibility -- so it cannot break a run that is going well. Sets DEMO_DIALOG_SESSION to
# the seat it stopped on. -> 0 parked, 1 timed out, 2 sitting at a dialog
DEMO_DIALOG_SESSION=""
wait_team_parks() { # <ticket>
  local ticket=$1 deadline=$((SECONDS + DEMO_WAIT_SECONDS)) seen=0 session
  DEMO_DIALOG_SESSION=""
  while :; do
    if team_asks_human "$ticket"; then return 0; fi
    session=$(team_dialog_sessions "$ticket")
    if [ -n "$session" ]; then
      # shellcheck disable=SC2034  # prepare.sh reads this after the call; it sources this file.
      if [ "$seen" = 1 ]; then DEMO_DIALOG_SESSION=$session; return 2; fi
      seen=1
    else
      seen=0
    fi
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep "$DEMO_WAIT_POLL"
  done
}

# One ticket's phase, from the same read `status` prints.
team_phase() { # <ticket> -> phase, or "absent"
  local out
  out=$("$DISPATCH" status "$(demo_ticket "$1")" --json 2>/dev/null) || { printf 'absent'; return; }
  jq -r '.[0].phase // "absent"' <<<"$out" 2>/dev/null || printf 'absent'
}

# Has this team written the file that says it is finished? The path is the dispatcher's own WORK/result.json.
# The read closes its own stdin: nothing here means to send any.
team_result_missing() { # <ticket> -> 0 when /home/openrig/work/result.json is not there
  local slug
  slug=$(demo_ticket "$1" | tr '[:upper:]' '[:lower:]')
  ! "$KUBECTL" -n "$NS" exec "t-$slug-0" -c daemon -- sh -c 'test -f /home/openrig/work/result.json' \
      </dev/null >/dev/null 2>&1
}

# The seat the dispatcher handed the brief to, so a repair can be addressed to something real.
team_lead_session() { # <ticket> -> session name, or empty
  local out
  out=$("$DISPATCH" status "$(demo_ticket "$1")" --json 2>/dev/null) || return 0
  jq -r '[.[] | (.seats // [])[] | select(.status == "running") | .session] | first // empty' <<<"$out" 2>/dev/null
}

# A one-seat team can close its own queue row and stop with the change UNCOMMITTED and no result file.
# Measured in the rehearsal, not imagined: DEMO-B's seat claimed its row at 21:16:25 and closed it at
# 21:16:26 with the note "...Uncommitted.", and never wrote the file. `prepare.sh` waits on the result
# file, so that team would have sat there for the whole timeout with nothing on screen but a phase, and
# the script's only message would have named the phase -- which was not the problem. So: name the state,
# send the one message a person watching would send, and keep waiting. One send, not a loop: a seat that
# will not finish after being told once will not finish after being told five times, and each one costs a
# model call.
nudge_finish() { # <ticket> -> 0 when the ask reached a running seat; non-zero when there was no seat or the send failed
  local slug session
  slug=$(demo_ticket "$1" | tr '[:upper:]' '[:lower:]')
  session=$(team_lead_session "$1")
  [ -n "$session" ] || { log "$1: its queue row is closed and there is no result file, and no running seat to ask. Read it with: $DISPATCH status $1 --json"; return 1; }
  log "$1: its queue row is closed and there is no result file, so its commit is probably missing too -- asking the seat for the last two contract steps"
  "$KUBECTL" -n "$NS" exec "t-$slug-0" -c daemon -- rig send "$session" \
    "From the dispatcher: your queue item is closed, but the change is uncommitted and /home/openrig/work/result.json does not exist, so this ticket is not finished. Do the last two contract steps now: (1) in /home/openrig/work/project, create branch ticket/$slug if it is not current and commit the change; (2) write /home/openrig/work/result.json as {\"status\":\"done\",\"branch\":\"ticket/$slug\",\"commit\":\"<sha>\",\"summary\":\"...\"}. Do not redo the work." \
    </dev/null >/dev/null 2>&1
}

# Wait for a team to write its result file, repairing the one measured way it can fail to arrive.
# Prints the phase it ended on; non-zero when the timeout ran out.
wait_result() { # <ticket> [timeout]
  local ticket=$1 timeout="${2:-$DEMO_WAIT_SECONDS}" phase deadline nudged=0
  deadline=$((SECONDS + timeout))
  while :; do
    phase=$(team_phase "$ticket")
    if grep -qE '^result:(done|failed)$' <<<"$phase"; then printf '%s\n' "$phase"; return 0; fi
    if [ "$nudged" = 0 ] && team_result_missing "$ticket" && \
       [ "$("$DISPATCH" status "$ticket" --json 2>/dev/null | jq -r '[(.[] | (.open // [])[])] | length' 2>/dev/null)" = "0" ]; then
      # One attempt per wait, spent whether or not it found a seat: a team with no running seat does not
      # come back by waiting, and re-logging that every 15s is up to 80 identical lines before the timeout.
      nudge_finish "$ticket" || true
      nudged=1
    fi
    [ "$SECONDS" -lt "$deadline" ] || { printf '%s\n' "$phase"; return 1; }
    sleep "$DEMO_WAIT_POLL"
  done
}

# Wait until one ticket's phase matches an extended regex. Prints the phase it ended on, and returns
# non-zero when it ran out of time -- the caller says what that means for its own step.
wait_phase() { # <ticket> <extended-regex> [timeout]
  local ticket=$1 want=$2 timeout="${3:-$DEMO_WAIT_SECONDS}" phase deadline
  deadline=$((SECONDS + timeout))
  while :; do
    phase=$(team_phase "$ticket")
    if grep -qE "^(${want})$" <<<"$phase"; then printf '%s\n' "$phase"; return 0; fi
    [ "$SECONDS" -lt "$deadline" ] || { printf '%s\n' "$phase"; return 1; }
    sleep "$DEMO_WAIT_POLL"
  done
}

# The commands the presenter runs next, printed rather than run: the port-forward and the TUI belong in
# the presenter's own terminal, where the audience can see them.
print_view_commands() {
  cat <<EOF
export CLIENT=<your build of the hub's commit>/packages/cli   # the run sheet says how to build it
kubectl -n $NS port-forward pod/$HUB_POD $DEMO_PORT:7433 &
OPENRIG_HOME=$DEMO_HOME OPENRIG_URL=http://127.0.0.1:$DEMO_PORT \\
  node "\$CLIENT/tui/dist/main.js" --url http://127.0.0.1:$DEMO_PORT
EOF
  cat <<EOF

Never drop --url: without it the TUI opens your own daemon on 7433, not the hub's.

Check that build is the hub's build, not merely the same version number. The TUI has no --version of its
own, so read the CLI out of the same build it comes from:
  HUB_SHA=\$($KUBECTL -n $NS get pod $HUB_POD -o jsonpath='{.spec.containers[0].image}'); HUB_SHA=\${HUB_SHA##*:}; HUB_SHA=\${HUB_SHA#*-}; HUB_SHA=\${HUB_SHA:0:8}
  CLIENT_SHA=\$(node "\$CLIENT/dist/bin-wrapper.js" --version | sed -n 's/.*(\\([0-9a-f]\\{7,\\}\\).*/\\1/p')
  [ "\$CLIENT_SHA" = "\$HUB_SHA" ] && echo "client build matches the hub: \$CLIENT_SHA" || echo "MISMATCH: client \${CLIENT_SHA:-unstamped} vs hub \$HUB_SHA"
EOF
}
