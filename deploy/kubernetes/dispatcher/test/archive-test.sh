#!/usr/bin/env bash
# archive-test.sh -- exercises `rig-dispatch archive` against ./fake-kubectl, so the archive, its
# manifest and its paging are testable with no cluster and no pod.
#
#   bash deploy/kubernetes/dispatcher/test/archive-test.sh
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
jqis() { # jqis <desc> <file> <jq filter> <expected>
  local got
  got=$(jq -r "$3" "$2" 2>/dev/null)
  eq "$1" "$4" "$got"
}
present() { if [ -e "$1" ]; then ok "$2"; else bad "$2 (no $1)"; fi; }
absent() { if [ ! -e "$1" ]; then ok "$2"; else bad "$2 ($1 should not exist)"; fi; }
in_calls() { # in_calls <desc> <pattern>
  if grep -q -- "$2" "$CALLS"; then ok "$1"; else bad "$1 (no [$2] in the recorded calls)"; fi
}
in_err() { # in_err <desc> <pattern> -- dispatcher log lines go to stderr
  if grep -q -- "$2" "$ERR"; then ok "$1"; else bad "$1 (no [$2] in stderr: $(head -c 200 "$ERR"))"; fi
}
not_in_calls() { # not_in_calls <desc> <pattern>
  if grep -q -- "$2" "$CALLS"; then bad "$1 (found [$2] in the recorded calls)"; else ok "$1"; fi
}

# run_archive <case> <archive-root> [ENV=VALUE...] -- run `rig-dispatch archive DEMO --dir <root>`
# against the fake and report through RC (exit code), DIR (<root>/demo) and CALLS (the call log).
run_archive() {
  local name=$1 root=$2
  shift 2
  mkdir -p "$root"
  CALLS="$WORK/$name.calls"
  : > "$CALLS"
  export FAKE_CALLS=$CALLS
  ( cd "$root" && env "$@" KUBECTL=kubectl RIG_DISPATCH_NAMESPACE=openrig \
      "$DISPATCH" archive DEMO --dir "$root" ) >"$WORK/$name.out" 2>"$WORK/$name.err"
  RC=$?
  DIR="$root/demo"
}

# run_dispatch <case> [ENV=VALUE...] -- <args...> -- run rig-dispatch against the fake and report
# through RC, plus $WORK/<case>.out and .err for the assertions.
run_dispatch() {
  local name=$1; shift
  local -a envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  CALLS="$WORK/$name.calls"
  : > "$CALLS"
  export FAKE_CALLS=$CALLS
  OUT="$WORK/$name.out"
  ERR="$WORK/$name.err"
  if [ "${#envs[@]}" -gt 0 ]; then
    ( cd "$WORK" && env "${envs[@]}" KUBECTL=kubectl RIG_DISPATCH_NAMESPACE=openrig \
        "$DISPATCH" "$@" ) >"$OUT" 2>"$ERR"
  else
    ( cd "$WORK" && env KUBECTL=kubectl RIG_DISPATCH_NAMESPACE=openrig \
        "$DISPATCH" "$@" ) >"$OUT" 2>"$ERR"
  fi
  RC=$?
}

echo "== a complete ticket"
run_archive complete "$WORK/complete"
eq "archive exits 0" 0 "$RC"
present "$DIR/manifest.json" "manifest.json is written"
jqis "the manifest says the archive is complete" "$DIR/manifest.json" '.complete' true
jqis "the ticket key came from the pod" "$DIR/manifest.json" '.ticket' DEMO-1
jqis "the directory is named by the slug" "$DIR/manifest.json" '.slug' demo
present "$DIR/status.json" "status.json"
present "$DIR/nodes.json" "nodes.json"
jqis "queue.json holds every row in the pod" "$DIR/queue.json" 'length' 5
jqis "a row another ticket owns is still archived" "$DIR/queue.json" '[.[].qitemId] | index("qitem-unrelated")' 2
jqis "the events watermark the archive saw is recorded for the delete guard" "$DIR/manifest.json" '.watermarks.events' "3"
jqis "and the transitions watermark too" "$DIR/manifest.json" '.watermarks.transitions' "5"
jqis "the incarnation is the pod this archive describes" "$DIR/manifest.json" '.incarnation' "2026-10-23T20:00:00Z"
jqis "events were paged to the end" "$DIR/events.json" '.rows | length' 3
jqis "events took two pages" "$DIR/events.json" '.pages' 2
jqis "the coverage gap the daemon reported is kept" "$DIR/events.json" '[.gaps[].code] | index("historical_events_not_read")' 0
jqis "transitions were paged to the end" "$DIR/queue-transitions.json" '.rows | length' 5
jqis "transitions took two pages" "$DIR/queue-transitions.json" '.pages' 2
jqis "audit rows for qitem-a were paged" "$DIR/audit-qitem-a.json" '.rows | length' 3
jqis "the audit read took two pages" "$DIR/audit-qitem-a.json" '.pages' 2
jqis "a relayed answer keeps the host it came from" \
  "$DIR/audit-qitem-a.json" '[.rows[] | .auditNotes.openrig_relay.from_host // empty] | first' hub-0
