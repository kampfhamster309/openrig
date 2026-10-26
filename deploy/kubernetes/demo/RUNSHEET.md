# The demo run sheet

Fifteen minutes, on one small cluster, showing what the Kubernetes factory does. Every command here is
meant to be pasted. Times are for the whole step, including the typing.

**What you are showing.** One command turns a ticket into a running team of agents in its own pod, one
hub shows every team at once, a human answer goes back into the team and is recorded as a human answer,
a team parked on a human answer is caught as stalled while it waits, a finished team is archived before it
can be deleted, and a team destroyed behind the hub's back is reconciled. Three teams: **DEMO-A** is
waiting for a decision, **DEMO-B** is finished, **DEMO-C** is started live on stage and keeps working
after its command returns — it may well finish before the talk ends, and step 5 says what that means.

Set these once, in the terminal you present from. Run everything **from this directory**
(`deploy/kubernetes/demo`) — that is what makes the dispatcher path below work without a machine-specific
absolute path in it:

```bash
export NS=openrig
export D=../dispatcher/rig-dispatch    # the dispatcher, one directory over
export ARCH=$HOME/tmp/demo-archive     # one archive dir, used by all of step 6
export CLIENT=$HOME/tmp/openrig-hub-build/packages/cli   # your build of the hub's commit (see below)
```

> If you present from somewhere else, set `D` to wherever the dispatcher is. Everything below assumes
> `jq`, `kubectl` and `KUBECONFIG` pointing at the cluster, which you already had working when you ran
> `prepare.sh`. Do not set `Q_A` here — it comes after `prepare.sh`, which is step 1 below.

**Your own OpenRig client must be the hub's build.** After step 2 every `rig` command on this sheet runs
*inside* hub-0 or inside a team pod, so those are the hub's build by construction. The one client that is
yours is the **TUI** you start in step 2, and it talks to the hub's routes: a client that is merely "also
0.7.0" can be a different commit and lack what the hub serves. The published npm release is not
automatically the hub's build — in rehearsal 1 `@openrig/cli@0.7.0` on npm was a different commit from the
image, and it had no `usage top --all-hosts` at all.

Build it from the commit the hub image tag names (the tag is `0.7.2-<sha>`), in a scratch worktree:

```bash
git -C <an openrig checkout> worktree add --detach "$HOME/tmp/openrig-hub-build" <the sha the tag names>
cd "$HOME/tmp/openrig-hub-build" && npm ci && npm run build:package
```

`build:package`, not plain `npm run build`: the stamp that makes `--version` name a commit is written by
the packaging script, and an unstamped build prints `0.7.0` with no commit at all.

Then check it against the hub, mechanically, before you present. The TUI has no `--version` of its own (it
ignores an unknown flag and opens the UI), so the check reads the CLI from the same build the TUI comes
from:

```bash
HUB_TAG=$(kubectl -n $NS get pod hub-0 -o jsonpath='{.spec.containers[0].image}'); HUB_TAG=${HUB_TAG##*:}
HUB_SHA=${HUB_TAG#*-}; HUB_SHA=${HUB_SHA:0:8}
CLIENT_SHA=$(node "$CLIENT/dist/bin-wrapper.js" --version | sed -n 's/.*(\([0-9a-f]\{7,\}\).*/\1/p')
[ "$CLIENT_SHA" = "$HUB_SHA" ] && echo "client build matches the hub: $CLIENT_SHA" \
  || echo "MISMATCH: client ${CLIENT_SHA:-unstamped} vs hub $HUB_SHA — build it from the hub's commit"
```

If they disagree, say so and fix the build rather than presenting a step you know will error. (`rig tui`
hands its own build to the TUI, which compares it with the daemon's `/healthz` and stops its background
reads on a mismatch. Started by path — which is what this sheet does, because `rig tui` takes no `--url` —
it cannot check, so the check above is the one that matters.)

---

## Before the talk

An hour before, in a plain terminal:

