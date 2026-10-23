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
jqis "usage samples were counted" "$DIR/usage-orch-lead@demo-rig.json" '.rows | length' 2
jqis "the raw result.json was kept" "$DIR/result.json" '.status' done
jqis "the manifest counts the result row" "$DIR/manifest.json" \
  '[.parts[] | select(.name == "result") | .rows] | first' 1
in_calls "the queue read is not capped at 500 rows" "--limit 100000"
in_calls "telemetry opens at the retained floor, not the watermark" "--start retained"
in_calls "the events cursor was followed" "--cursor CURSOR-E1"
in_calls "the transitions cursor was followed" "--cursor CURSOR-T1"
in_calls "the audit before_id was followed" "act-2"
in_calls "the audit page size is the daemon's maximum" " 200"

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