present "$DIR/audit-qitem-b.json" "audit rows for qitem-b"
jqis "an empty audit read is ok, not a failure" "$DIR/manifest.json" \
  '[.parts[] | select(.name == "audit:qitem-b") | .ok] | first' true
present "$DIR/audit-qitem-review-untagged.json" "a review item the team created itself is archived too"
present "$DIR/audit-qitem-recovery-1f2e3d4c.json" "and so is a row the team never tagged"
present "$DIR/usage-orch-lead@demo-rig.json" "usage per seat"
jqis "usage samples were counted" "$DIR/usage-orch-lead@demo-rig.json" '.rows | length' 5
jqis "the raw result.json was kept" "$DIR/result.json" '.status' done
jqis "the manifest counts the result row" "$DIR/manifest.json" \
  '[.parts[] | select(.name == "result") | .rows] | first' 1
in_calls "the queue read is not capped at 500 rows" "--limit 100000"
in_calls "telemetry opens at the retained floor, not the watermark" "--start retained"
in_calls "the events cursor was followed" "--cursor CURSOR-E1"
in_calls "the transitions cursor was followed" "--cursor CURSOR-T1"
in_calls "the audit before_id was followed" "act-2"
in_calls "the audit page size is the daemon's maximum" " 200"

echo "== a usage series that does not fit in one page"
run_archive usage-paged "$WORK/usage-paged" RIG_DISPATCH_USAGE_PAGE=2
jqis "the usage part holds both pages" "$DIR/usage-orch-lead@demo-rig.json" '.rows | length' 7
jqis "and it says how many pages it read" "$DIR/usage-orch-lead@demo-rig.json" '.pages' 3
in_calls "the first usage page asked for a bounded page" "usage series --seat orch-lead@demo-rig --limit 2"
in_calls "the second page walked forward from the last capturedAt" "--since 2026-10-23T20:08:00Z"

echo "== the page budget is a knob, and says so"
run_archive budget "$WORK/budget" RIG_DISPATCH_MAX_PAGES=1
eq "a page budget that runs out fails the part" 1 "$RC"
jqis "and names the knob rather than blaming the cursor" "$DIR/manifest.json" \
  '[.parts[] | select(.name == "events") | (.error | startswith("the page budget RIG_DISPATCH_MAX_PAGES=1 ran out"))] | first' true

echo "== one part fails"
run_archive failed "$WORK/failed" FAKE_FAIL_USAGE_TOP=1
eq "archive exits non-zero when a part fails" 1 "$RC"
jqis "the manifest says the archive is not complete" "$DIR/manifest.json" '.complete' false
jqis "the failed part is named with its error" "$DIR/manifest.json" \
  '[.parts[] | select(.name == "usage-top") | (.error | startswith("rig usage top"))] | first' true
absent "$DIR/usage-top.json" "a failed part leaves no file that looks saved"
present "$DIR/events.json" "everything that did read is kept beside the failure"
present "$DIR/audit-qitem-a.json" "including the audit rows"
jqis "the parts that read are still ok" "$DIR/manifest.json" \
  '[.parts[] | select(.name == "events") | .ok] | first' true

echo "== a cursor that stops advancing"
run_archive stalled "$WORK/stalled" FAKE_STALL_EVENTS=1
eq "archive exits non-zero on a stalled stream" 1 "$RC"
jqis "the stalled stream is a failed part" "$DIR/manifest.json" \
  '[.parts[] | select(.name == "events") | .ok] | first' false
