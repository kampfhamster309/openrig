#!/usr/bin/env bash
# hub-sync-test.sh -- exercises `rig-dispatch hub-sync` against ./fake-kubectl, so the hub's registry,
# its ownership rule and its lock are testable with no cluster and no hub pod.
#
#   bash deploy/kubernetes/dispatcher/test/hub-sync-test.sh
#
# The hub here is real state on disk, not a recorded answer. The dispatcher's own node scripts are
# really executed against it, `rig host add` refuses a duplicate id the way the real CLI does, and the
# registry lock is a real flock held by real background processes. That is deliberate: the thing under
# test is whether the code reads and writes the registry correctly, and a fake that simply answered
# "yes, it is registered" would leave the reader untested while the test still went green.
#
# One line per check on stdout; exits non-zero if any check failed.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
DISPATCH="$HERE/../rig-dispatch"
FIXTURES="$HERE/fixtures"
[ -f "$DISPATCH" ] || { echo "no rig-dispatch at $DISPATCH" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required: the hub's registry scripts are node scripts" >&2; exit 1; }
command -v flock >/dev/null 2>&1 || { echo "flock is required: the registry lock is a real one here" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"; NPM="$WORK/npmroot"
mkdir -p "$BIN" "$NPM/@openrig/cli/node_modules/yaml"
cp "$HERE/fake-kubectl" "$BIN/kubectl"
cp "$HERE/fake-kubectl" "$WORK/fake-kubectl"
chmod +x "$BIN/kubectl" "$WORK/fake-kubectl" "$HERE/fake-kubectl"
export FAKE_SELF="$WORK/fake-kubectl"

# The lock wrapper runs its command as a plain command line, so the hub's own `rig` has to answer from
# PATH. Without this the real rig on this machine would answer it, against the real daemon. Never that.
cat >"$BIN/rig" <<'SH'
#!/usr/bin/env bash
exec "$FAKE_SELF" hub-rig "$@"
SH
chmod +x "$BIN/rig"

# JSON is a subset of YAML, and the dispatcher only ever round-trips the registry through this same
# parser, so a JSON-backed stand-in for the hub's `yaml` dependency is faithful where it matters.
cat >"$NPM/@openrig/cli/node_modules/yaml/index.js" <<'JS'
module.exports = {
  parse: (t) => (String(t).trim() === "" ? null : JSON.parse(t)),
  stringify: (o) => JSON.stringify(o, null, 2) + "\n",
};
JS
cat >"$NPM/@openrig/cli/node_modules/yaml/package.json" <<'JS'
{ "name": "yaml", "version": "0.0.0-fake", "main": "index.js" }
JS

export PATH="$BIN:$PATH"
export FAKE_FIXTURES=$FIXTURES
export FAKE_NPM_ROOT=$NPM
export FAKE_STS_LIST=hub-sync-statefulsets.json
export FAKE_POD_LIST=hub-sync-pods.json

PASS=0
FAILED=0
ok() { printf '  ok    %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; FAILED=$((FAILED + 1)); }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2], got [$3])"; fi; }
in_out() {
  if grep -q -- "$2" "$OUT"; then ok "$1"; else bad "$1 (no [$2] in stdout: $(head -c 400 "$OUT"))"; fi
}
in_err() {
  if grep -q -- "$2" "$ERR"; then ok "$1"; else bad "$1 (no [$2] in stderr: $(head -c 400 "$ERR"))"; fi
}
not_in_out() {
  if grep -q -- "$2" "$OUT"; then bad "$1 (found [$2] in stdout)"; else ok "$1"; fi
}

# --- the hub as state ---------------------------------------------------------------------------

# The path the dispatcher names. The fake maps it onto $HUB, which is somewhere this test may write.
HUB_REAL=/home/openrig/.openrig
HUB=""

new_hub() { # new_hub <drift|stale-only|orphan|orphan-sub|borrowed|empty> -- a fresh hub home for one case
  HUB="$WORK/hub-$1-$$"
  rm -rf "$HUB"; mkdir -p "$HUB/hosts.d"
  export FAKE_HUB_HOME="$HUB"
  printf '{}\n' >"$HUB/config.json"
  printf '{"version":1,"bindings":{}}\n' >"$HUB/host-bindings.json"
  printf '{"hosts":[]}\n' >"$HUB/hosts.yaml"
  case "$1" in
    drift)
      # Seven entries, and each one is here to be treated differently:
      #   t-incomplete   right url and bearer path, but the bearer file is gone and the subscription is off
      #   t-wrongurl     url and bearer path are not what start writes
      #   t-stale        exactly what start wrote, and no team StatefulSet behind it
      #   t-ghost        a t- id that borrowed the naming but points at a laptop: not ours
      #   laptop         a hand-made entry in every way: not ours
      #   t-emptybearer  the entry is right and the file is there, but empty: the hub cannot dial it
      #   t-oldbearer    the file is there and full, but holds a bearer the Secret no longer holds
      cat >"$HUB/hosts.yaml" <<YAML
{"hosts":[
 {"id":"t-incomplete","transport":"http","url":"http://t-incomplete-0.teams.openrig.svc:7433","bearer_file":"$HUB_REAL/hosts.d/t-incomplete.bearer","notes":"ticket INCOMPLETE-1, rig demo-rig"},
 {"id":"t-wrongurl","transport":"http","url":"http://t-wrongurl-0.teams.openrig.svc:9999","bearer_file":"$HUB_REAL/hosts.d/old-name.bearer","notes":"ticket WRONGURL-1, rig demo-rig"},
 {"id":"t-stale","transport":"http","url":"http://t-stale-0.teams.openrig.svc:7433","bearer_file":"$HUB_REAL/hosts.d/t-stale.bearer","notes":"ticket GONE-1, rig demo-rig"},
 {"id":"t-ghost","transport":"http","url":"http://laptop.internal:7433","bearer_file":"$HUB_REAL/hosts.d/t-ghost.bearer","notes":"made by hand, name only looks like a team"},
 {"id":"laptop","transport":"ssh","target":"me@laptop.internal","notes":"made by hand"},
 {"id":"t-emptybearer","transport":"http","url":"http://t-emptybearer-0.teams.openrig.svc:7433","bearer_file":"$HUB_REAL/hosts.d/t-emptybearer.bearer","notes":"ticket EMPTYBEARER-1, rig demo-rig"},
 {"id":"t-oldbearer","transport":"http","url":"http://t-oldbearer-0.teams.openrig.svc:7433","bearer_file":"$HUB_REAL/hosts.d/t-oldbearer.bearer","notes":"ticket OLDBEARER-1, rig demo-rig"}
]}
YAML
      printf 'old bearer\n' >"$HUB/hosts.d/old-name.bearer"
      printf 'stale bearer\n' >"$HUB/hosts.d/t-stale.bearer"
      printf 'ghost bearer\n' >"$HUB/hosts.d/t-ghost.bearer"
      : >"$HUB/hosts.d/t-emptybearer.bearer"
      printf 'a bearer from before the Secret changed\n' >"$HUB/hosts.d/t-oldbearer.bearer"
      cat >"$HUB/config.json" <<JSON
{"feed":{"subscriptions":{
 "t-incomplete":{"enabled":false},
 "t-wrongurl":{"enabled":true},
 "t-stale":{"enabled":true},
 "t-emptybearer":{"enabled":true},
 "t-oldbearer":{"enabled":true}}}}
JSON
      printf '{"version":1,"bindings":{"t-stale":{"hostId":"t-stale","alias":"gone"},"laptop":{"hostId":"laptop","alias":"mine"}}}\n' \
        >"$HUB/host-bindings.json"
      ;;
    stale-only)
      # Just the one stale entry, for the lock cases: fewer edits, so a held lock shows up fast.
      cat >"$HUB/hosts.yaml" <<YAML
{"hosts":[
 {"id":"t-stale","transport":"http","url":"http://t-stale-0.teams.openrig.svc:7433","bearer_file":"$HUB_REAL/hosts.d/t-stale.bearer","notes":"ticket GONE-1, rig demo-rig"}
]}
YAML
      printf 'stale bearer\n' >"$HUB/hosts.d/t-stale.bearer"
      printf '{"feed":{"subscriptions":{"t-stale":{"enabled":true}}}}\n' >"$HUB/config.json"
      printf '{"version":1,"bindings":{"t-stale":{"hostId":"t-stale","alias":"gone"}}}\n' >"$HUB/host-bindings.json"
      ;;
    orphan)
      # What a half-finished delete leaves behind. `hub_unregister` is three independent steps: the
      # hosts.yaml entry went (step 1 succeeded) and the parts behind it did not. Nothing in hosts.yaml
      # points at them any more, so only their own names say whose they were.
      printf 'gone bearer\n' >"$HUB/hosts.d/t-gone.bearer"
      printf 'a hand-made file for a hand-made host\n' >"$HUB/hosts.d/friend.bearer"
      cat >"$HUB/config.json" <<JSON
{"feed":{"subscriptions":{"t-gone":{"enabled":true},"friend":{"enabled":true}}}}
JSON
      printf '{"version":1,"bindings":{"t-gone":{"hostId":"t-gone","alias":"gone"},"friend":{"hostId":"friend","alias":"pal"}}}\n' \
        >"$HUB/host-bindings.json"
      ;;
    orphan-sub)
      # The harder shape: the bearer removal succeeded too, so no file and no alias names the host at
      # all. Only the settings node is left, and nothing but the settings can say it exists.
      printf '{"feed":{"subscriptions":{"t-quiet":{"enabled":true}}}}\n' >"$HUB/config.json"
      ;;
    borrowed)
      # A hand-made host that borrowed the dispatcher's file naming. Nothing here is the dispatcher's:
      # the entry is one a person wrote, and the token it dials with lives in a file named exactly like
      # a team's. An orphan pass that asked only "is there an entry called t-foo?" calls that file a
      # leftover and deletes the credential, and t-bar is the same mistake one part over: an alias no
      # entry holds, but whose binding points at one that does.
      cat >"$HUB/hosts.yaml" <<YAML
{"hosts":[
 {"id":"laptop","transport":"http","url":"http://laptop.internal:7433","bearer_file":"$HUB_REAL/hosts.d/t-foo.bearer","notes":"made by hand"}
]}
YAML
      printf 'the token of a hand-made host' >"$HUB/hosts.d/t-foo.bearer"
      printf '{"feed":{"subscriptions":{"laptop":{"enabled":true}}}}\n' >"$HUB/config.json"
      printf '{"version":1,"bindings":{"t-bar":{"hostId":"laptop","alias":"team"},"laptop":{"hostId":"laptop","alias":"mine"}}}\n' \
        >"$HUB/host-bindings.json"
      ;;
  esac
}

