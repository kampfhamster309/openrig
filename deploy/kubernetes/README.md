# OpenRig on Kubernetes

A pod that runs an OpenRig daemon, its tmux server and every seat of the rigs sent to it. From
the operator machine it is a remote host over the `http` transport, like a VPS, so `rig up --host`,
`rig send|capture --host` and `agent@rig@host` addressing work unchanged. Background:
[transport-and-transcripts.md](../../docs/as-built/architecture/transport-and-transcripts.md).

Tried on a single-node k3d cluster (K3s v1.36, `local-path` storage) with the `claude-pi-k8s`
rig in [kit/rig.yaml](kit/rig.yaml): a Claude Code lead, a Pi builder on a local
OpenAI-compatible model, and a Claude Code reviewer.

## What is here

| Path | What it is |
|---|---|
| `image/` | Image: Node 22, tmux, OpenRig packed from this checkout, Claude Code and Pi, pinned. The entrypoint runs the daemon in the foreground. |
| `build-image.sh` | Builds the image (`--push` to push). Prints the tag, `<version>-<commit>`. |
| `create-secrets.sh` | Creates the three Secrets, prompting for each token. |
| `dispatcher/` | `rig-dispatch`: one team pod per ticket (see below), and `team.env`, the env every team pod gets. |
| `dispatcher/test/` | `archive-test.sh`: runs the dispatcher's archive, report, delete guard and answer paths against a fake `kubectl` serving recorded responses. No cluster needed: `bash dispatcher/test/archive-test.sh`. |
| `hub/` | The hub: one more daemon from the same image, no rigs, whose `hosts.yaml` lists every team pod (see below). |
| `HUB-TEST.md` | What the hub was observed to do on a real cluster, item by item, with the evidence. |
| `manifests/` | Shared objects: namespace, the `teams` Service the team pods join, NetworkPolicy. |
| `single-host/` | Optional: one long-lived host, pod `rig-0` (StatefulSet with a 20Gi volume, Service). |
| `kit/` | Mounted read-only at `/etc/openrig-kit` from a ConfigMap: the rig spec, the lead's guidance, `pi-seat-status`, the Pi heartbeat extension and the Pi `models.json`. |
| `kustomization.yaml` | The shared objects and the kit ConfigMap; pins the image tag new team pods get. |

## Deploy

```bash
export KUBECONFIG=...                       # the cluster
deploy/kubernetes/build-image.sh --push     # after `docker login ghcr.io`; set the printed tag in kustomization.yaml
kubectl apply -f deploy/kubernetes/manifests/namespace.yaml
deploy/kubernetes/create-secrets.sh         # GHCR read token, Claude token from `claude setup-token`
kubectl apply -k deploy/kubernetes          # shared objects; team pods then come from the dispatcher
kubectl apply -k deploy/kubernetes/hub       # optional: the hub, the one point of truth for all teams
kubectl apply -k deploy/kubernetes/single-host   # optional: one long-lived host, rig-0
kubectl -n openrig rollout status statefulset/rig
```

The Secrets:

| Secret | Key | Used for |
|---|---|---|
| `openrig-daemon` | `bearer` | `OPENRIG_AUTH_BEARER_TOKEN` of the single host. The script generates it into `~/.config/openrig/rig-0.bearer`. Team pods get their own, from the dispatcher. |
| `openrig-agents` | `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code seats, in every pod. Named in `OPENRIG_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST`, or it never reaches them. |
| `ghcr-pull` | | Pulling the private image. |

## Connect to the single host and run a rig

The Service is cluster-internal. Reach it with a port-forward, and register the pod once:

```bash
kubectl -n openrig port-forward pod/rig-0 17433:7433 &
rig host add --id rig-0 --transport http --url http://127.0.0.1:17433 \
  --bearer-file ~/.config/openrig/rig-0.bearer
rig host doctor rig-0                       # remote-rig-binary is UNKNOWN over http; that is expected