jqis "and it says why" "$DIR/manifest.json" \
  '[.parts[] | select(.name == "events") | (.error | startswith("the events cursor stopped"))] | first' true
absent "$DIR/events.json" "a truncated history is not written as if it were the whole one"

echo "== a ticket with no result yet"
run_archive noresult "$WORK/noresult" FAKE_NO_RESULT=1
eq "a missing result.json is not an archive failure" 0 "$RC"
jqis "and it is recorded as a note" "$DIR/manifest.json" \
  '[.parts[] | select(.name == "result") | .note] | first' "the pod has written no result.json yet"

echo "== a pod that is not Ready"
run_archive notready "$WORK/notready" FAKE_POD_READY=0
eq "archive refuses to pretend" 1 "$RC"
if grep -qi "not Ready" "$WORK/notready.err"; then
  ok "and says the team pod is not Ready"
else
  bad "and says the team pod is not Ready (got: $(head -c 200 "$WORK/notready.err"))"
fi
absent "$WORK/notready/demo" "and writes no archive"

echo "== collect still works on its own"
COLLECT_ROOT="$WORK/collect"
mkdir -p "$COLLECT_ROOT"
CALLS="$WORK/collect.calls"; : > "$CALLS"
export FAKE_CALLS=$CALLS
( cd "$COLLECT_ROOT" && env KUBECTL=kubectl RIG_DISPATCH_NAMESPACE=openrig \
    "$DISPATCH" collect DEMO --archive "$COLLECT_ROOT" ) >"$WORK/collect.out" 2>"$WORK/collect.err"
if [ $? -eq 0 ]; then ok "collect exits 0"; else bad "collect exits 0 (stderr: $(head -c 200 "$WORK/collect.err"))"; fi
present "$COLLECT_ROOT/demo/status.json" "collect still writes status.json"
present "$COLLECT_ROOT/demo/queue.json" "collect still writes queue.json"
present "$COLLECT_ROOT/demo/result.bundle" "collect still bundles the result branch"

echo "== collect: a failed bundle never costs the archive"
run_dispatch collect-bundle-fails FAKE_FAIL_BUNDLE=1 -- collect DEMO --dir "$WORK/cbf"
eq "collect exits non-zero when the bundle fails" 1 "$RC"
present "$WORK/cbf/demo/events.json" "the archive is still there after a failed bundle"
present "$WORK/cbf/demo/audit-qitem-a.json" "with the audit rows intact"
absent "$WORK/cbf/demo/result.bundle" "no half-written bundle is left behind"
jqis "the bundle failure is in the manifest" "$WORK/cbf/demo/manifest.json" \
  '[.parts[] | select(.name == "bundle") | (.error | startswith("fatal:"))] | first' true
jqis "and the archive is then not complete" "$WORK/cbf/demo/manifest.json" '.complete' false

run_dispatch collect-no-branch FAKE_NO_RESULT=1 -- collect DEMO --dir "$WORK/cnb"
eq "collect exits 0 when there is no result branch yet" 0 "$RC"
present "$WORK/cnb/demo/events.json" "and the archive is still kept"
jqis "the manifest says there was nothing to bundle, as a note, not a failure" "$WORK/cnb/demo/manifest.json" \
  '[.parts[] | select(.name == "bundle") | (.note // "" | startswith("nothing to bundle"))] | first' true
jqis "and the archive is complete without a bundle" "$WORK/cnb/demo/manifest.json" '.complete' true

run_dispatch collect-empty-bundle FAKE_EMPTY_BUNDLE=1 -- collect DEMO --dir "$WORK/ceb"
eq "collect exits 0 when the branch has no new commits" 0 "$RC"
jqis "an empty bundle is a note, not a failed part" "$WORK/ceb/demo/manifest.json" \
  '[.parts[] | select(.name == "bundle") | .ok] | first' true
jqis "and the archive stays complete" "$WORK/ceb/demo/manifest.json" '.complete' true
if [ -e "$WORK/ceb/demo/result.bundle" ]; then bad "and no zero-byte bundle is left behind ($(ls -l "$WORK/ceb/demo/result.bundle"))"
else ok "and no zero-byte bundle is left behind"; fi

run_dispatch delete-after-collect -- delete DEMO --dir "$WORK/cnb"
eq "delete passes after a collect that had no branch to bundle" 0 "$RC"