# What the registry says now, read straight off the files the hub keeps.
entry_of() { jq -c --arg id "$1" '.hosts[]? | select(.id == $id)' "$HUB/hosts.yaml"; }
field_of() { entry_of "$1" | jq -r ".${2} // \"\"" ; }
has_entry() { [ -n "$(entry_of "$1")" ]; }
bearer_on_disk() { [ -f "$HUB/hosts.d/$1.bearer" ]; }
sub_of() {
  jq -r --arg h "$1" '(.feed.subscriptions // {}) as $s
    | if ($s | has($h)) then ($s[$h].enabled | tostring) else "unset" end' "$HUB/config.json"
}
binding_of() { jq -r --arg a "$1" '.bindings[$a].alias // "none"' "$HUB/host-bindings.json"; }
snapshot() { (cd "$HUB" && find . -type f | sort | xargs cksum) ; }

# run_sync <name> [hub-sync args...] -- runs the command and reports through RC, OUT, ERR.
run_sync() {
  local name=$1; shift
  export FAKE_CALLS="$WORK/$name.calls"; : >"$FAKE_CALLS"
  local t0=$SECONDS
  # </dev/null: the dispatcher's own stdin, not the plan it reads internally. A hub call that drained
  # the caller would otherwise eat whatever the test had on stdin, which is not what is under test.
  ( cd "$WORK" && env KUBECTL=kubectl RIG_DISPATCH_NAMESPACE=openrig "$DISPATCH" hub-sync "$@" </dev/null ) \
    >"$WORK/$name.out" 2>"$WORK/$name.err"
  RC=$?; ELAPSED=$((SECONDS - t0))
  OUT="$WORK/$name.out"; ERR="$WORK/$name.err"
}