rig up /etc/openrig-kit/rig.yaml --host rig-0 --yes
rig ps --host rig-0 --rig claude-pi-k8s --nodes
rig send orch-lead@claude-pi-k8s@rig-0 "..."
rig capture orch-lead@claude-pi-k8s@rig-0 --lines 40
```

`rig up --host` sends the path, not the file, so the spec must exist in the pod. That is what the
kit mount is for. For a live terminal, `kubectl -n openrig exec -it rig-0 -- tmux attach -t <session>`.

## One pod per ticket: the dispatcher

`dispatcher/rig-dispatch` creates a team pod for a ticket, hands the ticket to the rig's lead, follows
it, collects the result and deletes the pod. Design: stage 1 of the factory proposal
(`docs/proposals/factory-on-kubernetes.md`, kept locally).

```bash
export KUBECONFIG=...
D=deploy/kubernetes/dispatcher/rig-dispatch
$D start PROJ-123 --repo https://github.com/org/repo.git --ref main --brief-file proj-123.md
$D status                      # every ticket: phase, seat activity, open queue items, result summary
$D wait PROJ-123               # exit 0 done, 1 failed, 3 needs-human, 4 timeout
$D watch PROJ-123              # same exit codes, driven by the team's events instead of polling
$D watch --all --collect       # every team at once, collecting each one that finishes
$D answer PROJ-123 <qitem> "Use the existing retry helper."
$D archive PROJ-123            # copy the ticket's history out to ./tickets/proj-123
$D collect PROJ-123 --into ~/src/repo   # archive, then bundle the result branch and fetch it
$D report PROJ-123             # figures from the archive alone; --all, --json
$D delete PROJ-123             # refuses unless the ticket has a complete archive; --force to override
```

- **Objects:** per ticket a Secret and a one-replica StatefulSet `t-<slug>` (pod `t-<slug>-0`, labels
  `openrig.dev/role=team`, `openrig.dev/ticket=<slug>`), whose volume is deleted with it. They share the
  kit ConfigMap, the `openrig-agents` Secret (passed in as env), the `teams` Service and the
  NetworkPolicy. Each team has its own bearer.
- **Reaching the pods:** only `kubectl exec`; inside the pod, `rig` talks to its daemon over loopback.
  No port-forward or `hosts.yaml` entry is needed.
- **The ticket** goes to the lead as a queue item tagged `ticket:<slug>`, with a completion contract
  appended: commit on `ticket/<slug>`, have the reviewer approve, write `/home/openrig/work/result.json`.
- **State** is in labels and annotations (`openrig.dev/rig`, `openrig.dev/qitem`, ...), so every command
  can be repeated. `start` on an existing ticket resumes; `wait` restores the rig if the pod restarted.
- **Defaults:** `dispatcher/team.env` holds env every team pod gets; `--env NAME=VALUE` adds per ticket.
  The image defaults to the tag in `kustomization.yaml`; `RIG_DISPATCH_IMAGE` or `--image` overrides it.

### Watching a ticket instead of polling it

`wait` learns what a team did by asking again every 30s. Each team daemon already publishes its queue
state machine as server-sent events on `GET /api/events`, so `watch` subscribes to that stream over
pod-local loopback (the same `kubectl exec` path every other command uses) and reacts when a queue
item reaches a terminal state or becomes blocked on a person. It prints the transition as it happens,
reads the ticket's phase once to say what it means, and exits with `wait`'s codes: 0 done,
3 needs-human, 1 any other failure, 4 timeout. `--collect` runs `collect` for a ticket that
finished, `--all` watches every team pod at once, and `--state-dir` moves the resume store (default
`~/.rig-dispatch/watch`, or `RIG_DISPATCH_WATCH_DIR`).

A queue item reaching a terminal state is not the ticket finishing — seats close rows at every
handoff — so a watch reports those transitions and takes the ticket's own verdict from the same read
`status` uses, which is the only place `result.json` is seen.

**Resume, and its limit.** The last event id seen is stored per ticket **instance** — beside the
`openrig.dev/qitem` id `start` writes — and sent back as `Last-Event-ID`, so a dropped stream or a
restarted watcher continues where it stopped. The team daemon replays from its own database — an
append-only `events` table whose ids are never reused — so on one volume replay reaches everything
since the first event, including across a daemon restart. An id belonging to a different instance is
dropped and the watch starts from 0, because a ticket key that was deleted and started again gets a
fresh store beginning at 1, and `delete` removes the stored id for the same reason.

What a stored id cannot do is tell a fresh volume from a quiet stream, and the daemon gives no way to
ask. Replaying from `Last-Event-ID: N` returns only `seq > N`, so on a pod that came back on a new
volume it sends **nothing at all** until its own ids pass N: the stream goes silent rather than short.
Nothing in the stream reveals that, and no route publishes the daemon's current highest id. So the
watch does not rely on seeing it. What bounds it is a slow status read — a **backstop** probe, every
`RIG_DISPATCH_WATCH_BACKSTOP` seconds (default 180) that the stream has been quiet — which reports the
ticket as it now stands and is logged as the backstop rather than as an event. Two cheap consistency
checks remain on the ids themselves (an id that fails to move forward, a replay starting above
last+1); against this daemon neither can be produced, and they are kept only in case that changes.

Every case where the events do not arrive is bounded the same way: the deadline is checked while the
stream is open, so `--timeout` is honoured even when nothing at all comes. Polling stays the fallback,
not the default — after three attempts that produce no stream at all, `watch` says so and hands the
ticket to `wait`. One stream is also bounded by `--max-time` (`RIG_DISPATCH_EVENTS_MAX_TIME`, default
300s) so a reader whose `kubectl` died cannot outlive it; resume makes that reconnect free.

**A named limit: one unreadable row blocks replay from before it.** The daemon's live delivery path
catches a malformed event, emits `event.delivery_poisoned` and moves on, but its replay path does not
catch it. So if such a row exists above the stored id, every reconnect from that id fails before any
event is sent. The watch survives this degraded rather than stuck: it either reconnects quietly every
`--reconnect` seconds or, after three dead connections, falls back to polling under a misleading
"would not stay open" line — and either way the backstop status read still reports the ticket. So it
costs latency, not correctness, and there is no mechanism here to detect the poisoned row itself.

## Keeping a ticket after its pod is gone: the archive

A team's whole history lives on its own pod volume, and `delete` takes that volume with it. `archive`
copies out everything that explains the ticket while the pod is still there, so `report` can answer
afterwards how long the ticket took, how many review rounds and handoffs it needed, who made each human
decision and from which host, and what it used.

```bash
$D archive PROJ-123 [--dir <root>]   # default root: ./tickets, or $RIG_DISPATCH_ARCHIVE_DIR
$D report PROJ-123 | --all [--dir <root>] [--json]
```

One directory per ticket, `<root>/<slug>/`:

| File | What it holds |
|---|---|
| `manifest.json` | every part with `ok`/`failed`, its row count and its error, plus `complete` |
| `status.json` | what `status` sees: phase, seats, open queue items, the result |
| `queue.json` | every queue row in the team's pod, complete fields, no row cap |
| `nodes.json` | the seats and their state |
| `events.json` | the v1 event stream, paged to the end, with the coverage gaps the daemon reported |
| `queue-transitions.json` | the v1 queue-transition stream, paged to the end |
| `audit-<qitem>.json` | the mission-control audit rows for each of the ticket's queue items |
| `usage-<seat>.json`, `usage-top.json` | the usage samples per seat, and the daemon's top-burn window |
| `result.json` | the pod's `result.json`, verbatim |
| `result.bundle` | only from `collect`: the commits the remote does not have |

- **A failed part costs that part, not the archive.** Everything that could be read is written, the part
  that failed is named in the manifest with its error, and `archive` exits non-zero. A paged read whose
  cursor stops advancing fails its part rather than writing a truncated history as if it were the whole
  one, because a reader cannot otherwise tell a short history from a quiet ticket.
- **Re-running replaces the directory whole.** It is built in a temporary directory beside the target and
  swapped in, so a run never leaves a half-old, half-new mix; a crash mid-swap leaves the complete
  previous archive at `.<slug>.old.*` rather than nothing. One consequence worth knowing: a re-run whose
  part fails replaces an archive that had read that part successfully, so the older copy of that part is
  gone. The pod is still there (the delete guard insists on it), so running `archive` again recovers it.
- **`collect` archives first, then bundles.** The order is deliberate: the history is the part that cannot
  be recovered afterwards. A failed `git bundle`, or a failed `--into` fetch, is recorded as a `bundle`
  part, reported, and makes `collect` exit non-zero — it never discards what was already archived, and no
  half-written bundle is left behind. A ticket with no result branch yet, or with a branch that has no
  commit the remote lacks, is a state of the ticket rather than a failure: the part is recorded with a
  note and `collect` exits 0, so `delete` is never blocked by a ticket that had nothing to bundle, and no
  zero-byte `result.bundle` is left behind.
- **`delete` refuses without a complete archive**, and says which parts failed or are not usable on disk
  (a zero-byte or truncated file, or one holding fewer rows than the manifest counted). It also refuses an
  archive that is no longer current: one taken from an earlier pod under the same ticket name, or one the
  team has written past since — the guard compares the pod's creation time and each telemetry stream's
  current high watermark against the `through` the archive recorded, which is the last row that read could
  include rather than the id the daemon had reached when its last page was produced. The guard runs before anything is touched, so a refused
  delete leaves the team, its hub entry and its volume untouched. `--force` deletes anyway and says so
  loudly.

### What each report figure means, and what it cannot tell

- **duration** — the span from the first to the last archived event; not the pod's lifetime, since nothing
  before the first event is recorded, and when the archive reports coverage gaps it is a floor.
- **reviewRounds** — how many queue rows addressed to a review seat the archive holds, which depends
  on review seats being named `review*`; a review that found nothing still counts as a round, a review
  done inside one seat's own turn without a queue item is invisible here, and a stuck-sweep recovery row
  addressed to a review seat is excluded because it is not a review.
- **handoffs** — how many archived queue-transitions closed a handoff, whether the row closed as
  `handed-off` or as `done` with a `handed_off_to` reason; a handoff made outside the queue leaves nothing
  to count.
- **humanDecisions** — how many archived audit rows are a `resolve`, each with who gave it and, for an
  answer relayed through the hub, the host it came from (`auditNotes.openrig_relay.from_host`); an answer
  typed inside the team's own pod records no origin host, and report says so instead of inventing one.
- **usage** — per seat, the sum of positive per-node token deltas across the archived samples, the same
  rule the daemon's own top-burn uses; these are periodic samples of cumulative counters and **not exact
  token accounting**, so a quiet stretch between two samples is invisible and a counter that goes down is
  counted as a reset rather than subtracted. `usage-top` is a snapshot of the hour before the archive ran,
  so it is reported as a window and never summed into the total.

### Later: the archive root in object storage

Nothing here needs changing to move the archives off the operator machine: the archive is a plain directory
of small files, so the sync is a bucket copy of `<root>` — `aws s3 sync <root> s3://bucket/tickets/
--exclude '.*'` (or `rclone copy <root> remote:tickets/ --exclude '.*/**'`, or `gsutil -m rsync -r -x
'/\..*'`) — run after each `collect` has returned, or on a cron or a Job that walks the tickets the
dispatcher knows about. The exclude matters: while a run is in flight the scratch directory
`.<slug>.partial.*` sits inside `<root>`, and a sync that copies it (or the `.<slug>.old.*` beside a swap
that did not finish) puts a partial archive in the bucket. Because a re-run writes the whole directory and
swaps it in, a sync that skips the dot-directories never sees a half-written archive, and `report --dir`
reads a synced copy unchanged. What is deliberately not built: retention rules, per-ticket versioning in
the bucket, and server-side `report`.

## The hub: one point of truth for every team

`hub/` runs one more OpenRig daemon from the same image with no rigs (`OPENRIG_NO_KERNEL=1`, no agent
credentials) and its own volume for `hosts.yaml`, `config.json` and one bearer file per team. The
design is stage 2 of the factory proposal; what it was observed to do is in [HUB-TEST.md](HUB-TEST.md).

```bash
kubectl apply -k deploy/kubernetes/hub
kubectl -n openrig rollout status statefulset/hub