1. `cd <this directory> && ./prepare.sh`
   It checks the cluster, applies the kit, lowers the stall threshold to 3 minutes, starts DEMO-A and
   DEMO-B one at a time, and waits until A is waiting for a human and B is done. It prints the next two
   commands when it is finished. Plan on **about eight and a half minutes** — it is starting two pods and
   two agents, and rehearsal 1 measured 8m27s. (Rehearsal 2 finished in about two minutes only because it
   re-used the queue rows an earlier attempt had already created; that is not the timing to plan a talk
   around.)
   If DEMO-A's lead puts its question on its **own screen** instead of on the queue — Claude Code's
   question dialog, a permission prompt — nobody can answer it, and the recorded run waited the full 20
   minutes for a row that was never coming. `prepare.sh` now reads what the pod's daemon already reports
   and stops by itself instead: **within a few minutes, not 20.** Plan on that, not on seconds — it wants
   two consecutive readings of the same seat, and the daemon keeps calling a seat `running` for up to five
   minutes after a dialog opened, so a faster stop than that is not measured yet. It names the seat and
   prints the four hand steps: look at the pane, press `Esc` in it with one command so nothing is chosen,
   send the seat one message pointing at step 1 of its brief, re-run. About a minute of your time, and the
   re-run re-checks rather than starting a second team.
2. Start the port-forward it printed: `kubectl -n $NS port-forward pod/hub-0 17433:7433 &`
3. Start the hub TUI it printed, in the window you will present:
   `OPENRIG_HOME=$HOME/.openrig-hub-view OPENRIG_URL=http://127.0.0.1:17433 node "$CLIENT/tui/dist/main.js" --url http://127.0.0.1:17433`
   **Always pass `--url`.** Without it the TUI opens your own local daemon on 7433, not the hub. The
   explorer should name `hub-0`. If it names your own machine, `Ctrl-C`, check `OPENRIG_URL` and `--url`
   are both set, and start it again.

   It opens on **Start and return**. On a hub that answers quickly it moves on to the ordinary views by
   itself in a moment; if the screen is still up, press **`w`** ("Skip startup · ordinary views"), and `S`
   opens it again from any view. PULSE is a tab, not a page: type **`tab pulse`** in the `cmd` line (a
   `:` jumps to a section instead).
4. Open a second window for the commands, and a third for `watch` in step 4.
5. `./cleanup.sh` and `./prepare.sh` again if anything looks off. `prepare.sh` is safe to re-run.
6. Now read the ticket id the rest of the talk needs, and put it where you can see it:

   ```bash
   export Q_A=$($D status DEMO-A --json | jq -r '.[0].qitem')
   echo "$Q_A"
   ```

   Set it here and not earlier: before `prepare.sh` there is no DEMO-A item to read, and a `Q_A` from the
   last rehearsal points at a row that no longer exists. Step 3 types this id into the TUI, so leave it
   on screen.

Right before you start: DEMO-A is under **NEEDS YOU** in PULSE (`tab pulse`), DEMO-B shows `result:done`,
and nothing else is running. `$D status` prints all three, and
`$D status DEMO-A --json | jq '.[0].open'` is the same fact without the TUI.

---

## 1. Start a team live — 2 min

```bash
$D start DEMO-C --repo https://github.com/kampfhamster309/openrig-demo --ref main \
   --spec /etc/openrig-kit/rig-one.yaml --brief-file ./briefs/DEMO-C.md \
   --cpu 200m --memory 896Mi --storage 2Gi
```

**Audience sees.** The dispatcher create a Secret and a StatefulSet, wait for the pod, run `rig up`
inside it, hand the brief over as a queue item, and print the ticket's status line. One seat: a single
Claude Code lead. It keeps working after the command returns, which is the point — you talk over it.

**If it does not appear.**
- It sits at `waiting for t-demo-c-0 to be Ready`: the image is not on the node yet. `kubectl -n $NS
  get pod t-demo-c-0 -o wide` and wait; if it is `ErrImagePull`, skip to step 2 and come back.
- It dies with `no seat 'orch.lead' in rig demo-one`: the kit did not apply. `kubectl -n $NS get
  configmap openrig-kit -o jsonpath='{.data}' | head -c 200` should mention `rig-one.yaml`. If not:
  `kubectl apply -k ..` and re-run the start.
- No time to spare: DEMO-A and DEMO-B already show everything the rest of the talk needs. Say "the
  third team is coming up" and move on; it will be there for step 5.