echo "hub-sync-test"

# --- 1: every kind of drift, repaired -----------------------------------------------------------
echo "the repair pass"
new_hub drift
GHOST_BEFORE=$(entry_of t-ghost); LAPTOP_BEFORE=$(entry_of laptop)
run_sync repair
eq "a registry that needed repairing exits 0" 0 "$RC"
in_out "it found the stale entry" "stale.*t-stale"
in_out "it found the missing team" "missing.*t-missing"
in_out "it found the incomplete team" "incomplete.*t-incomplete"
in_out "it left the not-yet-handed-over team alone" "skip.*t-nohandover"
in_out "it said why: no ticket handed over" "no ticket handed over"
in_out "it left the not-Ready team alone" "skip.*t-notready"
in_out "it said why: the pod is not Ready" "not Ready"
in_out "it reported the hand-made host as not its own" "foreign.*laptop"
in_out "it reported the borrowed t- id as not its own" "foreign.*t-ghost"
in_out "it found the team whose bearer file is empty" "incomplete.*t-emptybearer"
in_out "it said why: the file is not what the Secret holds" "not what secret t-emptybearer holds"
in_out "it found the team whose bearer file is out of date" "incomplete.*t-oldbearer"
in_out "it ended by matching" "matches the teams"

if has_entry t-stale; then bad "the stale entry is gone from hosts.yaml"; else ok "the stale entry is gone from hosts.yaml"; fi
if bearer_on_disk t-stale; then bad "the stale bearer file is gone"; else ok "the stale bearer file is gone"; fi
eq "the stale subscription setting is gone" unset "$(sub_of t-stale)"
eq "the stale binding alias is gone" none "$(binding_of t-stale)"
# The unregister is preceded by a re-check that the team really is gone, and that check has to be able
# to tell "not there" from "could not ask". `--ignore-not-found -o name` is what makes them different
# answers, so the call is part of the behaviour worth pinning.
if grep -q 'get statefulset t-stale --ignore-not-found -o name' "$FAKE_CALLS"; then
  ok "the pre-unregister re-check asks in a form that tells NotFound from an error"