run_dispatch delete-after-empty-bundle -- delete DEMO --dir "$WORK/ceb"
eq "delete passes after a collect whose branch had nothing new to bundle" 0 "$RC"

echo "== delete: the guard"
run_dispatch delete-no-archive -- delete DEMO --dir "$WORK/noarchive"
eq "delete refuses when there is no archive" 1 "$RC"
if grep -q "no archive at" "$WORK/delete-no-archive.err"; then ok "and says there is no archive"
else bad "and says there is no archive (got: $(head -c 200 "$WORK/delete-no-archive.err"))"; fi

run_archive del-ok "$WORK/del-ok"
run_dispatch delete-ok -- delete DEMO --dir "$WORK/del-ok"
eq "delete runs on a complete archive" 0 "$RC"
in_calls "delete unregisters the team from the hub first" "exec -i hub-0"
if grep -q "deleted t-demo" "$WORK/delete-ok.err"; then ok "and deletes the team"
else bad "and deletes the team (got: $(head -c 200 "$WORK/delete-ok.err"))"; fi

run_dispatch delete-incomplete -- delete DEMO --dir "$WORK/cbf"
eq "delete refuses when a part failed" 1 "$RC"
if grep -q "bundle" "$WORK/delete-incomplete.err"; then ok "and names the part that failed"
else bad "and names the part that failed (got: $(head -c 200 "$WORK/delete-incomplete.err"))"; fi

run_dispatch delete-force -- delete DEMO --dir "$WORK/cbf" --force
eq "--force deletes anyway" 0 "$RC"
if grep -q "WARNING: deleting without a complete archive" "$WORK/delete-force.err"; then
  ok "and says so loudly"
else bad "and says so loudly (got: $(head -c 200 "$WORK/delete-force.err"))"; fi

# A manifest that claims a part it does not have on disk: tamper with a good archive.
run_archive del-tamper "$WORK/del-tamper"
rm -f "$WORK/del-tamper/demo/events.json"
run_dispatch delete-tampered -- delete DEMO --dir "$WORK/del-tamper"
eq "delete refuses when a claimed part is missing from disk" 1 "$RC"
if grep -q "not usable on disk: events" "$WORK/delete-tampered.err"; then ok "and names the missing part"
else bad "and names the missing part (got: $(head -c 200 "$WORK/delete-tampered.err"))"; fi

# A file that exists but holds nothing: `[ -e ]` alone would let it through.
run_archive del-trunc "$WORK/del-trunc"
: > "$WORK/del-trunc/demo/events.json"
run_dispatch delete-truncated -- delete DEMO --dir "$WORK/del-trunc"
eq "delete refuses a zero-byte file the manifest claims was saved" 1 "$RC"
if grep -q "events(unreadable)" "$WORK/delete-truncated.err"; then ok "and says which part is unusable"
else bad "and says which part is unusable (got: $(head -c 200 "$WORK/delete-truncated.err"))"; fi

# A truncated-but-valid file: fewer rows than the manifest says were saved.
run_archive del-short "$WORK/del-short"
jq '.rows = (.rows | .[0:1])' "$WORK/del-short/demo/events.json" > "$WORK/del-short/demo/events.short" \
  && mv "$WORK/del-short/demo/events.short" "$WORK/del-short/demo/events.json"
run_dispatch delete-short -- delete DEMO --dir "$WORK/del-short"
eq "delete refuses a file with fewer rows than the manifest counted" 1 "$RC"
if grep -q "events(has 1 rows, the manifest says 3)" "$WORK/delete-short.err"; then ok "and says the counts differ"
else bad "and says the counts differ (got: $(head -c 200 "$WORK/del-short.err"))"; fi

echo "== delete: a complete archive is not necessarily a current one"
run_archive del-stale-inc "$WORK/del-stale-inc"
# The same slug, a newer pod: the ticket was re-dispatched after the archive was taken.
run_dispatch delete-stale-incarnation FAKE_STS_CREATED=2026-10-24T09:00:00Z -- delete DEMO --dir "$WORK/del-stale-inc"
eq "delete refuses an archive from an earlier incarnation of the ticket" 1 "$RC"
if grep -q "different incarnation" "$WORK/delete-stale-incarnation.err"; then ok "and says it is another incarnation"
else bad "and says it is another incarnation (got: $(head -c 200 "$WORK/delete-stale-incarnation.err"))"; fi