# the operator's view: one port-forward, one TUI, every team
kubectl -n openrig port-forward pod/hub-0 17433:7433 &
OPENRIG_HOME=/tmp/tuihome node "$(npm root -g)/@openrig/cli/tui/dist/main.js" --url http://127.0.0.1:17433

# and the reads that show the teams today
kubectl -n openrig exec -i hub-0 -c daemon -- rig ps --all-hosts --nodes -A
kubectl -n openrig exec -i hub-0 -c daemon -- rig host list
```

- **The dispatcher keeps it in step.** `start` registers a team once its pod is Ready (bearer file at
  0600 and an absolute path, `rig host add --transport http`, and
  `feed.subscriptions.t-<slug>.enabled true`, so the hub reads the team's queue state and not just
  its reachability); `delete` unregisters it, with `rig config reset` as the unset, and drops the
  team's alias from `host-bindings.json` too. Both are idempotent, and with no Ready hub pod in the
  namespace they are no-ops, so the dispatcher works exactly as before.
- **Registration happens after the ticket is handed over, on purpose.** The hub is view-only, so a hub
  that is Ready but failing (no `pods/exec` RBAC, a full volume, a `hosts.yaml` that `rig host add`
  refuses) must never leave a team running with no ticket. `start` hands the ticket over first and
  then registers, and still exits non-zero with a loud error if registration fails.
- **A hub that is down at the wrong time leaves residue, and nothing repairs it yet.** If the hub is
  not Ready when `start` runs, the team is simply not registered; re-run `start <ticket>` once the hub
  is Ready — it resumes and does not hand the ticket over twice. If the hub is not Ready when `delete`
  runs, the team pod is gone but the hub keeps its host, bearer file and subscription; both cases log
  a warning naming exactly what is left and the commands to clean it. There is no `hub-sync` reconcile
  yet, so a stale host after a `delete` is removed by hand:

  ```bash
  kubectl -n openrig exec -i hub-0 -c daemon -- rig config reset feed.subscriptions.t-<slug>.enabled
  kubectl -n openrig exec -i hub-0 -c daemon -- rm -f ~/.openrig/hosts.d/t-<slug>.bearer
  # then drop the t-<slug> entry from ~/.openrig/hosts.yaml (there is no `rig host remove`)
  ```

- **Do not run `start` and `delete` for different tickets at the same moment.** `rig host add` is
  last-write-wins and the unregister reads the whole file, rewrites it and renames it into place, so a
  concurrent pair can drop one entry. The rewrite is atomic (tmp + rename), so the daemon never sees a
  half-written file, but the lost update is real. Re-running `start <ticket>` repairs it.
- **`answer` goes through the hub, so a human is recorded as a human.** The dispatcher runs
  `rig queue resolve --host t-<slug> <qitem> --decision ...` in the hub pod with no seat in its
  environment, which is the case the CLI already handles: it sends the seatless human actor in the request
  body and the team records that at the provenance the CLI claims for it. Setting a seat name instead
  would send a header, the hub would treat it as transport-proven, and the team would file the answer at a
  strength nothing verified. The hub composes `auditNotes.openrig_relay.from_host` from its own host id as
  it forwards, and the team stores it — that is what lets the archive say who answered and from where.
  Naming an individual human
  (`human-alice@host`) needs the hub's own human registry, which is a later step; until then every answer
  is recorded as the seatless human. It falls back to resolving inside the team pod as its lead only when
  the hub could not do it: no Ready hub pod, the team not registered on the hub, or a hub-side failure. The
  one failure that never falls back is a refusal the team made itself — `remote_action_failed` with
  `failureClass: remote-error` — which is reported and exits 1 rather than re-issued under a seat's
  name. Every other failure could still have reached the team (a request timeout, a body that timed out
  after the headers, an indeterminate network error), so the row is read in the pod first: still parked on
  a human means the write never landed and the fallback runs. A row that is **not** parked is not proof of
  a landing — anything that unparks a row looks the same — so the team's own audit rows decide: `answer`
  exits 0 only when they carry a `resolve` whose reason is this decision and whose
  `auditNotes.openrig_relay.from_host` is set. A row that cannot be read (including `blocked` with no
  `blockedOn`), or a row that moved without such an audit row, exits **5**: the answer is not confirmed,
  and nothing was re-issued. A caller can tell 5 (not confirmed) from 1 (the team refused).
  The fallback logs why, and records the team's lead rather than the
  human, because a bare `kubectl exec` shell has no human identity to offer.
- **It binds loopback.** Nothing in the cluster dials the hub, and the operator comes in through
  `kubectl port-forward`, which connects inside the pod. A loopback bind needs no bearer, so reaching
  the hub is exactly having `pods/portforward` or `pods/exec` on the namespace — the same access, and
  the reads below use the second one. Its readiness probe is therefore an
  `exec` curl, not `httpGet`: the kubelet probes the pod IP, where a loopback bind has no listener.
- **What it shows, and what it does not.** The daemon-side fan-outs work: `/api/review/fleet` stamps
  every needs-you item with its team's `hostId`, the attention aggregate reports each team's status,
  and `rig ps --all-hosts --nodes -A` lists every seat. **The TUI does not show any of it, on any
  version**: it renders `hub-0` alone, because remote hosts still hydrate with `rigs: []`, nothing
  reads the hosts-down list, and its NEEDS YOU comes from the hub's own empty queue rather than the
  fleet read. That gap is stage 3.1 and 3.2, and [HUB-TEST.md](HUB-TEST.md) records the evidence. Use
  the `kubectl exec` reads below for the teams; the TUI is for the hub itself. The TUI must be no older
  than the hub's daemon in any case — an old one does not call `/api/review/fleet` at all.

### Scraping the hub's `/metrics` with Prometheus

The hub publishes the whole fleet as one Prometheus scrape target at `GET /metrics`, built from the
same fleet reads the operator's views use, so a scrape with a warm cache causes no fan-out of its
own. The hub binds `127.0.0.1:7433` inside its pod, so nothing in the cluster can reach it directly,
and three routes exist — none of them built here. The one that changes nothing is a long-lived
`kubectl -n openrig port-forward pod/hub-0 7433:7433` on the scraper's host pointed at
`http://127.0.0.1:7433/metrics`: no image or manifest change and no bearer, but it is a supervised
process that dies with the pod and it needs `pods/portforward` forever. The one that fits the deploy
best is a sidecar container in the hub pod: a sidecar shares the pod network namespace, so it can
read `127.0.0.1:7433/metrics` and re-publish it on the pod address for an ordinary pod scrape, which
keeps the loopback bind and still needs no bearer. The third is to bind the hub on `0.0.0.0` and set
`OPENRIG_AUTH_BEARER_TOKEN`, which is the posture the daemon already requires of a wider bind —
Prometheus then sends it in `scrape_config.authorization` — but the hub holds every team's bearer
file, so widening its bind means the NetworkPolicy and secret review the loopback choice was made to
avoid. Whichever is chosen, a scrape is a read of the hub's cached fleet view: use the plain path with
no query parameters and a normal 30–60s interval.

