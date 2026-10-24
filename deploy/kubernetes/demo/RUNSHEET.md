# The demo run sheet

Fifteen minutes, on one small cluster, showing what the Kubernetes factory does. Every command here is
meant to be pasted. Times are for the whole step, including the typing.

**What you are showing.** One command turns a ticket into a running team of agents in its own pod, one
hub shows every team at once, a human answer goes back into the team and is recorded as a human answer,
a quiet team is caught as stalled, a finished team is archived before it can be deleted, and a team
destroyed behind the hub's back is reconciled. Three teams: **DEMO-A** is waiting for a decision,
**DEMO-B** is finished, **DEMO-C** is started live and is still working.

Set these once, in the terminal you present from. Run everything **from this directory**
(`deploy/kubernetes/demo`) — that is what makes the dispatcher path below work without a machine-specific
absolute path in it:

```bash
export NS=openrig
export D=../dispatcher/rig-dispatch    # the dispatcher, one directory over
```

> If you present from somewhere else, set `D` to wherever the dispatcher is. Everything below assumes
> `jq`, `kubectl` and `KUBECONFIG` pointing at the cluster, which you already had working when you ran
> `prepare.sh`. Do not set `Q_A` here — it comes after `prepare.sh`, which is step 1 below.

---

## Before the talk

An hour before, in a plain terminal:

1. `cd <this directory> && ./prepare.sh`
   It checks the cluster, applies the kit, lowers the stall threshold to 3 minutes, starts DEMO-A and
   DEMO-B one at a time, and waits until A is waiting for a human and B is done. It prints the next two
   commands when it is finished. Expect a few minutes; it is starting two pods and two agents.
2. Start the port-forward it printed: `kubectl -n $NS port-forward pod/hub-0 17433:7433 &`
3. Start the hub TUI it printed, in the window you will present, and leave it on **PULSE**:
   `OPENRIG_HOME=$HOME/.openrig-hub-view OPENRIG_URL=http://127.0.0.1:17433 node "$(npm root -g)/@openrig/cli/tui/dist/main.js" --url http://127.0.0.1:17433`
   The title line names the host it reads. If it says something other than `hub-0`, you are looking at
   a local daemon: `Ctrl-C`, check `OPENRIG_URL` is set, start it again.
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

Right before you start: DEMO-A is under **NEEDS YOU**, DEMO-B shows `result:done`, and nothing else is
running. `$D status` prints all three.

---

## 1. Start a team live — 2 min

```bash
$D start DEMO-C --repo https://github.com/kampfhamster309/openrig-demo --ref main \
   --spec /etc/openrig-kit/rig-one.yaml --brief-file ./briefs/DEMO-C.md \
   --cpu 200m --memory 1536Mi --storage 2Gi
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

---

## 2. The hub sees every team — 3 min

In the TUI window:

- **PULSE** — `DEMO-A`'s question is under **NEEDS YOU**, with a dim `[t-demo-a]` label on the row: that
  label is which team pod it came from. It is also under **⚑ STALLED**, and this is the moment that is true:
  it parked an hour ago, it holds open work, and a parked row makes no queue transitions. Say so here, and
  say why — step 5 refers back to this row, because after step 3 answers it the stall clock has restarted.
- Press into **TOPOLOGY** and expand `t-demo-c` — a remote team opens into its rig and its seats, the
  same as a local one, because the hub reads each team's daemon over the cluster network.
- Back on the main page, above the seat table, **FLEET USAGE · last 1h** — what the teams have spent.
  It is a block on the hub's own instance page, not a page of its own, and it renders only while the hub
  has remote hosts registered: with no team up it shows nothing at all, which is not a fault.

Then the same reads from the command line, which is what the TUI is doing:

```bash
OPENRIG_HOME=$HOME/.openrig-hub-view OPENRIG_URL=http://127.0.0.1:17433 rig ps --all-hosts --nodes -A
OPENRIG_HOME=$HOME/.openrig-hub-view OPENRIG_URL=http://127.0.0.1:17433 rig usage top --all-hosts
```

`--nodes` across hosts needs the `-A`: without it `rig ps` refuses and prints the ladder it wants
(`per-node fan-out requires the FULL explicit ladder`). That is the command's rule, not a fault here.

**Audience sees.** Every seat of every team in one screen, each row carrying its team, and usage that
adds up across hosts. No agent runs on your machine.

**If it does not appear.**
- The TUI shows your own rigs: `OPENRIG_URL` is not set in that window. Restart it with the line above.
- A team is `unreachable`: the port-forward died (it dies when the machine sleeps). `kill %1`, start it
  again, wait ten seconds.
- The CLI lists hosts that are not teams: it used your local registry. Use the `OPENRIG_HOME=` prefix
  exactly as written — that is the whole trick.
- Fallback that needs no port-forward at all: `kubectl -n $NS exec hub-0 -c daemon -- rig ps
  --all-hosts --nodes -A`.

---

## 3. Answer the team, as a human — 3 min

From the TUI, on the NEEDS YOU row:

```
answer <qitem> Use '<words> <lines>' (B)
```

or from the shell:

```bash
$D answer DEMO-A "$Q_A" "Use '<words> <lines>' (B)"
```

Then show what the team now has, and who it thinks it came from:

```bash
kubectl -n $NS exec t-demo-a-0 -c daemon -- sh -c \
  'curl -fsS -H "Authorization: Bearer $(cat "$HOME/.openrig/terminal-token")" \
   "http://127.0.0.1:7433/api/mission-control/audit?qitem_id='"$Q_A"'&limit=5"' |
  jq '.rows[] | {verb: .actionVerb, reason, origin: .auditNotes.openrig_relay.from_host}'
