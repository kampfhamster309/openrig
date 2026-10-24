#!/usr/bin/env bash
# demo-scripts-test.sh -- exercises deploy/kubernetes/demo/{prepare,cleanup}.sh with no cluster,
# against ./fake-kubectl and ./fake-rig-dispatch.
#
#   bash deploy/kubernetes/demo/test/demo-scripts-test.sh
#
# What is being tested is what the two scripts ask for, because that is what their promises mean.
# "Idempotent" is: a second run does not record the demo's own lowered threshold as the original.
# "Refuses anything that is not a DEMO team" is: a team named t-foo-1 is never named in a delete.
# "Restores the threshold" is: the value found on arrival goes back through the hub's own `rig config
# set`. A cluster would show one run at a time and charge model calls for the privilege.
#
# One line per check on stdout; exits non-zero if any check failed.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
DEMO="$HERE/.."
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"; mkdir -p "$BIN"
cp "$HERE/fake-kubectl" "$BIN/kubectl"
cp "$HERE/fake-rig-dispatch" "$BIN/rig-dispatch"
chmod +x "$BIN/kubectl" "$BIN/rig-dispatch"
export PATH="$BIN:$PATH"
export DEMO_FAKE_STATE="$WORK/state" DEMO_FAKE_CALLS="$WORK/calls"
# The fake hub's $HOME/.openrig is built here, so the registry reads run against real files inside the
# test's own scratch dir and are cleaned up with it.
export FAKE_HUB_HOME="$WORK/hubhome"
export RIG_DISPATCH="$BIN/rig-dispatch"
export DEMO_STATE_DIR="$WORK/statedir" DEMO_WAIT_SECONDS=2 DEMO_WAIT_POLL=0
mkdir -p "$DEMO_STATE_DIR"