run_archive del-moved "$WORK/del-moved"
# The same pod, more history: the team kept working after the archive was taken.
run_dispatch delete-moved-watermark FAKE_WATERMARK_EVENTS=99 -- delete DEMO --dir "$WORK/del-moved"
eq "delete refuses when the team has written more since the archive" 1 "$RC"
if grep -q "the team has moved on since" "$WORK/delete-moved-watermark.err"; then ok "and says the team moved on"
else bad "and says the team moved on (got: $(head -c 200 "$WORK/delete-moved-watermark.err"))"; fi
in_calls "the guard read the live watermark, not the archived one" "telemetry events --json"

echo "== delete: the daemon's own timer is not the team moving on"
# A team daemon writes a `snapshot.created` event to itself every few minutes whether anyone is
# working or not. One of those landing after the collect is not the team having moved on; in the
# recorded run it cost a second collect for nothing.
run_archive del-tick "$WORK/del-tick"
run_dispatch delete-idle-tick FAKE_LIVE_TAIL=snapshot.created -- delete DEMO --dir "$WORK/del-tick"
eq "delete runs when the only event after the archive is the daemon's own tick" 0 "$RC"
if grep -q "deleted t-demo" "$WORK/delete-idle-tick.err"; then ok "and deletes the team"
else bad "and deletes the team (got: $(head -c 200 "$WORK/delete-idle-tick.err"))"; fi
in_calls "and it read past the archived watermark to learn whose event it was" "--start retained"

# The same archive and the same one extra event, one type later: a queue row is the team working.
run_dispatch delete-real-event FAKE_LIVE_TAIL=queue.updated -- delete DEMO --dir "$WORK/del-tick"
eq "delete still refuses when a real event landed after the archive" 1 "$RC"
if grep -q "events(new activity)" "$WORK/delete-real-event.err"; then ok "and names the new activity as the reason"
else bad "and names the new activity as the reason (got: $(head -c 200 "$WORK/delete-real-event.err"))"; fi

# What an archive written by the older dispatcher does under this check. It recorded the raw end of
# the window it read, and so does this one: the manifest field never changed meaning, so there is no
# old archive to special-case. Here that end sits on a tick, and the delete may still trust it.
run_archive del-oldstyle "$WORK/del-oldstyle" FAKE_LIVE_TAIL=snapshot.created
jqis "the recorded watermark is the raw end of the window, tick and all" "$WORK/del-oldstyle/demo/manifest.json" \
  '.watermarks.events' "4"
jqis "and the tick itself is archived, not dropped from the history" "$WORK/del-oldstyle/demo/events.json" \
  '[.rows[].type] | last' "snapshot.created"
run_dispatch delete-oldstyle FAKE_LIVE_TAIL=snapshot.created -- delete DEMO --dir "$WORK/del-oldstyle"
eq "an archive whose watermark sits on a tick is still the current one" 0 "$RC"

# A watermark that is not a number cannot bound a read, so nothing past it can be classified. The
# conservative answer is the one an unreadable stream already gets: refuse, and say so.
run_archive del-unparseable "$WORK/del-unparseable"
jq '.watermarks.events = "seq:00000000ff"' "$WORK/del-unparseable/demo/manifest.json" > "$WORK/del-unparseable/demo/m.new" \
  && mv "$WORK/del-unparseable/demo/m.new" "$WORK/del-unparseable/demo/manifest.json"
run_dispatch delete-unparseable-watermark -- delete DEMO --dir "$WORK/del-unparseable"
eq "delete refuses a watermark it cannot place on the number line" 1 "$RC"
if grep -q "events(cannot be read to its end)" "$WORK/delete-unparseable-watermark.err"; then ok "and says it could not read the stream to its end"
else bad "and says it could not read the stream to its end (got: $(head -c 200 "$WORK/delete-unparseable-watermark.err"))"; fi

echo "== an archive records what it holds, not what the stream had reached"
# The team wrote while the archive was reading. The window's `through` stays where it opened; the
# watermark the daemon reports on the last page has moved past the rows this read could include.
# Recording the watermark instead would let `delete` pass on rows nobody archived.
run_archive r3 "$WORK/r3" FAKE_R3_WRITES=1
eq "the read still finishes" 0 "$RC"
jqis "the manifest records the window's through, not the moving watermark" "$WORK/r3/demo/manifest.json" \
  '.watermarks.events' "3"