else
  bad "the pre-unregister re-check asks in a form that tells NotFound from an error"
fi

eq "the missing team is registered" "http://t-missing-0.teams.openrig.svc:7433" "$(field_of t-missing url)"
eq "with the bearer path start writes" "$HUB_REAL/hosts.d/t-missing.bearer" "$(field_of t-missing bearer_file)"
if bearer_on_disk t-missing; then ok "and the bearer file is on the hub"; else bad "and the bearer file is on the hub"; fi
eq "and the subscription is on" true "$(sub_of t-missing)"

if bearer_on_disk t-incomplete; then ok "the incomplete team got its bearer file back"; else bad "the incomplete team got its bearer file back"; fi
eq "and its subscription turned on" true "$(sub_of t-incomplete)"

eq "the wrong url was rewritten" "http://t-wrongurl-0.teams.openrig.svc:7433" "$(field_of t-wrongurl url)"
eq "and the wrong bearer path with it" "$HUB_REAL/hosts.d/t-wrongurl.bearer" "$(field_of t-wrongurl bearer_file)"
if bearer_on_disk t-wrongurl; then ok "and the bearer file it names exists"; else bad "and the bearer file it names exists"; fi

# An entry can name the right file and still be unable to dial the team, because the bytes in it are
# empty or belong to a Secret that has since changed. Existence is not enough; the contents are checked
# against the Secret and rewritten from it.
eq "the empty bearer was rewritten from the team's Secret" \
  "bearer-for-t-emptybearer" "$(cat "$HUB/hosts.d/t-emptybearer.bearer")"
eq "the outdated bearer was rewritten from it too" \
  "bearer-for-t-oldbearer" "$(cat "$HUB/hosts.d/t-oldbearer.bearer")"

if has_entry t-nohandover; then bad "a team with no ticket handed over is not registered"; else ok "a team with no ticket handed over is not registered"; fi
if has_entry t-notready; then bad "a team whose pod is not Ready is not registered"; else ok "a team whose pod is not Ready is not registered"; fi