PASS=0; FAILED=0
ok() { printf '  ok    %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; FAILED=$((FAILED + 1)); }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2], got [$3])"; fi; }
in_calls() { if grep -q -- "$2" "$DEMO_FAKE_CALLS"; then ok "$1"; else bad "$1 (no [$2] in the calls: $(head -c 300 "$DEMO_FAKE_CALLS"))"; fi; }
not_in_calls() { if grep -q -- "$2" "$DEMO_FAKE_CALLS"; then bad "$1 (found [$2] in the calls)"; else ok "$1"; fi; }
in_err() { if grep -q -- "$2" "$ERR"; then ok "$1"; else bad "$1 (no [$2] in stderr: $(head -c 300 "$ERR"))"; fi; }
not_in_err() { if grep -q -- "$2" "$ERR"; then bad "$1 (found [$2] in stderr)"; else ok "$1"; fi; }
in_out() { if grep -q -- "$2" "$OUT"; then ok "$1"; else bad "$1 (no [$2] in stdout: $(head -c 300 "$OUT"))"; fi; }
state_get() { sed -n "s/^$1=//p" "$DEMO_FAKE_STATE" | tail -n1; }

# A cluster as it stands an hour before the talk: the hub, nothing else, an empty registry, the default
# threshold, and the two prepared teams already in the state the run sheet needs. `open_DEMO_A=blocked`
# is the queue row DEMO-A parked on the human; `secrets` and `pvcs` start empty because nothing has run.
new_state() {
  printf 'teams=""\nthreshold=30\nhosts=0\nbearers=0\nbindings=0\nsubs=0\ncollect_fails=0\npvcs=""\nsecrets=""\nhub_readable=1\nmissing=""\nfeed_prefs=0\nbad_json=0\n' > "$DEMO_FAKE_STATE"
  printf 'phase_DEMO_A=blocked\nphase_DEMO_B=result:done\nphase_DEMO_C=working\n' >> "$DEMO_FAKE_STATE"
  printf 'open_DEMO_A=blocked\nopen_DEMO_B=none\nopen_DEMO_C=pending\n' >> "$DEMO_FAKE_STATE"
  : > "$DEMO_FAKE_CALLS"
  rm -f "$DEMO_STATE_DIR/stall-threshold.previous"
}

run_prepare() {
  ( cd "$WORK" && "$DEMO/prepare.sh" ) >"$WORK/out" 2>"$WORK/err"; RC=$?
  OUT="$WORK/out"; ERR="$WORK/err"
}
run_cleanup() {
  ( cd "$WORK" && "$DEMO/cleanup.sh" ) >"$WORK/out" 2>"$WORK/err"; RC=$?
  OUT="$WORK/out"; ERR="$WORK/err"
}
record_file() { printf '%s' "$DEMO_STATE_DIR/stall-threshold.previous"; }

printf '# the scripts parse and the fakes answer\n'
for f in "$DEMO/demo-common.sh" "$DEMO/prepare.sh" "$DEMO/cleanup.sh"; do
  if bash -n "$f" 2>/dev/null; then ok "bash -n $(basename "$f")"; else bad "bash -n $(basename "$f")"; fi
done
new_state
run_prepare
eq "prepare runs against the fake cluster" 0 "$RC"
in_calls "the kit is applied from the deploy directory" "kubectl apply -k"
in_calls "the threshold is set through the hub's own CLI" "config-set 3"

printf '\n# a cluster with somebody else'\''s team on it\n'
new_state
printf 'teams="t-foo-1"\n' >> "$DEMO_FAKE_STATE"
run_prepare
eq "prepare refuses to work alongside a team it did not start" 1 "$RC"
in_err "and names the team it is refusing to share with" "t-foo-1"
not_in_calls "and it refused before changing anything" "kubectl apply -k"
not_in_calls "so the hub's threshold was never touched" "config-set"

printf '\n# the prepared run\n'
new_state
run_prepare
eq "prepare gets the cluster ready and exits 0" 0 "$RC"
in_calls "DEMO-A is started from the one-seat kit spec" "start DEMO-A --repo https://github.com/kampfhamster309/openrig-demo --ref main --spec /etc/openrig-kit/rig-one.yaml"
in_calls "with the small requests the cluster needs" "--cpu 200m --memory 1536Mi"
in_calls "and its brief handed over" "briefs/DEMO-A.md"
in_calls "DEMO-B is started too" "rig-dispatch start DEMO-B"
if [ "$(grep -n 'start DEMO-A' "$DEMO_FAKE_CALLS" | head -1 | cut -d: -f1)" -lt \
     "$(grep -n 'start DEMO-B' "$DEMO_FAKE_CALLS" | head -1 | cut -d: -f1)" ]; then
  ok "one at a time, A before B"
else bad "DEMO-B was started before DEMO-A"; fi
eq "the hub is left at the demo threshold" "3" "$(state_get threshold)"
eq "the value it replaces is kept" "30" "$(cat "$(record_file)" 2>/dev/null)"
in_out "the presenter is told how to reach the hub" "OPENRIG_URL=http://127.0.0.1:17433"
in_out "with a separate home, so a local daemon is never read" "OPENRIG_HOME="
in_out "and the TUI is started by path, since rig tui has no --url" "tui/dist/main.js"
in_out "and step 1 of the talk is spelled out" "start DEMO-C"

printf '\n# running it again\n'
run_prepare
eq "prepare is safe to run twice" 0 "$RC"
eq "and the second run still remembers the ORIGINAL threshold, not the demo's" "30" "$(cat "$(record_file)" 2>/dev/null)"
in_err "it says it left the record alone" "already recorded"

printf '\n# taking it apart\n'
new_state
sed -i 's/^teams=.*/teams="t-demo-a t-demo-b t-foo-1"/; s/^threshold=.*/threshold=3/' "$DEMO_FAKE_STATE"
printf '30\n' > "$(record_file)"
run_cleanup
eq "cleanup succeeds" 0 "$RC"
in_calls "every demo team is archived before it goes" "rig-dispatch collect DEMO-A"
in_calls "and then deleted" "rig-dispatch delete DEMO-A"
in_calls "both of them" "rig-dispatch delete DEMO-B"
not_in_calls "a team that never existed is not deleted" "delete DEMO-C"
not_in_calls "and a team that is not the demo's is never touched" "t-foo-1"
in_calls "their volumes go too" "delete pvc -l openrig.dev/ticket=demo-a"
in_calls "the threshold goes back through the hub's own CLI" "config-set 30"
eq "the hub really has it back" "30" "$(state_get threshold)"
eq "and the record is spent" "missing" "$([ -f "$(record_file)" ] && echo there || echo missing)"
in_err "the foreign team is reported, not removed" "not the demo"

printf '\n# running cleanup again\n'
run_cleanup
eq "a second cleanup has nothing to do and still succeeds" 0 "$RC"
in_err "and says so" "no DEMO team to remove"

printf '\n# a team that is already broken\n'
new_state
sed -i 's/^teams=.*/teams="t-demo-a"/; s/^collect_fails=.*/collect_fails=1/; s/^hosts=.*/hosts=1/' "$DEMO_FAKE_STATE"
printf '30\n' > "$(record_file)"
run_cleanup
eq "cleanup still finishes when a team cannot be archived" 0 "$RC"
in_err "it says the archive could not be made" "collect failed"
in_calls "the team is deleted by force" "delete DEMO-A --force"
in_calls "and the hub's view is reconciled, because the registry still names a team that is gone" "rig-dispatch hub-sync"
new_state
sed -i 's/^teams=.*/teams="t-demo-a"/; s/^collect_fails=.*/collect_fails=1/' "$DEMO_FAKE_STATE"
printf '30\n' > "$(record_file)"
run_cleanup
eq "a forced delete that left nothing behind is not repaired twice" 0 "$RC"
not_in_calls "no hub-sync when the registry is already clean" "rig-dispatch hub-sync"

printf '\n# when the end state is not reached, it says so\n'
new_state
sed -i 's/^teams=.*/teams="t-demo-a"/' "$DEMO_FAKE_STATE"
printf '30\n' > "$(record_file)"
FAKE_DELETE_NOOP=1 run_cleanup
eq "a team that will not be deleted fails the run" 1 "$RC"
new_state
sed -i 's/^hosts=.*/hosts=1/' "$DEMO_FAKE_STATE"
FAKE_HUBSYNC_NOOP=1 run_cleanup
eq "so does a hub that still lists a team with nothing behind it" 1 "$RC"
in_err "and it names what is left" "registry is not back to empty"

printf '\n# B-1: a parked team is read from its queue row, not its result file\n'
# The defect this is here for. The dispatcher's completion contract tells the seat to write
# `needs-human` into the result file while it asks on the queue, and `probe` lets that file win, so the
# phase reads `result:needs-human` for a team that is waiting perfectly well. Waiting on the phase called
# that "finished without asking" and killed a rehearsal that was going fine.
new_state
sed -i 's/^phase_DEMO_A=.*/phase_DEMO_A=result:needs-human/' "$DEMO_FAKE_STATE"
run_prepare
eq "prepare accepts a parked team whose result file says needs-human" 0 "$RC"
not_in_err "and does not call it finished without asking" "never parked a question"
in_err "it says what it actually saw" "queue item parked on human@host"

# The other side: a team that finished and closed its row must still be refused, or the talk would open
# with no question on screen and the presenter would find out at step 3.
new_state
sed -i 's/^phase_DEMO_A=.*/phase_DEMO_A=result:done/; s/^open_DEMO_A=.*/open_DEMO_A=none/' "$DEMO_FAKE_STATE"
run_prepare
eq "a team that finished instead of asking still fails the run" 1 "$RC"
in_err "and it points at the brief" "briefs/DEMO-A.md"
not_in_err "without reporting the question as parked" "queue item parked on human@host"

# A row blocked on something that is not a human is not the demo's question either.
new_state
sed -i 's/^phase_DEMO_A=.*/phase_DEMO_A=working/; s/^open_DEMO_A=.*/open_DEMO_A=pending/' "$DEMO_FAKE_STATE"
run_prepare
eq "a team with an open item that is not parked is not 'waiting for a human'" 1 "$RC"

printf '\n# S-1: what a bare `kubectl delete statefulset` leaves behind\n'
# Run sheet step 7 deletes a StatefulSet with kubectl. The pod and the volume go; the Secret does not --
# only the dispatcher's own delete removes that. So "no StatefulSet" must not mean "nothing to do".
new_state
sed -i 's/^teams=.*/teams=""/; s/^secrets=.*/secrets="t-demo-c"/; s/^pvcs=.*/pvcs="home-t-demo-c-0"/' "$DEMO_FAKE_STATE"
printf '30\n' > "$(record_file)"
run_cleanup
eq "cleanup clears a team whose StatefulSet is already gone" 0 "$RC"
in_err "and says it is clearing residue, not a team" "Secret or volume is still there"
in_calls "by forcing the dispatcher's own delete" "rig-dispatch delete DEMO-C --force"
not_in_err "so the end state finds no leftover Secret" "demo Secrets are still there"

# And the end state has to SEE it, or a run that stopped at "no team is running" would call a namespace
# holding a live credential clean.
new_state
sed -i 's/^teams=.*/teams=""/; s/^secrets=.*/secrets="t-demo-c"/' "$DEMO_FAKE_STATE"
printf '30\n' > "$(record_file)"
FAKE_DELETE_NOOP=1 run_cleanup
eq "a Secret that will not go fails the run" 1 "$RC"
in_err "and names it as a Secret" "demo Secrets are still there"

printf '\n# S-2: a refused delete never skips the threshold restore\n'
# The trigger is ordinary: the dispatcher refuses to delete a team that moved on since its archive, which
# is what a team still working on stage looks like. Step 8 runs on stage, in front of people.
new_state
sed -i 's/^teams=.*/teams="t-demo-a t-demo-b"/; s/^threshold=.*/threshold=3/' "$DEMO_FAKE_STATE"
printf '30\n' > "$(record_file)"
FAKE_DELETE_NOOP=1 run_cleanup
eq "the run still fails, as it must" 1 "$RC"
in_calls "but the threshold went back anyway" "config-set 30"
eq "the hub really has it back after a failed run" "30" "$(state_get threshold)"
eq "and the record is spent, so a second run cannot mistake 3 for the original" "missing" \
  "$([ -f "$(record_file)" ] && echo there || echo missing)"
in_err "it tried each team, not just the first" "retrying once"
if [ "$(grep -c 'rig-dispatch delete DEMO-B' "$DEMO_FAKE_CALLS")" -ge 1 ]; then
  ok "and went on to the other team after the first was refused"
else bad "a refused delete stopped the loop before the other team"; fi

printf '\n# S-3: a hub that will not answer is never an empty registry\n'
new_state
sed -i 's/^hub_readable=.*/hub_readable=0/' "$DEMO_FAKE_STATE"
run_prepare
eq "prepare refuses to go ahead when the hub would not answer" 1 "$RC"
in_err "and says it could not read it, not that it was empty" "unreadable"
not_in_calls "so nothing was lowered on a hub it never read" "config-set"

new_state
sed -i 's/^teams=.*/teams="t-demo-a"/; s/^hub_readable=.*/hub_readable=0/' "$DEMO_FAKE_STATE"
printf '30\n' > "$(record_file)"
run_cleanup
eq "cleanup fails rather than declaring an unreadable hub clean" 1 "$RC"
in_err "and names the hub as unreadable" "unreadable"

# The fourth part of a registration: a host with no feed subscription is listed and shows no queue, so an
# end state that left one behind would be wrongly called clean. hub-sync is held off here so the check
# itself is what is under test, not the repair.
new_state
sed -i 's/^subs=.*/subs=1/' "$DEMO_FAKE_STATE"
printf '30\n' > "$(record_file)"
FAKE_HUBSYNC_NOOP=1 run_cleanup
eq "a leftover subscription is drift, not an empty registry" 1 "$RC"
in_calls "and hub-sync is what it calls in to repair it" "rig-dispatch hub-sync"
in_err "and the run says so with the count in it" "subs=1"

printf '\n# N-2: a file the hub never wrote is empty, not unreadable\n'
# The overcorrection to watch for: "a failed read is not empty" is right, and a file that does not exist is
# not a failed read. A fresh hub has no bindings file and maybe no config.json; treating absent as broken
# makes prepare.sh refuse to start and cleanup.sh fail forever on a perfectly clean cluster.
new_state
sed -i 's/^missing=.*/missing="config.json"/' "$DEMO_FAKE_STATE"
run_prepare
eq "prepare runs on a hub with no config.json" 0 "$RC"
not_in_err "and does not call the hub unreadable" "unreadable"

new_state
sed -i 's/^missing=.*/missing="host-bindings.json config.json"/' "$DEMO_FAKE_STATE"
printf '30\n' > "$(record_file)"
run_cleanup
eq "cleanup calls a hub with no bindings file and no config.json clean" 0 "$RC"
in_err "and says so with the counts, not a warning" "hosts=0 bearers=0 bindings=0 subs=0"

# The directory case is its own branch: hosts.d is a directory, so the guard is `[ -d ]`, and a hub that
# never registered anything may not have made it at all.
new_state
sed -i 's/^missing=.*/missing="hosts.d host-bindings.json config.json"/' "$DEMO_FAKE_STATE"
run_prepare
eq "a hub with no hosts.d directory at all is still an empty registry" 0 "$RC"
not_in_err "and nothing was called unreadable for it" "unreadable"

# The other side of the line: a file that IS there and cannot be parsed is still an error.
new_state
sed -i 's/^bad_json=.*/bad_json=1/' "$DEMO_FAKE_STATE"
printf '30\n' > "$(record_file)"
run_cleanup
eq "an existing file that is not JSON is still an error" 1 "$RC"
in_err "and it says which kind of failure it was" "not JSON"

printf '\n# N-3: global feed preferences are not registrations\n'
# feed.subscriptions holds actionRequired, approvals, shipped, progress and audit_log beside the per-host
# nodes. Counting every key there reads any hub with a feed preference set as permanently not-empty.
new_state
sed -i 's/^feed_prefs=.*/feed_prefs=1/' "$DEMO_FAKE_STATE"
run_prepare
eq "a hub with feed preferences set and no team is still an empty registry" 0 "$RC"
not_in_err "and prepare does not stop for it" "unreadable"

new_state
sed -i 's/^feed_prefs=.*/feed_prefs=1/; s/^subs=.*/subs=1/' "$DEMO_FAKE_STATE"
printf '30\n' > "$(record_file)"
FAKE_HUBSYNC_NOOP=1 run_cleanup
eq "a real host node counts even when preferences are set too" 1 "$RC"
in_err "and the count says one, not four" "subs=1"

printf '\n# the briefs carry the rules the scripts now depend on\n'
# These are here because the fixes live in prose, and prose is easy to trim back by accident. Each one is
# the reason a script check above passes or fails, so a brief that loses the line silently re-breaks the
# behaviour the script test cannot see on its own.
brief_has() { # <file> <needle> <what it is for>
  if grep -qi -- "$2" "$DEMO/briefs/$1"; then ok "$3"; else bad "$3 (no [$2] in $1)"; fi
}
brief_has DEMO-A.md "Do not write the result file" "B-1: a parked team leaves the result file alone"
brief_has DEMO-A.md "wake-after 4h" "B-2: the wake is armed past the talk, not inside it"
brief_has DEMO-A.md "still carries no" "B-2: a wake with no answer means stop, not choose"
brief_has DEMO-A.md "exactly two whitespace-separated fields" "B-4: option A names a real check, not an empty commit"
brief_has DEMO-B.md "as the only argument" "B-5: the help flag replaces the file argument"
brief_has DEMO-C.md "Part 2" "B-3: DEMO-C is sized to still be open at the stall step"
if grep -qE 'wake-after +30m' "$DEMO/briefs/DEMO-A.md"; then
  bad "B-2: no 30-minute wake is left anywhere in DEMO-A"
else ok "B-2: no 30-minute wake is left anywhere in DEMO-A"; fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAILED"
[ "$FAILED" = 0 ] || exit 1