run_dispatch delete-r3 FAKE_R3_WRITES=1 -- delete DEMO --dir "$WORK/r3"
eq "delete refuses, because rows past the window's through were never archived" 1 "$RC"
if grep -q "the team has moved on since" "$WORK/delete-r3.err"; then ok "and it says the team moved on"
else bad "and it says the team moved on (got: $(head -c 200 "$WORK/delete-r3.err"))"; fi

echo "== report: from the archive alone"
run_dispatch report -- report DEMO --dir "$WORK/complete"
eq "report exits 0" 0 "$RC"
if grep -q "DEMO-1" "$WORK/report.out"; then ok "the table names the ticket"; else bad "the table names the ticket"; fi
if grep -q "from host hub-0" "$WORK/report.out"; then ok "it names the human answer and the host it came from"
else bad "it names the human answer and the host it came from (got: $(cat "$WORK/report.out"))"; fi
if grep -q "not exact accounting" "$WORK/report.out"; then ok "it states what the usage figures are not"
else bad "it states what the usage figures are not"; fi
if grep -q "reports gaps" "$WORK/report.out"; then ok "it warns that the history is partial"
else bad "it warns that the history is partial"; fi

run_dispatch report-json -- report DEMO --dir "$WORK/complete" --json
jqis "duration is first to last event" "$WORK/report-json.out" '.durationSeconds' 1770
jqis "review rounds count items sent to a review seat" "$WORK/report-json.out" '.reviewRounds' 2
jqis "a stuck-sweep recovery row addressed to a review seat is not a round" "$WORK/report-json.out" \
  '.reviewItems | index("qitem-recovery-1f2e3d4c")' null
jqis "handoffs count handed-off transitions" "$WORK/report-json.out" '.handoffs' 2
jqis "human decisions count resolve audit rows" "$WORK/report-json.out" '.humanDecisions' 1
jqis "the decision names who gave it" "$WORK/report-json.out" '.decisions[0].actor' human@operator-laptop
jqis "and the host a relayed answer came from" "$WORK/report-json.out" '.decisions[0].fromHost' hub-0
jqis "tokens use the daemon's own positive-delta rule" "$WORK/report-json.out" '.usage.tokens' 2300
jqis "a counter reset is counted, never subtracted" "$WORK/report-json.out" '.usage.resets' 2
jqis "the usage-top window is labelled, not summed in" "$WORK/report-json.out" '.usage.topWindowHours' 1
jqis "partial history is flagged" "$WORK/report-json.out" '.historyMayBePartial' true

run_dispatch report-all -- report --all --dir "$WORK/complete" --json
eq "report --all exits 0" 0 "$RC"
jqis "report --all finds the archived ticket" "$WORK/report-all.out" 'length' 1
jqis "and reports it" "$WORK/report-all.out" '.[0].slug' demo

run_dispatch report-missing -- report DEMO --dir "$WORK/noarchive"
eq "report refuses to invent figures for a ticket it never archived" 1 "$RC"

echo "== answer: through the hub when the hub can do it"
run_dispatch answer-hub -- answer DEMO qitem-a "Use the existing retry helper."
eq "answer exits 0" 0 "$RC"
in_calls "the hub pod was asked, with the team's registered host id" "exec -i hub-0 -c daemon -- env -u OPENRIG_SESSION_NAME -u RIGGED_SESSION_NAME rig queue resolve --host t-demo"
in_err "and it says which path it used" "resolved on t-demo through hub-0 as the seatless human"
in_calls "the hub call carries no seat name" "env -u OPENRIG_SESSION_NAME"
not_in_calls "no seat env was set for the hub call" "env OPENRIG_SESSION_NAME=human"
not_in_calls "the team pod was not touched" "t-demo-0 -c daemon -- env OPENRIG_SESSION_NAME"

run_dispatch answer-no-hub FAKE_NO_HUB=1 -- answer DEMO qitem-a "Use the existing retry helper."
eq "answer still works with no Ready hub" 0 "$RC"
in_err "it says the hub is not there" "no Ready hub pod hub-0"
in_calls "and falls back to the team pod as its lead" "t-demo-0 -c daemon -- env OPENRIG_SESSION_NAME=orch-lead@demo-rig rig queue resolve"
in_err "and says what the fallback records" "will name that seat, not the human"

