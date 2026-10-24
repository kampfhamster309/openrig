# Operating the factory

Day-to-day work with team pods: running tickets, answering teams, keeping their history, cleaning up,
upgrading. Setup is in [setup.md](setup.md), watching the fleet in [monitoring.md](monitoring.md),
and every flag and variable in [reference.md](reference.md#rig-dispatch).

```bash
export KUBECONFIG=<the cluster's kubeconfig>
NS=openrig
D=deploy/kubernetes/dispatcher/rig-dispatch
```

## The life of a ticket

```text
start ──> starting ──> ready ──> up ──> working <──> blocked ──> result:done | result:failed | result:needs-human
                                          │                              │
                                       degraded (a seat is not running; wait restores it)
                                                                         │
                                         answer (needs-human) ───────────┘
collect = archive + fetch the result branch ──> report ──> delete (guarded by the archive)
```

| Phase | Meaning |
|---|---|
| `absent` | No team for this ticket. |
| `starting` | The pod exists but is not Ready yet (image pull, clone). |
| `ready` | The pod is Ready; the rig is not up yet. |
| `up` | The rig is up; the ticket is not handed over yet. |
| `working` | The ticket is with the team and nothing is blocked. |
| `blocked` | At least one open queue item is blocked, on a seat or on a human. |
| `degraded` | At least one seat is not running. `wait` brings the rig back; `watch` reports it. |
| `result:<status>` | The team wrote `result.json` with that status: `done`, `failed` or `needs-human`. |

## Starting a ticket

```bash
$D start PROJ-123 --repo https://github.com/org/repo.git --ref main --brief-file proj-123.md
```

- **Objects.** Per ticket, a Secret with the team's own bearer and a one-replica StatefulSet `t-<slug>`
  (pod `t-<slug>-0`, labels `openrig.dev/role=team` and `openrig.dev/ticket=<slug>`), whose volume is
  deleted with it. The slug is the ticket key in lower case, with anything other than letters, digits
  and `-` replaced, cut to 40 characters: `PROJ-123` becomes `proj-123`.
- **Workspace.** On first boot the pod clones `--repo` at `--ref` into `/home/openrig/work/project`.
  `--ref` must be a branch or a tag (it is passed to `git clone --branch`), not a commit id.
- **The rig.** `rig up` of `--spec` (default `/etc/openrig-kit/rig.yaml`) inside the pod.
- **The ticket.** The brief goes to the lead (`--lead`, default `orch.lead`) as a queue item tagged
  `ticket:<slug>`, with a completion contract appended: commit on `ticket/<slug>`, have the reviewer
  approve, write `/home/openrig/work/result.json`, close the queue items, do not push.
- **The hub.** Once the ticket is handed over, `start` registers the team on the hub as host
  `t-<slug>`, so every view on the hub shows it. See [The hub](#the-hub-and-registration).
- **Per-ticket settings.** `--cpu`, `--memory`, `--storage`, `--image`, `--env NAME=VALUE` (added to
  `dispatcher/team.env`), `--ready-timeout` (seconds, default 600).
- **Repeatable.** All state is in labels and annotations (`openrig.dev/rig`, `openrig.dev/qitem`, ...)
  and in the pod. Running `start` again for the same ticket resumes where it stopped, and never hands
  the ticket over twice.

Start tickets one at a time when the cluster is small; each pod pulls the image (once per node),
clones the repository and launches its seats.

## Following a ticket

```bash
$D status                 # every ticket: phase, seat activity, open queue items, result summary
$D status PROJ-123 --json
$D watch PROJ-123         # follow the team's events; exit 0 done, 3 needs-human, 1 failed, 4 timeout
$D watch --all --collect  # every team at once, collecting each one that finishes
$D wait PROJ-123          # the same exit codes, by polling every 30 s
```

`watch` is the default way to follow a ticket. `wait` stays for scripts that prefer polling and as the
fallback `watch` uses when no event stream can be opened. Only `wait` brings a degraded rig back
(`rig up <rig> --existing`); `watch` reports the phase, so run `wait` or `start` for that ticket.

**Stall nudges (`wait` only).** If neither the open queue items nor the workspace (HEAD, working tree)
change for `--stall` minutes (default 20), `wait` sends the lead a message to check every seat and
either unblock it or write `needs-human`. This catches a seat stuck in a loop while its lead sits idle.
The hub's own stall verdict, which needs no dispatcher, is in
[monitoring.md](monitoring.md#the-stall-verdict).

### How `watch` works

Each team daemon publishes its queue state machine as server-sent events on `GET /api/events`.
`watch` subscribes to that stream over pod-local loopback (the same `kubectl exec` path every other
command uses) and reacts when a queue item reaches a terminal state or becomes blocked (on a seat or on
a person; a blocked item is reported as "a human may be needed"). It prints the transition as it happens, reads the ticket's phase once to say what it means, and exits with
`wait`'s codes. `--collect` runs `collect` for a ticket that finished, `--all` watches every team pod at
once, and `--state-dir` moves the resume store (default `~/.rig-dispatch/watch`, or
`RIG_DISPATCH_WATCH_DIR`).

A queue item reaching a terminal state is not the ticket finishing: seats close items at every handoff.
So `watch` reports those transitions and takes the ticket's own verdict from the same read `status`
uses, which is the only place `result.json` is seen.

**Resume.** The last event id seen is stored per ticket *instance* (next to the `openrig.dev/qitem` id
that `start` writes) and sent back as `Last-Event-ID`, so a dropped stream or a restarted watcher
continues where it stopped. The team daemon replays from its own database, an append-only `events`
table whose ids are never reused, so on one volume replay reaches everything since the first event,
also across a daemon restart. An id that belongs to a different instance (a ticket key deleted and
started again) is dropped and the watch starts from 0; `delete` removes the stored id for the same
reason. Only the default store is cleaned: ids stored with `watch --state-dir` stay behind.

**What resume cannot see.** A stored id cannot tell a fresh volume from a quiet stream, and the daemon
offers no way to ask. Replay from `Last-Event-ID: N` returns only events after N, so a pod that came
back on a new volume sends nothing until its own ids pass N. The watch does not depend on noticing that:
every `RIG_DISPATCH_WATCH_BACKSTOP` seconds (default 180) that the stream has been quiet, it reads the
ticket's status anyway and logs that read as the backstop, not as an event.

**Bounds.** The deadline (`--timeout`) is checked while the stream is open, so it holds even when no
event arrives. One stream lasts at most `RIG_DISPATCH_EVENTS_MAX_TIME` seconds (default 300) and is then
reopened from the stored id, so a reader whose `kubectl` died cannot outlive the watch. Every exit stops
the watch's own reader, on the operator machine and in the pod. After three attempts that produce no
stream at all, `watch` says so and hands the ticket to `wait`.

**One unreadable event row blocks replay from before it.** The daemon's live path skips a malformed
event and emits `event.delivery_poisoned`, but its replay path does not. If such a row lies above the
stored id, every reconnect from that id fails before any event is sent. The watch then either reconnects
every `--reconnect` seconds or, after three dead connections, falls back to polling with a "would not
stay open" message. Either way the backstop status read still reports the ticket, so this costs latency,
not correctness.

## Answering a team

A team that needs a decision blocks an item on a human, or writes `result.json` with `needs-human`. You
see it in the TUI's NEEDS YOU, in `status`, and as exit code 3 from `watch` or `wait`. Answer it:

```bash
$D answer PROJ-123 <qitem> "Use the existing retry helper."
```

or, from the TUI on the hub, `answer <qitem> <decision>` on the remote item, or from any shell that
reaches the hub:

```bash
kubectl -n $NS exec -i hub-0 -c daemon -- \
  rig queue resolve --host t-proj-123 <qitem> --decision "Use the existing retry helper."
```

**Why through the hub.** The dispatcher runs `rig queue resolve --host t-<slug>` in the hub pod with no
seat in its environment, so the answer is recorded on the team's host as a human (`human@host`, with
`claimed:v1` provenance), and the hub adds its own host id to the audit row as
`auditNotes.openrig_relay.from_host`. That is how the archive later says who answered and from where.

**Fallback.** `answer` resolves inside the team pod as its lead only when the hub could not do it: no
Ready hub pod, the team not registered on the hub, or a failure on the hub's side. The fallback is
logged and records the lead, not a human, because a bare `kubectl exec` shell has no human identity.

**When the outcome is unclear.** A refusal from the team itself (`remote_action_failed` with
`failureClass: remote-error`) is reported and exits 1; it is never re-issued under a seat's name. Any
other failure could still have reached the team (a timeout, an interrupted response), so `answer` reads
the item in the pod first. Still parked on a human means the write did not land, and the fallback runs.
Otherwise the team's audit rows decide: `answer` exits 0 only when they hold a `resolve` with this
decision and a `from_host`. An item that cannot be read, or one that moved without such an audit row,
exits **5**: the answer is not confirmed, and nothing was re-issued. Check the item in the team pod
(`kubectl -n $NS exec t-<slug>-0 -c daemon -- rig queue show <qitem>`) before answering again.

## Collecting the result and the history

```bash
$D archive PROJ-123                          # the history only; root ./tickets, $RIG_DISPATCH_ARCHIVE_DIR or --dir
$D collect PROJ-123 --into ~/src/repo        # archive, then bundle the result branch and fetch it
$D report PROJ-123                           # figures for one ticket
$D report --all --json                       # every archived ticket, for machines
```

A team's whole history lives on its pod volume, and `delete` takes the volume with it. `archive` copies
out everything that explains the ticket while the pod is still there, so `report` can answer later how
long it took, how many review rounds and handoffs it needed, who made each human decision and from
which host, and what it used.

One directory per ticket, `<root>/<slug>/`:

| File | What it holds |
|---|---|
| `manifest.json` | every part with `ok` or `failed`, its row count and its error, plus `complete` |
| `status.json` | what `status` sees: phase, seats, open queue items, the result |
| `queue.json` | every queue item in the team's pod, all fields, up to `RIG_DISPATCH_QUEUE_LIMIT` rows (default 100000) |
| `nodes.json` | the seats and their state |
| `events.json` | the event stream, paged to the end, with any coverage gaps the daemon reported |
| `queue-transitions.json` | the queue-transition stream, paged to the end |
| `audit-<qitem>.json` | the mission-control audit rows for each of the ticket's queue items |
| `usage-<seat>.json`, `usage-top.json` | the usage samples per seat, and the daemon's top-burn window |
| `result.json` | the pod's `result.json`, unchanged |
| `result.bundle` | only from `collect`: the commits on `ticket/<slug>` the remote does not have |

- **A failed part costs that part, not the archive.** Everything readable is written, the failed part is
  named in the manifest with its error, and `archive` exits non-zero. A paged read whose cursor stops
  advancing fails its part instead of writing a truncated history that looks complete.
- **Re-running replaces the directory as a whole.** The archive is built in a temporary directory next to
  the target and swapped in, so a run never leaves a mix of old and new files. A crash during the swap
  leaves the previous archive at `.<slug>.old.*`. Note: a re-run whose part fails replaces an archive
  that had that part; run `archive` again while the pod still exists to get it back.
- **`collect` archives first, then bundles.** The history is what cannot be recovered later. A failed
  bundle or fetch is recorded as the `bundle` part and makes `collect` exit non-zero, without discarding
  the archive. A ticket with no result branch, or with nothing the remote lacks, is recorded with a note
  and `collect` exits 0.
- **Getting the change in.** `--into <repo>` fetches the bundle into that local repository as the ref
  `refs/tickets/<slug>` (`git checkout -b ticket/<slug> refs/tickets/<slug>`). From there it is an
  ordinary branch: review it, push it, open a pull request. Team
  pods hold no Git push credentials.

`report` reads only the archive, so it works after `delete`. Its figures:

- **duration**: first to last archived event. Not the pod's lifetime; with coverage gaps, a lower bound.
- **reviewRounds**: queue items addressed to a `review*` seat (stuck-sweep recovery items excluded). A
  review done inside a seat's own turn without a queue item is not counted.
- **handoffs**: archived queue transitions that closed a handoff (`handed-off`, or `done` with
  `handed_off_to`). Handoffs outside the queue leave nothing to count.
- **humanDecisions**: archived audit rows that are a `resolve`, each with who gave it and, for an answer
  relayed through the hub, the host it came from. An answer typed inside the team's pod has no origin
  host, and `report` says so.
- **usage**: per seat, the sum of positive token deltas across the archived samples, the same rule the
  daemon's top-burn uses. Samples of cumulative counters, **not exact token accounting**: a stretch
  between two samples is invisible, and a counter that goes down counts as a reset. `usage-top` is the
  hour before the archive ran and is reported as a window, never summed into the total.

### Keeping archives in object storage

The archive is a plain directory of small files, so moving it off the operator machine is a bucket copy
of `<root>`, run after each `collect` or on a schedule:

```bash
aws s3 sync <root> s3://<bucket>/tickets/ --exclude '.*'
# or: rclone copy <root> remote:tickets/ --exclude '.*/**'
# or: gsutil -m rsync -r -x '/\..*' <root> gs://<bucket>/tickets/
```

Exclude the dot-directories: during a run, the scratch directory `.<slug>.partial.*` sits inside
`<root>`, and copying it (or a leftover `.<slug>.old.*`) puts a partial archive in the bucket. Since a
re-run swaps the whole directory in, a sync that skips dot-directories never sees a half-written
archive, and `report --dir` reads a synced copy unchanged. Retention, versioning and a server-side
`report` are not built.

## Deleting a team

```bash
$D delete PROJ-123            # refuses unless the ticket has a complete, current archive
$D delete PROJ-123 --force    # deletes anyway, and says so
```

`delete` removes the StatefulSet, its volume, its Secret, the team's entry on the hub and the stored
`watch` id. The guard runs before anything is touched, so a refused delete changes nothing. It refuses
when:

- a part of the archive failed, or a file is missing, empty, truncated, or holds a row count different
  from the manifest's (the message names each one);
- the archive is not current: taken from an earlier team under the same ticket name, or the team wrote
  more events or transitions since (the guard compares the StatefulSet's creation time and each stream's
  current high-water mark with what the archive recorded).

Run `archive` (or `collect`) again and repeat the `delete`.

## The hub and registration

The hub is one more OpenRig daemon from the same image, with no rigs, no agent credentials and its own
volume for `hosts.yaml`, `config.json` and one bearer file per team. What it shows is in
[monitoring.md](monitoring.md).

- **The dispatcher keeps it in step.** `start` registers a team after handing over the ticket: the bearer file
  at mode 0600, `rig host add --id t-<slug> --transport http`, and
  `feed.subscriptions.t-<slug>.enabled true`, so the hub reads the team's queue state and not just its
  reachability. `delete` unregisters it with `rig config reset` and removes the team's alias from
  `host-bindings.json`. Both steps are idempotent. With no Ready hub pod they are skipped, and the
  dispatcher works as without a hub. When that keeping-in-step is missed, `hub-sync` repairs it.
- **Registration comes after the hand-over, on purpose.** A hub that is Ready but failing (no
  `pods/exec`, a full volume, a `hosts.yaml` that `rig host add` refuses) must never leave a team running
  without its ticket. `start` hands the ticket over first, then registers, and still exits non-zero with
  a clear error if registration fails.
- **`hub-sync` repairs the registry when it drifts.** A team's registration is four things that have to
  move together -- its `hosts.yaml` entry, its bearer file, its `feed.subscriptions.t-<slug>.enabled`,
  and its alias in `host-bindings.json` -- and only `start` and `delete` move them. So a hub that was
  not Ready, a StatefulSet removed some other way, or two edits that interleaved leaves the hub
  disagreeing with the cluster until something repairs it:

  ```bash
  $D hub-sync --dry-run    # what disagrees; changes nothing
  $D hub-sync              # repair, then re-read and confirm
  ```

  It registers a team that was handed over and is Ready but is missing or incomplete -- no bearer file,
  a bearer file that is empty or no longer holds what the team's Secret holds, the subscription off, a
  transport, url or bearer path that is not what `start` writes -- it unregisters an entry whose team is
  gone, and it leaves alone a team that was not handed over or whose pod is not Ready, saying which it
  found and what it did. It also finishes an unregister that stopped halfway: when a `delete` removed the
  `hosts.yaml` entry and then failed, the bearer file, the subscription and the alias are left with no
  entry pointing at them, and those are found from their own names rather than missed. It exits 0 only
  when a fresh read of both the hub and the cluster says they agree, and running it twice does nothing
  the second time. Exit codes are in [reference.md](reference.md#commands).

  A cluster read that fails stops the whole run before it touches anything, and says which read failed.
  That is the important one to be strict about: a list that did not answer is not a cluster with no teams
  in it, and treating it that way would unregister every live team and then report a match.

  It touches only what the dispatcher wrote: an entry whose id names a team that exists, an entry that is
  exactly what `start` writes, or a leftover part whose `t-<slug>` name no entry claims. A host you
  registered by hand is left alone, including one whose id happens to begin with `t-`.
- **A hub that is down at the wrong moment leaves residue.** If the hub is not Ready when `start` runs,
  the team is not registered: run `start <ticket>` again once the hub is Ready; it resumes without
  handing the ticket over twice. If the hub is not Ready when `delete` runs, the team is gone but the hub
  keeps its host, bearer file and subscription. Both cases log what is left and name `hub-sync`, which
  is the way to clean up: run it once the hub is Ready.

  Cleaning by hand is the fallback, for when the dispatcher cannot reach the hub at all:

  ```bash
  kubectl -n $NS exec -i hub-0 -c daemon -- rig config reset feed.subscriptions.t-<slug>.enabled
  kubectl -n $NS exec -i hub-0 -c daemon -- rm -f /home/openrig/.openrig/hosts.d/t-<slug>.bearer
  # then remove the t-<slug> entry from /home/openrig/.openrig/hosts.yaml (there is no `rig host remove`)
  # and the t-<slug> alias from /home/openrig/.openrig/host-bindings.json, if it has one
  ```

- **Registry edits are serialized in the hub.** Every edit `start`, `delete` and `hub-sync` make runs
  under one lock in the hub's own volume, so a `start` and a `delete` for two different tickets cannot
  each read a `hosts.yaml` the other has not written yet and drop an entry. A second edit waits its
  turn; if it waits longer than `RIG_DISPATCH_HUB_LOCK_TIMEOUT` (default 60s) it gives up and says the
  hub is busy, which is a different thing from the edit having failed. One command is still several
  edits, so a crash in the middle can leave a team half-registered, and `hub-sync` is what repairs
  that.
- **Restarts.** The hub's registry, bearer files and settings are on its volume and survive a restart or
  an image change. Its fleet cache is in memory and refills on the first read.

## Upgrading

- **OpenRig or agent CLI versions.** Build a new image ([setup.md](setup.md#2-build-and-publish-the-image)),
  set the new tag in the three kustomizations, and apply:

  ```bash
  kubectl apply -k deploy/kubernetes          # new team pods get the new tag
  kubectl apply -k deploy/kubernetes/hub      # rolls hub-0
  kubectl -n $NS rollout status statefulset/hub
  ```

  The tag is fixed per team when `start` creates it, so running teams keep their image and are not
  disturbed. The hub reads team pods only through routes that older images also serve, so a hub may be
  newer than its teams. The operator's CLI and TUI must be no older than the hub.
- **The kit** (rig spec and guidance): edit `kit/`, then `kubectl apply -k deploy/kubernetes`. Running
  teams keep the rig they started with; new tickets use the new spec.
- **The dispatcher** is a script in the repository. Update the checkout; tickets in flight continue,
  because their state is in Kubernetes, not in the script.

## Capacity and cleanup

- **Teams in flight.** Put a `ResourceQuota` on the namespace to cap them. `start` does not queue
  tickets beyond it yet. A full quota rejects the pod: the StatefulSet exists but no pod is created
  (`kubectl describe statefulset t-<slug>` shows `FailedCreate`), and `start` fails with "was not
  created". Too little node capacity instead leaves the pod Pending until `--ready-timeout`. In both
  cases run `start` again later; it resumes.
- **Requests.** Set `--cpu`, `--memory` and `--storage` per ticket, from measurements of your own
  workload.
- **Forgotten teams.** `status` lists every team pod. A team whose ticket is done, archived but not
  deleted (for example after the operator machine went away) is removed with `archive` and `delete`.
  A periodic sweep for these is not built.
- **Archives** are small: about 100 KB for a short ticket in tests, growing with the number of events.

## A long-lived host

[`single-host/`](../single-host) runs one host `rig-0` with a 20Gi volume that you drive by hand, like a
VPS. It is outside the dispatcher's flow and useful for a standing team or for experiments.

```bash
kubectl apply -k deploy/kubernetes/single-host
kubectl -n $NS rollout status statefulset/rig
kubectl -n $NS port-forward pod/rig-0 17434:7433 &
rig host add --id rig-0 --transport http --url http://127.0.0.1:17434 \
  --bearer-file ~/.config/openrig/rig-0.bearer
rig up /etc/openrig-kit/rig.yaml --host rig-0 --yes
rig ps --host rig-0 --nodes -A
rig send <seat>@<rig>@rig-0 "..."
rig capture <seat>@<rig>@rig-0 --lines 40
```

- It needs the `openrig-daemon` Secret ([setup.md](setup.md#3-namespace-and-secrets)); the bearer file
  is what `create-secrets.sh` generates.
- `rig up --host` sends the path, not the file, so the spec must exist in the pod: that is what the kit
  mount is for.
- The `http` transport has no live attach. Use `send`, `capture` and `transcript`, or
  `kubectl -n $NS exec -it rig-0 -- tmux attach -t <session>`.
- A pod restart stops the seats. Bring them back with `rig up <rig> --existing --host rig-0`; the
  daemon state, sessions and workspace survive on the volume.
- `rig host doctor rig-0` reports `remote-rig-binary` as UNKNOWN over http, which is expected.
  `rig host doctor rig-0 --posture product-factory-vps` flags the non-loopback bind; that profile is
  aimed at a public VPS.