eq "a hand-made host survives untouched" "$LAPTOP_BEFORE" "$(entry_of laptop)"
eq "with its alias" mine "$(binding_of laptop)"
eq "and a t- id that only borrows the naming survives untouched" "$GHOST_BEFORE" "$(entry_of t-ghost)"
if bearer_on_disk t-ghost; then ok "with its bearer file"; else bad "with its bearer file"; fi

# Every registry edit has to be the locked one. `start` and `delete` share these two helpers, so what
# this shows about hub_register and hub_unregister is what it shows about them.
if grep -q 'flock -w' "$FAKE_CALLS"; then ok "the edits went through the lock"; else bad "the edits went through the lock"; fi
LOCKS=$(grep -c 'flock -w' "$FAKE_CALLS")
if [ "$LOCKS" -ge 6 ]; then ok "both directions are locked ($LOCKS locked edits)"; else bad "both directions are locked ($LOCKS locked edits)"; fi

# A dry run over a registry that already matches has nothing to report and exits 0. It runs here, on the
# hub the pass above just brought into step, because that is the only place a matching registry exists.
run_sync dry-clean --dry-run
eq "a dry run over a registry that already matches exits 0" 0 "$RC"
in_out "and says so" "nothing to do"

# --- 2: a second run does nothing ---------------------------------------------------------------
echo "running it twice"
BEFORE=$(snapshot)
run_sync again
eq "the second run exits 0" 0 "$RC"
eq "and changes nothing at all" "$BEFORE" "$(snapshot)"
in_out "and says there was nothing to do" "matches the teams"
not_in_out "and does not register anything a second time" "registering it"
not_in_out "and does not unregister anything a second time" "unregistering it"

# --- 3: --dry-run -------------------------------------------------------------------------------
echo "dry run"
new_hub drift
BEFORE=$(snapshot)
run_sync dry --dry-run
eq "a dry run over drift exits non-zero, because drift is what it found" 1 "$RC"
eq "and changed nothing" "$BEFORE" "$(snapshot)"
in_out "and says what it would have done" "would unregistering it"
in_out "and names the stale entry" "stale.*t-stale"
if grep -q 'rig host add' "$FAKE_CALLS"; then bad "a dry run never writes to the registry"; else ok "a dry run never writes to the registry"; fi

# --- 4: no Ready hub pod ------------------------------------------------------------------------
echo "no Ready hub"
new_hub drift
BEFORE=$(snapshot)
RC=0
export FAKE_NO_HUB=1
run_sync nohub
unset FAKE_NO_HUB
eq "with no Ready hub it exits non-zero" 3 "$RC"
eq "and touched nothing" "$BEFORE" "$(snapshot)"
in_out "and says the hub is what is missing" "no Ready hub pod"
in_out "and points at the command to run later" "hub-sync"
if grep -q 'exec -i hub-0' "$FAKE_CALLS"; then bad "with no hub it does not even try to edit it"; else ok "with no hub it does not even try to edit it"; fi

# --- 5: the lock --------------------------------------------------------------------------------
echo "the registry lock"
# The lock cases want one edit and nothing else, so the cluster here has no teams: what is left is the
# single stale entry, whose unregister is three locked steps. Timings stay small enough to trust.
export FAKE_STS_LIST=hub-sync-no-teams.json FAKE_POD_LIST=hub-sync-no-pods.json
new_hub stale-only
# Hold the lock on our own descriptor, start the run in the background, and release only once the run
# has reached the lock and is still blocked on it. No clock is part of the assertion: a run that did not
# honour the lock would finish its edit while we hold it, and that is what is checked. The run gets fd 8
# closed, because a child that inherits it shares this lock and would keep it held after we let go.
exec 8>"$HUB/.registry.lock"
flock -w 5 8
export FAKE_CALLS="$WORK/lock-wait.calls"; : >"$FAKE_CALLS"
( cd "$WORK" && env KUBECTL=kubectl RIG_DISPATCH_NAMESPACE=openrig "$DISPATCH" hub-sync </dev/null ) \
  >"$WORK/lock-wait.out" 2>"$WORK/lock-wait.err" 8>&- &