run_dispatch answer-unregistered FAKE_NOT_REGISTERED=1 -- answer DEMO qitem-a "Use the existing retry helper."
eq "answer works when the team is not registered on the hub" 0 "$RC"
in_err "it names the host that is not registered" "not registered on hub-0"
in_calls "and falls back" "t-demo-0 -c daemon -- env OPENRIG_SESSION_NAME=orch-lead@demo-rig rig queue resolve"

run_dispatch answer-unroutable FAKE_ANSWER=unroutable -- answer DEMO qitem-a "Use the existing retry helper."
eq "answer works when the hub cannot route to the team" 0 "$RC"
in_err "it names what the hub could not do" "could not record the answer (unknown-host)"
in_calls "it read the team's own copy first" "rig queue show qitem-a --json"
in_err "the row was still parked, so it fell back" "still blocked on human@host"
in_calls "and falls back" "t-demo-0 -c daemon -- env OPENRIG_SESSION_NAME=orch-lead@demo-rig rig queue resolve"

echo "== answer: a landing is believed when the team's audit row carries it"
run_dispatch answer-landed FAKE_ANSWER=unreachable-landed FAKE_SHOW_STATE=in-progress FAKE_SHOW_BLOCKED="" \
  -- answer DEMO qitem-a "Use the existing retry helper."
eq "a write the audit row confirms exits 0" 0 "$RC"
in_err "it says the hub's answer landed" "the hub's answer landed on t-demo"
in_err "and that nothing was re-issued" "nothing is re-issued"
in_calls "and it decided from the team's audit rows" "api/mission-control/audit"
not_in_calls "the team pod was not asked to resolve again" "t-demo-0 -c daemon -- env OPENRIG_SESSION_NAME"

echo "== answer: a moved row whose audit rows do not carry this decision is not a landing"
# Someone else unparked the row. The state alone would have looked like a landing; the resolve in the
# audit log carries a different decision, so this dispatcher cannot claim the human's answer landed.
run_dispatch answer-landed-other FAKE_ANSWER=unreachable-landed FAKE_SHOW_STATE=in-progress FAKE_SHOW_BLOCKED="" \
  FAKE_AUDIT_A=audit-qitem-a-otherdecision.json \
  -- answer DEMO qitem-a "Use the existing retry helper."
eq "an unconfirmed landing exits 5, not 0" 5 "$RC"
in_err "it says no audit row carries the decision" "no audit row on t-demo carries this decision"
not_in_calls "and it did not re-issue the answer inside the pod" "t-demo-0 -c daemon -- env OPENRIG_SESSION_NAME"

echo "== answer: a row that cannot be read is not a moved row"
run_dispatch answer-row-unreadable FAKE_ANSWER=unreachable-landed FAKE_SHOW_UNREADABLE=1 \
  -- answer DEMO qitem-a "Use the existing retry helper."
eq "an unreadable row exits 5" 5 "$RC"
in_err "it says the answer is not confirmed" "so the answer is not confirmed"
in_err "and it says where it could not read" "cannot read qitem-a on t-demo"
not_in_calls "and nothing was re-issued on the guess" "t-demo-0 -c daemon -- env OPENRIG_SESSION_NAME"

echo "== answer: blocked with no blockedOn is unreadable, not moved"
run_dispatch answer-blocked-nothing FAKE_ANSWER=hub401 FAKE_SHOW_BLOCKED="" \
  -- answer DEMO qitem-a "Use the existing retry helper."
eq "a row parked with no one to wait on exits 5" 5 "$RC"
in_err "and it says it could not read the row" "cannot read qitem-a on t-demo"

echo "== answer: a moved row after the hub never sent the write"
run_dispatch answer-moved-unknown-host FAKE_ANSWER=unroutable FAKE_SHOW_STATE=in-progress FAKE_SHOW_BLOCKED="" \
  FAKE_AUDIT_A=audit-qitem-a-otherdecision.json \
  -- answer DEMO qitem-a "Use the existing retry helper."
eq "a row moved by someone else exits 5" 5 "$RC"
in_err "it names what the hub could not do" "unknown-host"
in_err "and says the write is not confirmed" "no audit row on t-demo carries this decision"
not_in_calls "and the answer was not re-issued in the pod" "t-demo-0 -c daemon -- env OPENRIG_SESSION_NAME"