- The pod is Ready and the seat just stops: it is waiting on a dialog in its own pane, which reaches
  nobody. `$D status DEMO-C --json | jq '.[0].seats'` says `needs_input`, and
  `kubectl -n $NS exec t-demo-c-0 -c daemon -- rig capture <seat> --lines 40` shows it. One command puts
  `Esc` in that pane so nothing is chosen, with nothing to attach to:
  `kubectl -n $NS exec t-demo-c-0 -c daemon -- tmux send-keys -t '=<seat>' Escape` (`tmux ls` in the pod
  names the session if that one is not it — a seat that has had a successor is filed under another name).
  Then `rig send` the seat back to its brief. Its brief now says the question goes on the queue, so this
  should not happen.

---

## 2. The hub sees every team — 3 min

**Open the TUI first — this is its step.** Three things, in this order:

1. **PULSE** — type `tab pulse` in the `cmd` line. `DEMO-A` sits under **▲ NEEDS YOU** with a dim
   `[t-demo-a]` label in front of its summary, and its team is under **⚑ STALLED** as well — named by its
   **rig**, not by the parked question. Rehearsal 2 read
   `⚑ [t-demo-a] demo-one — 5m since last progress, 1 open · threshold 3m`, and that `1 open` is the
   team's open-work count rather than one named row. Say both: the team is waiting for you *and* the hub
   has already called it stalled, and that is not a contradiction — a parked row is open work that makes
   no queue transitions. Step 5 comes back to what the second badge means.
2. **TOPOLOGY** — in the explorer, open `hub-0` and then a remote host: it expands into its rig and its
   seats, each with its state. A remote rig prints `reach: read-only from here · rig capture|send
   <seat>@<rig>@<host>` where a local one offers a terminal, because the terminal would open on the wrong
   machine.
3. **FLEET USAGE** — `hub-0`'s own instance page, above the seat table, headed
   `FLEET USAGE · last 1h`: the top seats across every host by tokens and tokens/hour, with
   `N of M hosts answered`.

**Then the same facts as text, from the hub.** These are the hub's own fan-out, so run them **as the
hub**. Do not run them from your terminal with `OPENRIG_URL` pointed at the port-forward: `--all-hosts`
fans out from the host registry in `OPENRIG_HOME` on *your* machine, and `OPENRIG_URL` does not change
that, so a fresh demo home answers `host registry not found …/hosts.yaml`. The hub's registry is the one
that holds the teams.

```bash
kubectl -n $NS exec hub-0 -c daemon -- rig ps --all-hosts --nodes -A
kubectl -n $NS exec hub-0 -c daemon -- rig usage top --all-hosts
```

`--nodes` across hosts needs the `-A`: without it `rig ps` refuses and prints the ladder it wants
(`per-node fan-out requires the FULL explicit ladder`). That is the command's rule, not a fault here.

Say what the audience is looking at: every seat of every team, and a token-burn table that adds up across
hosts. No agent runs on your machine. `rig ps` answers per host, so it prints a `[host=t-demo-a]` block
per team — and with `--nodes -A` that block is a **JSON array** of the team's seats, not a table, so point
at the `logicalId`/`sessionStatus` pair instead of reading it aloud. `usage top` is the one that prints as
a table and labels each seat row with its `[host]`.

**And this is where the stall is true.** `DEMO-A` has been parked on you since before the talk — comfortably
past the 3-minute threshold, which is the only promise this step makes — it holds open work,
and a parked row makes no queue transitions — which is exactly what the hub counts as progress. Show it
as a number now, while it holds:

```bash
curl -s 'localhost:17433/metrics?fresh=1' | grep -E 'openrig_fleet_(host|rig)_stalled|stall_threshold'
```

Expect `openrig_fleet_host_stalled{host="t-demo-a"} 1` next to
`openrig_fleet_stall_threshold_seconds 180`. Step 5 comes back to what that number means, after step 3
has answered the row and restarted its clock.

Say it as a measured fact, not a rule applied on faith. Rehearsal 2 took this read at exactly this point in
the run — before anything was answered — and got
`openrig_fleet_host_stalled{host="t-demo-a"} 1` and
`openrig_fleet_rig_stalled{host="t-demo-a",rig="demo-one"} 1` against
`openrig_fleet_stall_threshold_seconds 180`, while `t-demo-b` and `t-demo-c` read `0`. (Rehearsal 1 never
reached this point with a `1`: its only `1` came later and belonged to a row that had re-parked.) The rule
under it is what makes it repeatable — open work includes a row parked on a human, the only progress source
is a queue transition, and a system actor's note is not one.

