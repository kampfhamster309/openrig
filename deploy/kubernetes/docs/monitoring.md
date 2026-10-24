# Monitoring the fleet

Everything about the fleet is read on the hub. It answers four questions: which teams exist and are
reachable, which team needs a human, which team has stopped making progress, and what each team uses.
This page covers the four ways to see that: the TUI, the CLI, the HTTP reads, and Prometheus. The
exact routes, settings and metric names are in [reference.md](reference.md).

```bash
export KUBECONFIG=<the cluster's kubeconfig>
NS=openrig
HUB="kubectl -n $NS exec -i hub-0 -c daemon --"
D=deploy/kubernetes/dispatcher/rig-dispatch
```

## What the hub knows, and how fresh it is

The hub reads every registered team with one fan-out: a deadline per team (`fleet.host_timeout_ms`,
default 5 s), at most `fleet.fanout_concurrency` teams at once (default 4), and a cache of 3 seconds
shared by every reader. After that, a reader gets the cached payload immediately while one background
refresh runs, for up to 60 seconds; an older payload is never served. So:

- Opening ten TUIs, running the CLI and scraping Prometheus costs the teams one fan-out every few
  seconds, not one per reader.
- A slow or dead team is reported on its own, with its reason, and does not hold up the others.
- `?fresh=1` on any fleet read bypasses the cache, for debugging.

A team that did not answer is **unknown**, never zero: it appears with `unreachable`, `auth-failed` or
`unsupported-transport`, and contributes nothing to any count or total.

## The TUI on the hub

```bash
kubectl -n $NS port-forward pod/hub-0 17433:7433 &
OPENRIG_HOME=$HOME/.openrig-hub-view OPENRIG_URL=http://127.0.0.1:17433 \
  node "$(npm root -g)/@openrig/cli/tui/dist/main.js" --url http://127.0.0.1:17433
```

Remote rows carry a dim `[t-<slug>]` label, so you always see which team a row belongs to.

**PULSE**

| Section | What appears from the teams |
|---|---|
| ▲ NEEDS YOU | Every item in the fleet that waits for a human, with the command to answer it from here: `answer <qitem> <decision>`. |
| ◌ PARKED WITH BATON | Items in progress whose seat is idle: the work is parked with a seat that is not working on it. |
| ⧗ BLOCKED ON AGENTS | Items blocked on another seat. |
| ✕ HOSTS DOWN | Teams the hub could not read, with the reason. |
| ⚑ STALLED | Teams or rigs with open work and no progress past the threshold: `<rig> — 47m since last progress, 3 open · threshold 30m`. |
| UP NEXT | Pending items, prefixed with their team. |

**TOPOLOGY.** Each reachable team is a collapsed row. Expanding it reads its rigs through the hub,
expanding a rig reads its seats; nothing is read for collapsed teams, so the cost follows what you look
at. Remote seats are read-only here: their page shows the address to use with `rig send` and
`rig capture` (`<seat>@<rig>@t-<slug>`).

**Instance page.** A `FLEET USAGE · last 1h` block lists the ten seats burning the most tokens across
the fleet, each with its team, then the teams whose usage is unknown.

**Answering.** `answer <qitem> <decision>` on a remote item sends the answer through the hub, where the
team records it as a human's (see [operating.md](operating.md#answering-a-team)). The notice says
`answered <id> on host <h> — row is now <state>`, or `answer NOT recorded` with the reason.

If a fleet read fails, the TUI keeps showing the last good payload and says so in the status line
(`fleet-summary: …; showing the last successful read`). An operator without remote hosts sees none of
these additions.

## The CLI

The fleet commands are most reliable when run in the hub pod, where the CLI's host registry is the
hub's:

```bash
$HUB rig ps --all-hosts -A --json        # every rig, with stalled, minutesSinceProgress, openWorkCount
$HUB rig ps --all-hosts --nodes -A       # every seat, with its activity
$HUB rig usage top --all-hosts            # the fleet's top seats by token burn, labelled [host]
$HUB rig usage top --all-hosts --window 6h --top 20 --json
$HUB rig usage series --host t-proj-123 --seat <seat>   # one seat's series on one team
$HUB rig host list                        # the registered teams
```

From the operator machine, the same commands work through the port-forward with a separate home, so
that your local host registry does not mix in:

```bash
OPENRIG_HOME=$HOME/.openrig-hub-view OPENRIG_URL=http://127.0.0.1:17433 rig usage top --all-hosts
```

Both `--all-hosts` commands ask the hub first and use its read. If the hub does not serve it (an older
daemon), or the hub's answer does not cover every host in the CLI's own registry, they dial each host
themselves. `--json` says which path ran (`source: hub` or `cli-fanout`). Only hosts the CLI can reach
work in that fallback; team pods are reachable only from the hub.

## The stall verdict

A team is **stalled** when it has open work and no progress for longer than
`fleet.stall_threshold_minutes` (default 30). The verdict is computed per team and per rig on the hub,
and needs nothing from the team or the dispatcher.

- **Progress** is a queue transition written by a seat or a human, including a note-only update.
  Agents doing long work should post a short note as a heartbeat, for example
  `rig queue update <qitem> --note "tests running, 40%"`.