SYNC=$!
n=0
until grep -q 'flock -w' "$FAKE_CALLS" || [ "$n" -ge 400 ]; do sleep 0.05; n=$((n + 1)); done
sleep 0.5
if kill -0 "$SYNC" 2>/dev/null && has_entry t-stale; then
  ok "an edit waits while another holds the lock"
else
  bad "an edit waits while another holds the lock"
fi
exec 8>&-
wait "$SYNC"; RC=$?
OUT="$WORK/lock-wait.out"; ERR="$WORK/lock-wait.err"
eq "and once the lock is free it still gets done" 0 "$RC"
if has_entry t-stale; then bad "and it still made the repair"; else ok "and it still made the repair"; fi

new_hub stale-only
# Hold the lock on our own file descriptor rather than in a background process that sleeps: three edits
# at a 1s timeout each take 3s in a quiet test and longer under load, and a fixed sleep would let the
# last one slip through and make this check fail for the wrong reason. The lock is simply held for the
# whole check and released after it.
exec 8>"$HUB/.registry.lock"
flock -w 5 8
RC=0
export RIG_DISPATCH_HUB_LOCK_TIMEOUT=1
run_sync lock-timeout
unset RIG_DISPATCH_HUB_LOCK_TIMEOUT
exec 8>&-
if [ "$RC" = 0 ]; then bad "a lock held past the timeout fails the run"; else ok "a lock held past the timeout fails the run"; fi
in_err "and says someone else holds the hub, not that the edit failed" "registry lock"
in_err "and says how long it waited" "1s"
# Every step of the unregister gave up on the same lock, so the point is that nothing was half-done:
# a registry edit that could not start is not allowed to leave the registry in a new state.
if has_entry t-stale; then ok "and leaves the entry exactly as it was"; else bad "and leaves the entry exactly as it was"; fi
if bearer_on_disk t-stale; then ok "with its bearer file"; else bad "with its bearer file"; fi
eq "and its subscription" true "$(sub_of t-stale)"
eq "and its alias" gone "$(binding_of t-stale)"
unset FAKE_STS_LIST FAKE_POD_LIST

# --- 6: a cluster read that failed is not a cluster with no teams ---------------------------------
echo "a cluster read that failed"
# The destructive case. An empty team list makes every dispatcher-shaped entry look stale, and the run
# would unregister every live team and then exit 0 saying the registry matches. A read that did not
# answer has to stop the run instead of answering for it.
new_hub drift
BEFORE=$(snapshot)
# The drift cluster and hub, so a run that wrongly believed the read had answered would have real teams
# to unregister and a real registry to say a match about.
export FAKE_STS_LIST=hub-sync-statefulsets.json FAKE_POD_LIST=hub-sync-pods.json
RC=0
export FAKE_FAIL_STS_LIST=1
run_sync sts-read-failed
unset FAKE_FAIL_STS_LIST
eq "a failed StatefulSet read fails the run" 1 "$RC"
eq "and touched nothing at all" "$BEFORE" "$(snapshot)"
in_err "and names the read that failed" "could not read the team StatefulSets"
in_err "and says nothing was changed" "nothing was changed"
not_in_out "and does not claim the registry matches" "matches the teams"
if grep -q 'rig host add\|config set\|config reset\|rm -f' "$FAKE_CALLS"; then
  bad "a read that failed writes nothing to the hub"
else
  ok "a read that failed writes nothing to the hub"
fi

RC=0
export FAKE_FAIL_POD_LIST=1
run_sync pod-read-failed
unset FAKE_FAIL_POD_LIST
eq "a failed pod read fails the run too" 1 "$RC"
eq "and touched nothing at all" "$BEFORE" "$(snapshot)"
in_err "and names the read that failed" "could not read the team pods"
unset FAKE_STS_LIST FAKE_POD_LIST