The `?fresh=1` is not decoration. The verdict is computed from a cached fleet read, and in rehearsal 1 a
scrape still said `0` about twenty seconds after the row had passed the threshold while a fresh read said
`1` in the same second; a non-fresh read may be served a payload up to about a minute old while a refresh
runs. Without it, say "the next fleet read will say 1" and move on.

**If it does not appear.**
- `host registry not found` — you ran it from your terminal instead of through `exec hub-0`. That is the
  form above; use it.
- A team is `FAILED (remote-daemon-unreachable)`: the port-forward died (it dies when the machine sleeps).
  `kill %1`, start it again, wait ten seconds.
- No `stalled` line at all for a team with open work: the hub has no verdict yet and leaves the line out
  rather than writing 0. Wait for the next fleet read.
- `curl` refuses: the port-forward died. Restart it.
- **FLEET USAGE is missing** from `hub-0`'s page: the block is absent while no remote host is registered,
  while the usage read has not answered for the first time, or if the page you are on is not the local
  instance's. With teams registered it should be there; if it is not, name it as a fault and read
  `rig usage top --all-hosts` in the hub instead, which is the same numbers.
- PULSE shows no NEEDS YOU row for DEMO-A: the aggregate read is the hub's, and it is slow when a team is
  slow — the TUI now waits as long as that fan-out may take and names a failed read in the status line
  rather than quietly showing you one host. If the status line names a failure, say what it names.

---

## 3. Answer the team, as a human — 3 min

Type this. It is the form the talk uses:

```bash
$D answer DEMO-A "$Q_A" "Use '<words> <lines>' (B)" | jq -c '{verb: .verb, qitem: .qitemId, state: .closedQitem.state}'
```

`$D answer` resolves the row **through the hub** with no seat env, so the CLI declares the seatless human and
the audit row names `human@host` with the hub as origin — which is the whole claim of this step. The `jq`
keeps three fields off a payload that is otherwise several hundred lines of JSON on a projector: the verb,
the row it acted on, and the state the answer moved it to. That state is **`in-progress`**, not `closed` —
the answer hands the row back into the team's hands, and rehearsal 2's own archive shows exactly that
transition (`blocked → in-progress`, actor `human@host`).

Do not ask that line for the decision text. `closedQitem.resolution` is a real field, but the resolve verb
never writes it, so it reads `null` over an answer that landed perfectly well. The audit read below is where
the decision text and its origin host are proved.

The TUI can answer the same row — PULSE prints `→ answer here: answer <qitem> <decision>` right under the
NEEDS YOU line, and a row the fleet read showed on another host is routed there. **This rehearsal did not
exercise that path**, and it is a different identity path: the TUI posts as itself and the hub re-stamps the
actor from its own derived identity, so nobody has yet seen which actor it records. Say "the TUI can do this
too" and leave it there — do not bet step 3's claim on an unexercised path.

Type one of the two literal orders, with the letter that names it. The team takes the words literally:
in the rehearsal an answer that quoted option A's order under option B's letter came back as a re-park
saying "those conflict: A = …; B = … Which do you want?" — which is the team being right, and a wasted
minute on stage. Piping costs you `answer`'s exit code, which is the thing that tells you the hub path was
refused — with `set -o pipefail` in your shell it still fails the line, otherwise read the output.

Then show what the team now has, and who it thinks it came from. **Type this one on a single line** — it is
nested quoting inside a `kubectl exec`, and it is the one command on the sheet that a paste which rewraps
lines can break:

```bash
kubectl -n $NS exec t-demo-a-0 -c daemon -- sh -c 'curl -fsS -H "Authorization: Bearer $(cat "$HOME/.openrig/terminal-token")" "http://127.0.0.1:7433/api/mission-control/audit?qitem_id='"$Q_A"'&limit=5"' | jq '.rows[] | {verb: .actionVerb, reason, origin: .auditNotes.openrig_relay.from_host}'
```

**Audience sees.** The answer lands, and the audit row says `resolve`, carries the decision text, and
names `hub-0` as the host it came from — recorded as a human answering, with the hub as the origin,
not as some bot poking the pod.

**If it does not appear.**
- `answer: no Ready hub pod` or `not registered on the hub`: the dispatcher falls back to resolving
  inside the pod, which records the lead instead of a human. Say so out loud — the fallback is the
  designed behaviour — and check the hub with `$D hub-sync --dry-run`.