- **Not progress:** transitions by system actors (`…@system`, `system`, `system:*`, `daemon@kernel`),
  which keep firing on exactly the team that is stuck; terminal output, which changes while an agent's
  spinner runs even during a hung command (it is shown separately as `lastSeatOutputAt`); the
  stuck-sweep heartbeat; and an item's update time.
- **No verdict** (`stalled: null`, and no stalled series in `/metrics`) when there is open work but no
  qualifying transition was found. The hub reads the 20 newest transitions on the team plus the logs of
  up to 25 open items; with more open items, `progressReadsTruncated` is set.

Tune it on the hub:

```bash
$HUB rig config set fleet.stall_threshold_minutes 45
$HUB rig config get fleet.stall_threshold_minutes
```

Settings are read again on every fan-out, so a change applies within seconds. The dispatcher's own
`wait --stall` nudge is separate: it looks at queue items and the workspace, and messages the lead.

## Following events

`rig-dispatch watch <ticket>|--all` follows each team's event stream and reports, as they happen, every
queue item that finishes and every item that becomes blocked (on a seat or a human), and the ticket's
verdict:

```bash
$D watch --all --collect     # one process for the whole fleet; collects each finished ticket
```

It resumes after a restart without losing events ([operating.md](operating.md#how-watch-works)). It is
the natural place to hook notifications: wrap it, or read its exit codes (0 done, 1 failed, 3 needs a
human, 4 timeout).

## Scraping `/metrics` with Prometheus

`GET /metrics` on the hub publishes the whole fleet as one scrape target in Prometheus text format. It
is built from the fleet summary and fleet usage reads through their cache, so a scrape with a warm cache
costs the teams nothing. One target for the fleet, instead of one per short-lived pod.

### Reaching the hub

The hub binds `127.0.0.1:7433` inside its pod, so a scraper cannot reach it directly. Choose one of these;
none is in the manifests yet.

1. **A sidecar in the hub pod (fits best).** A container in the same pod shares its network namespace,
   reads `http://127.0.0.1:7433/metrics` and serves it on the pod address for an ordinary pod scrape.
   The hub stays on loopback and needs no bearer. Add an ingress rule to
   `manifests/networkpolicy-hub.yaml` for the scraper on the sidecar's port only. Any small reverse proxy
   that forwards one path works.
2. **A supervised port-forward** on the scraper's host: `kubectl -n openrig port-forward pod/hub-0
   7433:7433`, scraping `http://127.0.0.1:7433/metrics`. No change in the cluster, but the forward dies
   with the pod and must be restarted, and it needs `pods/portforward` permanently.
3. **Bind the hub on `0.0.0.0` with a bearer** (`OPENRIG_BIND_HOST=0.0.0.0`,
   `OPENRIG_AUTH_BEARER_TOKEN` from a Secret). Prometheus then sends the bearer with
   `authorization: { credentials_file: ... }`. This is the posture the daemon requires for a wider bind,
   but the hub holds every team's bearer, so widening its bind needs a review of the NetworkPolicy and
   of who can reach it. A non-loopback name in the Host header also needs `OPENRIG_ALLOWED_HOSTS`.

`/metrics` sits behind the same browser boundary as `/api/*`: a request from a browser page is refused,
so a web page cannot read it through a rebound host name.

Scrape the plain path with no parameters, every 30 to 60 seconds:

```yaml
scrape_configs:
  - job_name: openrig-fleet
    scrape_interval: 30s
    metrics_path: /metrics
    static_configs:
      - targets: ["<sidecar or forward address>"]
```

`?window_hours=<h>` changes the usage window (default 1 hour). Keep one window per target, since each
window is cached separately.

### What is published

All series carry `host` (the team's host id, `t-<slug>`, or `local` for the hub itself); per-rig series
also carry `rig`. Labels are only host, rig and fixed sets of values, never ids or free text, so the
number of series stays proportional to teams and rigs.

| Question | Series |
|---|---|
| Is the team reachable? | `openrig_fleet_host_up` (1/0), `openrig_fleet_host_read_status{status}` |
| How many teams and rigs? | `count(openrig_fleet_host_up == 1)`, `openrig_fleet_rigs` |
| What are the seats doing? | `openrig_fleet_seats{activity="working"\|"idle"\|"needs-input"\|"unknown"}`, `openrig_fleet_seats_running`, `openrig_fleet_seats_with_assigned_work` |
| What waits for a human? | `openrig_fleet_seats{activity="needs-input"}`, `openrig_fleet_attention_items` |
| What is open in the queue? | `openrig_fleet_queue_items{state}`, `openrig_fleet_queue_overdue_items`, `openrig_fleet_queue_undelivered_items` |
| Is the team making progress? | `openrig_fleet_host_stalled`, `openrig_fleet_rig_stalled`, `openrig_fleet_host_last_progress_timestamp_seconds`, `openrig_fleet_rig_last_progress_timestamp_seconds`, `openrig_fleet_stall_threshold_seconds` |
| Is the team's own safety net running? | `openrig_fleet_stuck_sweep_last_run_timestamp_seconds`, `openrig_fleet_stuck_sweep_consecutive_failures`, `openrig_fleet_stuck_sweep_findings_routed_total` |
| Who is burning tokens? | `openrig_fleet_usage_sampled_tokens_delta`, `openrig_fleet_usage_resets`, `openrig_fleet_usage_seats_ranked`, `openrig_fleet_usage_seats_unknown`, `openrig_fleet_usage_window_seconds`, `openrig_fleet_usage_read_ok` |
| How fresh is this scrape? | `openrig_fleet_fanout_cache_age_seconds`, `openrig_fleet_fanout_cache_stale` |

Rules worth knowing when you write queries:

- A team that did not answer has `openrig_fleet_host_up 0`, one `openrig_fleet_host_read_status` series
  and **nothing else**. Its other series disappear rather than drop to zero, so a sum over teams is a sum
  over the teams that answered. Use `openrig_fleet_host_up` to tell the two apart.
- A value the hub does not know is left out, not written as 0 (for example `*_stalled` with no verdict,
  or the stuck-sweep series from a team image that does not report them).
- Usage series appear only for teams that answered both the summary and the usage read. If the usage
  read fails as a whole, the scrape still succeeds with `openrig_fleet_usage_read_ok 0`.
- `openrig_fleet_queue_items` counts at most 200 open items per team.
- Team pods come and go, so `host` values are short-lived. Aggregate by `host` in dashboards and keep
  per-ticket history in the archives, not in Prometheus.

### Example alerts

Starting points; adjust thresholds to your teams.

```yaml
groups:
  - name: openrig-fleet
    rules:
      - alert: OpenRigTeamUnreachable
        expr: openrig_fleet_host_up == 0
        for: 5m
        annotations:
          summary: "Team {{ $labels.host }} cannot be read by the hub"
      - alert: OpenRigTeamStalled
        expr: openrig_fleet_host_stalled == 1
        for: 5m
        annotations:
          summary: "Team {{ $labels.host }} has open work and no progress past the stall threshold"
      - alert: OpenRigTeamNeedsHuman
        expr: sum by (host) (openrig_fleet_seats{activity="needs-input"}) > 0
        for: 10m
        annotations:
          summary: "Team {{ $labels.host }} waits for a human"
      - alert: OpenRigUndeliveredItems
        expr: openrig_fleet_queue_undelivered_items > 0
        for: 15m
        annotations:
          summary: "Team {{ $labels.host }} has queue items that never reached their seat"
      - alert: OpenRigStuckSweepFailing
        expr: openrig_fleet_stuck_sweep_consecutive_failures >= 3
        annotations:
          summary: "The stuck sweep on {{ $labels.host }} keeps failing"
      - alert: OpenRigFleetReadStale
        expr: openrig_fleet_fanout_cache_age_seconds > 60 or absent(openrig_fleet_host_up)
        for: 5m
        annotations:
          summary: "The hub's fleet read is old or missing"
```

### A dashboard in four panels

- **Teams:** `count(openrig_fleet_host_up == 1)` and `count(openrig_fleet_host_up == 0)`.
- **Needs you and stalled:** `sum by (host) (openrig_fleet_seats{activity="needs-input"})` and
  `openrig_fleet_host_stalled == 1`, as a table by host.
- **Work in flight:** `sum by (state) (openrig_fleet_queue_items)`.
- **Burn:** `topk(10, openrig_fleet_usage_sampled_tokens_delta)` over the window.

## What the usage numbers are

OpenRig samples each seat's context-window and provider-window readings when they change. The fleet
usage read and the `openrig_fleet_usage_*` series sum the positive changes of those samples over the
window. That answers "which team is burning fastest right now", and it is good for spotting a team in a
loop. It is **not exact token or cost accounting**: activity between two samples is invisible, a counter
that goes down (a session restart) is counted as a reset, and rates or percentages are never added up
across seats or teams.

For exact tokens and cost per team and per ticket, route model traffic through an LLM gateway in the
cluster and give each team its own key ([setup.md](setup.md#3-namespace-and-secrets)). The gateway then
reports exact usage per key, independent of OpenRig.

## History after a team is gone

The hub only knows the teams that exist now. A ticket's history (how long it took, review rounds,
handoffs, who decided what, usage) is kept by `rig-dispatch archive` and read with `rig-dispatch report`
([operating.md](operating.md#collecting-the-result-and-the-history)):

```bash
$D report --all --json > factory-report.json
```

## Health of the hub itself

```bash
kubectl -n $NS get pod hub-0                                   # readiness: /healthz inside the pod
$HUB curl -fsS http://127.0.0.1:7433/healthz
$HUB curl -s "http://127.0.0.1:7433/api/fleet/summary" | jq '.hosts'
kubectl -n $NS logs hub-0 -c daemon | grep -E '\[fleet/|\[metrics\]'
```

Background refresh failures are logged as `[fleet/summary] background refresh failed; serving stale
until the bound: …` (and the same for `[fleet/usage]`), and a scrape that publishes without usage as
`[metrics] fleet usage read failed; …`.