# --- 7: the cluster moved while the run was working -----------------------------------------------
echo "the cluster moved mid-run"
# The plan is a snapshot, and a `delete` and a `start` of the same ticket can put a StatefulSet back
# after the run decided to unregister it. Unregistering a team that exists again is the damage this
# command must never do, so the StatefulSet is checked again before the removal and the final judgement
# is made from a fresh read rather than from a snapshot that has gone stale.
export FAKE_STS_LIST=hub-sync-no-teams.json FAKE_POD_LIST=hub-sync-no-pods.json
export FAKE_STS_LIST2=hub-sync-stale-back.json FAKE_POD_LIST2=hub-sync-stale-back-pods.json
export FAKE_STS_EXISTS=t-stale
new_hub stale-only
# What `start` would have written when the team came back, so the fresh read finds a team that is simply
# registered rather than one that still needs something done to it.
printf 'bearer-for-t-stale' >"$HUB/hosts.d/t-stale.bearer"
run_sync came-back
unset FAKE_STS_LIST FAKE_POD_LIST FAKE_STS_LIST2 FAKE_POD_LIST2 FAKE_STS_EXISTS
eq "a team whose StatefulSet came back is left registered" 0 "$RC"
in_out "and says it was left alone" "left alone: its team StatefulSet is back"
in_out "and ends by matching, on the fresh read" "matches the teams"
if has_entry t-stale; then ok "with its entry"; else bad "with its entry"; fi
if bearer_on_disk t-stale; then ok "with its bearer file"; else bad "with its bearer file"; fi
eq "and with its subscription" true "$(sub_of t-stale)"

# The re-check can fail for its own reason -- throttled, refused, a server that would not answer -- and
# a read that did not answer is not a StatefulSet that is gone. Treating it as gone would unregister a
# team that is sitting right there, which is the one mistake this command must never make, so an
# unanswered check leaves the registration alone and says that nobody knows.
export FAKE_STS_LIST=hub-sync-no-teams.json FAKE_POD_LIST=hub-sync-no-pods.json
new_hub stale-only
RC=0
export FAKE_FAIL_STS_GET=1
run_sync recheck-failed
unset FAKE_FAIL_STS_GET
if [ "$RC" = 0 ]; then bad "a re-check that failed does not let the run claim a match"; else ok "a re-check that failed does not let the run claim a match"; fi
in_out "and it says the check could not be made" "could not be checked again"
in_err "and it names the StatefulSet and the server's own words" "could not re-check t-stale"
in_out "and it does not pretend the registry matches" "difference(s) still stand"
if has_entry t-stale; then ok "and the entry is left registered"; else bad "and the entry is left registered"; fi
if bearer_on_disk t-stale; then ok "with its bearer file"; else bad "with its bearer file"; fi
unset FAKE_STS_LIST FAKE_POD_LIST

# --- 8: the parts of a registration with no entry to hang them on ---------------------------------
echo "leftovers with no entry"
# A delete that failed after its first step leaves the bearer file, the subscription and the alias with
# no hosts.yaml entry pointing at them, and a pass that walks hosts.yaml never sees them -- so the run
# called the registry clean over the top of them. It has to find them from the parts themselves and
# finish the unregister, and still leave a hand-made part alone.
export FAKE_STS_LIST=hub-sync-no-teams.json FAKE_POD_LIST=hub-sync-no-pods.json
new_hub orphan
run_sync orphans
eq "cleaning the leftovers exits 0" 0 "$RC"
in_out "and it found them" "stale.*t-gone"
in_out "and said which part gave them away" "bearer file.*t-gone.bearer"
if bearer_on_disk t-gone; then bad "the leftover bearer file is gone"; else ok "the leftover bearer file is gone"; fi
eq "the leftover subscription is gone" unset "$(sub_of t-gone)"
eq "and the leftover alias is gone" none "$(binding_of t-gone)"
if bearer_on_disk friend; then ok "a hand-made bearer file with no entry is left alone"; else bad "a hand-made bearer file with no entry is left alone"; fi
eq "and a hand-made subscription is left alone" true "$(sub_of friend)"
eq "and a hand-made alias is left alone" pal "$(binding_of friend)"

# The harder shape: the bearer removal succeeded as well, so no file and no alias names the host and
# only the settings can say it is still there at all.
new_hub orphan-sub
run_sync orphan-sub
eq "a subscription nothing else points at is found too" 0 "$RC"
in_out "and named" "stale.*t-quiet"
eq "and removed" unset "$(sub_of t-quiet)"
unset FAKE_STS_LIST FAKE_POD_LIST