- The audit read comes back empty: the row is there but not first. Raise `limit=5` to `limit=20`.
- The audit read answers `curl: (3) URL using bad/illegal format or missing URL` and the shell sits at `>`:
  the paste broke the nested quoting, not the cluster. `Ctrl-C` and type the command on one line.
- The TUI's `answer` refuses: use the `$D answer` line above; it is the form this step is built on.

---

## 4. Watch the team take it up — 2 min

```bash
$D watch DEMO-A --timeout 300; echo "exit $?"
```

**Audience sees.** The event stream: the queue item moving, then the status read that names the phase,
then the verdict. Say what the codes mean: **0** done, **3** it needs a human, **1** any other failure,
**4** out of time — so the same command works as a build step, not just as a show. A
`command terminated with exit code 143` printed just before `exit 0` is `watch` closing its own in-pod
reader with SIGTERM; it is the stream being shut down cleanly, not a failure, so say that as it goes by.

**If it does not appear.**
- Nothing for a minute: the stream is quiet, which is normal and is not the end. The backstop status
  read arrives eventually; that is the designed fallback for a stream that says nothing.
- `the events stream would not stay open`: it says so and switches to polling. Same information, slower.
- You are out of time: `Ctrl-C` and go on. Step 5 does not depend on this one.

---

## 5. A team with open work and no progress — 2 min

Say what the badge means before you show it. **STALLED is not "the agent stopped typing."** The hub counts
progress as *queue transitions* and nothing else — a seat redrawing a spinner, a terminal full of output,
a heartbeat from the watchdog: none of it counts. A scope is stalled when it holds open work and no queue
transition landed inside the threshold. `prepare.sh` lowered that threshold to 3 minutes.