```

**Audience sees.** The answer lands, and the audit row says `resolve`, carries the decision text, and
names `hub-0` as the host it came from — recorded as a human answering, with the hub as the origin,
not as some bot poking the pod.

**If it does not appear.**
- `answer: no Ready hub pod` or `not registered on the hub`: the dispatcher falls back to resolving
  inside the pod, which records the lead instead of a human. Say so out loud — the fallback is the
  designed behaviour — and check the hub with `$D hub-sync --dry-run`.
- The audit read comes back empty: the row is there but not first. Raise `limit=5` to `limit=20`.
- The TUI's `answer` refuses: use the `$D answer` line; it does the same thing through the hub.

---

## 4. Watch the team take it up — 2 min

```bash
$D watch DEMO-A --timeout 300; echo "exit $?"
```

**Audience sees.** The event stream: the queue item moving, then the status read that names the phase,
then the verdict. Say what the codes mean: **0** done, **3** it needs a human, **1** any other failure,
**4** out of time — so the same command works as a build step, not just as a show.

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

DEMO-C is sized so that at this point in the talk it is **still working and has not touched its queue for
over three minutes**: the brief is two parts, and the first rehearsal should time it past the eight minutes
step 5 lands at. That is the assumption being tested here, and the rehearsal is where it is confirmed. In
the TUI, **PULSE → ⚑ STALLED** shows `<rig> — Nm since last progress, N open · threshold 3m`. The same
verdict, as a number:

```bash
curl -s localhost:17433/metrics | grep -E 'openrig_fleet_(host|rig)_stalled|stall_threshold'
```

**Audience sees.** The stall, twice: once as a sentence in the TUI and once as a metric line, from the
same hub, with no Prometheus anywhere near it.

**If it does not appear.**
- The fallback is a **callback, not a live check**. Do not go pointing at DEMO-A now: step 3 answered it, and
  that answer is itself a queue transition made by a human, which restarts its stall clock. By step 5 it has
  been four minutes of answered, working, maybe finished — no badge, and saying otherwise would be wrong.
  Instead, refer back: "you saw this on DEMO-A in step 2 — that row was NEEDS YOU and STALLED at the same
  time, for exactly this reason." It was genuinely stalled there: parked on a human, holding open work, and
  a parked row makes no queue transitions.
- DEMO-C finished early and closed its item: a scope with no open work is never stalled, and no badge is
  correct. Use the step 2 callback above.
- DEMO-C is working but its clock keeps restarting: the orchestrator seat posting progress notes onto its
  own item counts as queue transitions, and each one resets the timer. That is the rule working, not a
  fault — and it is why the rehearsal counts C's transitions, not only its minutes.
- No `stalled` line at all for a team with open work: the hub has no verdict yet, and leaves the line out
  rather than writing 0. Wait for the next fleet read.
- `curl` refuses: the port-forward died. Restart it.

---

## 6. A finished team: archive, then delete — 3 min

```bash
$D delete DEMO-B            # refused, on purpose
$D collect DEMO-B --archive ~/tmp/demo-archive
$D report DEMO-B
$D delete DEMO-B
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
  `$D report DEMO-B` anyway.
- `collect` fails: the pod is gone. `$D delete DEMO-B --force` and note that the history was lost —
  which is exactly the lesson the guard exists for.
- `report` is thin: review rounds are counted from seats whose names start with `review`, and a
  one-seat team has none. Say that this team was one seat on purpose.

---

## 7. Something broke behind the hub's back — 2 min

```bash
kubectl -n $NS delete statefulset t-demo-c --wait=false
# the TUI: t-demo-c goes unreachable, then its rows go away
$D hub-sync --dry-run
$D hub-sync
```

**Audience sees.** The hub said "unreachable" the moment the pod went, not after a human noticed.
`--dry-run` prints what it would reconcile — the team is registered there and nothing backs it — and
`hub-sync` fixes it. The TUI is clean again.

Expect `--dry-run` to **exit 1** here. Drift is what it reports, and a non-zero exit is it doing its job —
say that before you run it, so a red exit code on screen is not read as a failure.

**If it does not appear.**
- The TUI still shows it: the fleet cache is up to a minute old. Re-read from the CLI instead —
  `OPENRIG_HOME=$HOME/.openrig-hub-view OPENRIG_URL=http://127.0.0.1:17433 rig ps --all-hosts` — and the
  row is gone there even while the TUI still holds its last good frame.
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