echo "== answer: a failure of the hub itself is not blamed on the team"
run_dispatch answer-hub-401 FAKE_ANSWER=hub401 -- answer DEMO qitem-a "Use the existing retry helper."
eq "a hub-local failure falls back rather than dying" 0 "$RC"
not_in_calls "it did not call that a team refusal" "the team refused it"
in_err "it read the team's copy before falling back" "reading the team's own copy before falling back"
in_calls "and it fell back" "t-demo-0 -c daemon -- env OPENRIG_SESSION_NAME=orch-lead@demo-rig rig queue resolve"

echo "== answer: a moved row beside an unexplained hub failure is not called a landing"
run_dispatch answer-hub-401-moved FAKE_ANSWER=hub401 FAKE_SHOW_STATE=in-progress FAKE_SHOW_BLOCKED="" \
  FAKE_AUDIT_A=audit-qitem-a-otherdecision.json \
  -- answer DEMO qitem-a "Use the existing retry helper."
eq "a moved row that cannot be confirmed exits 5" 5 "$RC"
in_err "it says it cannot tell whether the write landed" "cannot tell whether that write landed"
in_err "and names what the hub reported" "unauthorized"
not_in_calls "and the pod was not asked to resolve again" "t-demo-0 -c daemon -- env OPENRIG_SESSION_NAME"

echo "== answer: a refusal by the team is not a reason to fall back"
run_dispatch answer-refused FAKE_ANSWER=refused -- answer DEMO qitem-a "Use the existing retry helper."
eq "a refused answer exits non-zero" 1 "$RC"
not_in_calls "the team pod was not asked again" "t-demo-0 -c daemon -- env OPENRIG_SESSION_NAME"
not_in_calls "and the row was not even re-read" "rig queue show qitem-a --json"
if grep -q "Not falling back" "$WORK/answer-refused.err"; then ok "and it says it is not falling back"
else bad "and it says it is not falling back (got: $(head -c 200 "$WORK/answer-refused.err"))"; fi
if grep -q "the team refused it" "$WORK/answer-refused.err"; then ok "and names who refused"
else bad "and names who refused (got: $(head -c 200 "$WORK/answer-refused.err"))"; fi
if grep -q "remote-error" "$WORK/answer-refused.err"; then ok "and passes the team's own reason through"
else bad "and passes the team's own reason through"; fi

echo "== answer: a refusal is still a refusal with kubectl's own line beside it"
# The shape the live hub gives for a row that is no longer parked: remote-error, and kubectl appends
# "command terminated with exit code 2" beside the JSON. Classifying that as "the hub could not do it"
# would re-issue a decision the team already refused.
run_dispatch answer-refused-closed FAKE_ANSWER=refused-closed -- answer DEMO qitem-a "Use the existing retry helper."
eq "a 409 refusal exits non-zero" 1 "$RC"
in_err "it passes the team's own detail through" "qitem_not_leg1_parked"
if grep -q "the team refused it" "$WORK/answer-refused-closed.err"; then ok "and it names the team as the refuser"
else bad "and it names the team as the refuser (got: $(head -c 200 "$WORK/answer-refused-closed.err"))"; fi
not_in_calls "so the row was not re-read to guess" "rig queue show qitem-a --json"
not_in_calls "and no fallback resolve was issued" "t-demo-0 -c daemon -- env OPENRIG_SESSION_NAME"

echo "== running it again"
run_archive rerun "$WORK/rerun"
eq "the first run succeeds" 0 "$RC"
touch "$DIR/stale-from-the-first-run"
run_archive rerun2 "$WORK/rerun"
eq "the second run succeeds" 0 "$RC"
absent "$WORK/rerun/demo/stale-from-the-first-run" "a re-run leaves nothing of the previous archive behind"
present "$WORK/rerun/demo/manifest.json" "the re-run archive is there and whole"
jqis "the re-run is complete" "$WORK/rerun/demo/manifest.json" '.complete' true
if ls -a "$WORK/rerun" | grep -q 'partial\|\.old'; then
  bad "no scratch directories are left in the archive root (found: $(ls -a "$WORK/rerun" | tr '\n' ' '))"
else
  ok "no scratch directories are left in the archive root"
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAILED"
[ "$FAILED" -eq 0 ] || exit 1