## How the pieces fit

- **Daemon.** `rig daemon start` detaches, so the entrypoint runs
  `node $(npm root -g)/@openrig/cli/daemon/dist/index.js` directly. It binds `0.0.0.0`, which
  requires `OPENRIG_AUTH_BEARER_TOKEN`. `OPENRIG_NO_KERNEL=1` skips the kernel rig, which needs its
  own login. `OPENRIG_HOST_NAME` seeds the self-host id on first boot; the id then lives in the
  volume.
- **Pi seats.** A Pi seat reads `models.json` and extensions only from
  `$OPENRIG_HOME/state/pi/<session>/agent`. The entrypoint copies the kit's copies there on every
  boot for each session in `OPENRIG_PI_SEATS`. The session name is `{podId}-{memberId}@{rigName}`,
  so renaming the rig or the member means updating `OPENRIG_PI_SEATS`.
- **Workspace.** On first boot the entrypoint clones `OPENRIG_WORKSPACE_REPO` into
  `~/work/project`. The pod has no Git push credentials: agents commit on branches, and you fetch
  the result, for example with
  `kubectl -n openrig exec rig-0 -- git -C work/project bundle create - <branch> > team.bundle`.
- **Seats talking to the daemon.** With a non-loopback bind, `rig send` and the other terminal
  routes need the bearer even from inside the pod. The CLI reads it from
  `$OPENRIG_HOME/terminal-token`, which the entrypoint writes; `rig daemon start` does not write
  it either, so this applies to any host bound to a non-loopback address.