# --- 8b: a hand-made host whose parts are named like a team's -------------------------------------
echo "a hand-made host that borrowed the file naming"
# The orphan pass asks about parts, not entries, so the ownership question has to be asked of the part
# too: which entry claims this name? An entry claims the id it holds, the bearer file it points at, and
# the alias whose binding points back at it -- those are exactly the things an unregister of that name
# would remove. Ask only about the id and a hand-made host that keeps its token in a file called
# t-foo.bearer loses the token, and the run reports a match while it does it.
export FAKE_STS_LIST=hub-sync-no-teams.json FAKE_POD_LIST=hub-sync-no-pods.json
new_hub borrowed
LAPTOP_BEFORE=$(entry_of laptop)
run_sync borrowed
eq "a borrowed name is not a leftover" 0 "$RC"
in_out "and the hand-made entry is reported as not its own" "foreign.*laptop"
in_out "and it ends by matching" "matches the teams"
not_in_out "and nothing at all is called stale" "stale"
in_out "and it says who the borrowed bearer file belongs to" "t-foo.*bearer file.*is what entry laptop dials with"
in_out "and who the borrowed alias belongs to" "t-bar.*alias points at entry laptop"
if bearer_on_disk t-foo; then ok "the hand-made bearer file survives"; else bad "the hand-made bearer file survives"; fi
eq "with its token still in it" "the token of a hand-made host" "$(cat "$HUB/hosts.d/t-foo.bearer")"
eq "and the alias whose binding points at the entry survives" "team" "$(binding_of t-bar)"
eq "and the entry itself is untouched" "$LAPTOP_BEFORE" "$(entry_of laptop)"
eq "and its subscription is untouched" true "$(sub_of laptop)"
unset FAKE_STS_LIST FAKE_POD_LIST

# --- 9: sourcing the dispatcher defines the helpers and runs nothing --------------------------------
echo "sourcing rig-dispatch"
# The file used to end in `[ $# -ge 1 ] || usage`, so sourcing it to reach one helper died in `usage`
# before the second command ever ran. The dispatch block runs only when the file is executed.
: >"$WORK/source.calls"
( cd "$WORK" && env KUBECTL=kubectl RIG_DISPATCH_NAMESPACE=openrig FAKE_FIXTURES="$FIXTURES" \
    FAKE_CALLS="$WORK/source.calls" \
    bash -c "source '$DISPATCH'; for f in hub_register hub_unregister sync_plan cmd_hub_sync hub_inspect; do declare -F \"\$f\" >/dev/null || exit 1; done" ) \
  >"$WORK/source.out" 2>"$WORK/source.err"
SRC_RC=$?
eq "sourcing it defines the helpers and returns 0" 0 "$SRC_RC"
eq "and runs no kubectl call at all" 0 "$(grep -c . "$WORK/source.calls")"
if [ -s "$WORK/source.out" ]; then
  bad "and prints nothing (got: $(head -c 120 "$WORK/source.out"))"
else
  ok "and prints nothing"
fi

# --- 10: nothing that writes was left outside the lock ---------------------------------------------
echo "every writer is locked"
# A test can show a lock working; only a source check shows that nothing was left out of it.
bare_mutation() { # <pattern> <description>
  if grep -q "hub_exec .*$1" "$DISPATCH"; then bad "$2"; else ok "$2"; fi
}
bare_mutation 'rig host add' "the hub's host add is not run bare"
bare_mutation 'rig config set' "the hub's config set is not run bare"
bare_mutation 'rig config reset' "the hub's config reset is not run bare"
bare_mutation 'rm -f' "the bearer removal is not run bare"
bare_mutation 'sh -c "umask' "the bearer write is not run bare"
if grep -q '| "\$runner" env NPM_ROOT' "$DISPATCH"; then
  ok "the registry rewrite picks the locked runner"
else
  bad "the registry rewrite picks the locked runner"
fi
if grep -q 'HUB_MODE=has' "$DISPATCH"; then
  ok "a read of the registry needs no lock, and says so"
else
  bad "a read of the registry needs no lock, and says so"
fi

printf '\nhub-sync-test: %d passed, %d failed\n' "$PASS" "$FAILED"
[ "$FAILED" = 0 ] || exit 1
exit 0