The subject is the row you already saw in step 2: **`DEMO-A` parked, holding open work, making no queue
transitions.** Step 2 showed that verdict twice — as the **⚑ STALLED** row in PULSE ("`Nm since last
progress, 1 open`") and as the metric line (`openrig_fleet_host_stalled{host="t-demo-a"} 1`). This step
says what the two of them mean.

Say the sentence from the step 2 read. Do **not** go pointing at `DEMO-A` again here: step 3 answered it,
and that answer is itself a queue transition made by a human, which restarts its stall clock. Rehearsal 2
re-read the metric fresh after step 3 and got `openrig_fleet_host_stalled{host="t-demo-a"} 0` — the badge
went because the answer landed, not because anything was cleared by hand. By step 5 `DEMO-A` has been a few
minutes of answered, working, maybe finished — no badge, and saying otherwise would be wrong.

**Do not promise `DEMO-C` as the stalled team.** The rehearsal measured it: `DEMO-C`'s row went
`pending` → `in-progress` → `done` in **44 seconds**, both parts of its brief included. A scope with no
open work is never stalled, so at step 5 it correctly has no badge. If it is still working when you get
here, say that it is working and that a *quiet* team with open work is what the badge is for; if it has
finished, say that finishing is why it is not stalled. Either way the stall you demonstrated is the parked
row in step 2, and that is the honest version.

**Audience sees.** Nothing new on screen. This is the explanation of what step 2 showed — the badge and the
number, from the same hub, with no Prometheus anywhere near it. Say that you are referring back rather than
promising a second live read.

**If it does not appear.**
- The fallback is a **callback, not a live check**. Refer back: "you saw this on DEMO-A in step 2 — that
  row was NEEDS YOU and STALLED at the same time, for exactly this reason." It was genuinely stalled there:
  parked on a human, holding open work, and a parked row makes no queue transitions.
- `DEMO-C` is working but its clock keeps restarting: the orchestrator seat posting progress notes onto its
  own item counts as queue transitions, and each one resets the timer. That is the rule working, not a
  fault — and it is why the rehearsal counted C's transitions, not only its minutes.
- No `stalled` line at all for a team with open work: the hub has no verdict yet, and leaves the line out
  rather than writing 0. Wait for the next fleet read.

---

## 6. A finished team: archive, then delete — 3 min

All four commands name the **same** archive directory (`$ARCH`, set at the top). `collect` writes where
`--archive` says; `report` and `delete` look where `--dir` says, and default to `./tickets`. Give them
different places and the delete is refused on stage for an archive that is sitting in the other one.

```bash
$D delete DEMO-B                              # refused, on purpose
$D collect DEMO-B --archive "$ARCH"
$D report DEMO-B --dir "$ARCH"
$D delete DEMO-B --dir "$ARCH"
```

`--archive` is what the sheet uses on purpose. `--into <dir>` is the other form and it means "a git
repository I already have": `collect` runs `git -C <dir> fetch`, so a missing or non-git directory fails
the bundle and then the delete is refused on stage. If you want `--into`, clone the demo repo there in the
before-talk block first: `git clone "$DEMO_REPO" ~/tmp/demo-collect`.

**Audience sees.** The delete is refused: the ticket is not archived, and a team's queue history,
review rounds and commits are the only interesting part of it. Then `collect` takes the archive and the
result branch, `report` prints what the team did and how it was reviewed, and only then does `delete`
let go.

**If it does not appear.**
- `delete` succeeds the first time: DEMO-B was already archived by an earlier run. Say so and show
  `$D report DEMO-B --dir "$ARCH"` anyway.
- `collect` fails: the pod is gone. `$D delete DEMO-B --force --dir "$ARCH"` and note that the history was
  lost — which is exactly the lesson the guard exists for.
- `report` says `no archive for demo-b under ./tickets`: the two commands were given different directories.
  Pass `--dir "$ARCH"`, the one `collect` wrote to.
- `report` is thin: review rounds are counted from seats whose names start with `review`, and a
  one-seat team has none. Say that this team was one seat on purpose.

---

## 7. Something broke behind the hub's back — 2 min

```bash
kubectl -n $NS delete statefulset t-demo-c --wait=false
# the hub says so within seconds; read it from the CLI
kubectl -n $NS exec hub-0 -c daemon -- rig ps --all-hosts
$D hub-sync --dry-run
$D hub-sync
```

**Audience sees.** The hub said "unreachable" the moment the pod went, not after a human noticed. In the
rehearsal that read came back inside thirteen seconds as
`[host=t-demo-c] FAILED (remote-daemon-unreachable): host did not answer its health probe`. `--dry-run`
prints what it would reconcile — the team is registered there and nothing backs it — and `hub-sync` fixes
it, after which `rig ps --all-hosts` no longer names the team at all.

Expect `--dry-run` to **exit 1** here, and expect the `rig ps` above it to **exit 3** while a host is
FAILED. Both red codes are the finding, not a broken command — say that before you run them, so a red exit
code on screen is not read as a failure. (Pipe it through `tail`
and `$?` becomes `tail`'s; check the code on the command itself.)

**If it does not appear.**
- The hub still lists it: the fleet cache is up to a minute old. Re-read with a fresh fan-out rather than
  trusting the last frame — `kubectl -n $NS exec hub-0 -c daemon -- rig ps --all-hosts`.
- `hub-sync --dry-run` says nothing to do: it already reconciled, or the StatefulSet is still there.
  `kubectl -n $NS get statefulset t-demo-c` to check.
- Fallback if `hub-sync` itself is the thing that is broken: clean it by hand as
  [troubleshooting.md](../docs/troubleshooting.md) describes, and say that you are doing the manual
  version.

---

## 8. Cleanup — 1 min

```bash
./cleanup.sh
```

**Audience sees.** Every DEMO team archived and deleted, their volumes and their Secrets gone, the stall
threshold back to what it was, and the script's own end-state check: no demo team left, no demo Secret
left, no demo volume left, the hub's registry empty, the threshold restored. The threshold goes back even
when a delete was refused — a step that stops on stage must not leave the hub lowered for whoever uses it
next. It refuses to touch a team it did not start, and it is safe to run twice.

**If it does not appear.**
- It prints `FAIL:` lines: they name exactly what is left. Fix that, run it again.
- It refuses a ticket name: only `DEMO-A`, `DEMO-B` and `DEMO-C` are ever touched, by design.
- A team will not delete: `$D delete <ticket> --force`, then `./cleanup.sh` again.

---

## After the talk

```bash
./cleanup.sh
kubectl -n $NS get pods          # only hub-0
```

Then put the stall threshold back for real if `cleanup.sh` somehow did not: `kubectl -n $NS exec
hub-0 -c daemon -- rig config get fleet.stall_threshold_minutes` should say what it said before the
talk (30 by default).

## If the whole thing goes wrong

The talk does not need the cluster to be alive: `$D report DEMO-B` and `$D status` print the story of a
real team from its archive, and the rehearsal recording covers the rest. Say what broke, show the
archive, and take questions.