## Security

The rig runs `builtin:yolo` with `non_interruptive: true`, because no one sits at these terminals
to answer prompts. The pod is the boundary:

- **What an agent can read:** the Claude token and the daemon bearer. Seats run as the daemon's
  user, so both are readable from their environment or the terminal-token file. Nothing else: no
  Git push credentials, no service-account token.
- **Who can use the bearer:** nobody outside the pod. The NetworkPolicy denies all ingress, so
  only `kubectl port-forward` (which needs RBAC on the namespace) reaches the daemon. The one
  exception is the hub pod, which may reach a team daemon on 7433 and nothing else can.
- **The hub holds every team's bearer.** It runs no agents, binds loopback, has egress to cluster DNS
  and the team daemons only, and is reached only through `kubectl port-forward`. Access to the hub is
  access to the namespace.
- **Where agents can connect:** the internet, cluster DNS, and the model server on port 8731. Not
  the cluster, the k3d node network with the API server, the LAN, the tailnet or link-local
  addresses. If the model server moves, change both `kit/pi/models.json` and
  `manifests/networkpolicy.yaml`.
- **The container:** non-root, no privilege escalation, all capabilities dropped,
  `RuntimeDefault` seccomp.

## Changing things

- **The kit** (rig spec, guidance, `models.json`): edit `kit/`, then `kubectl apply -k`. The
  ConfigMap has no name hash, so the pod is not restarted; the mounted files update within a
  minute. The Pi files are copied at boot, so a `models.json` change needs
  `kubectl -n openrig delete pod rig-0`.
- **OpenRig, Claude Code or Pi versions:** rebuild the image and set the new tag.
- **More hosts:** raising `replicas` gives `rig-1`, ... with their own volumes, each registered with
  its own port-forward. As written they share one bearer, one kit and one `GIT_USER_NAME`, and
  `OPENRIG_PI_SEATS` names the one rig. Give each host its own kit if they run different rigs.

## Limits

- `rig host doctor --posture` flags the non-loopback bind. That check targets a public VPS.
- The `http` transport has no live attach; use `send`, `capture` and `transcript`, or
  `kubectl exec ... tmux attach`.
- A port-forward drops when the operator machine sleeps or the pod restarts; rerun it.
- A pod restart kills the seats; OpenRig restores them on `rig up claude-pi-k8s --existing --host
  rig-0`. The daemon state, sessions and workspace survive on the volume.
