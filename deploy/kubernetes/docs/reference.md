# Reference

Exact names, defaults and behaviour of everything on this branch that an operator touches. The code
wins where this page and the code disagree; file references point to where each item is defined.

## rig-dispatch

[`dispatcher/rig-dispatch`](../dispatcher/rig-dispatch), run on the operator machine. Needs `kubectl`
and `jq`.

### Commands

| Command | Options | Exit codes |
|---|---|---|
| `start <ticket> --repo <url> --brief-file <file>` | `--ref <branch or tag>`, `--spec <path in pod>` (default `/etc/openrig-kit/rig.yaml`), `--lead <logical id>` (default `orch.lead`), `--image <ref>`, `--env NAME=VALUE` (repeatable), `--cpu` (default `500m`), `--memory` (default `4Gi`, also the limit), `--storage` (default `20Gi`), `--ready-timeout <s>` (default 600) | 0 started or resumed; 1 on failure, including a failed hub registration after the hand-over |
| `status [<ticket>]` | `--json` | 0 |
| `wait <ticket>` | `--timeout <s>` (default 7200), `--interval <s>` (default 30), `--stall <min>` (default 20) | 0 done, 1 failed, 3 needs-human, 4 timeout |
| `watch <ticket>` \| `--all` | `--collect`, `--archive <dir>`, `--timeout <s>`, `--interval <s>`, `--reconnect <s>`, `--state-dir <dir>` | 0 done, 1 failed, 3 needs-human, 4 timeout |
| `answer <ticket> <qitem> <decision>` | | 0 recorded, 1 refused by the team or failed, 5 not confirmed (nothing re-issued); on the in-pod fallback, the exit status of `rig queue resolve` |
| `archive <ticket>` | `--dir <root>` | 0 complete, 1 at least one part failed |
| `collect <ticket>` | `--archive <dir>` / `--dir <root>`, `--into <local git repo>` | 0, or 1 when the archive or the bundle failed |
| `report <ticket>` \| `--all` | `--dir <root>`, `--json` | 0, or 1 when there is no archive to report from |
| `delete <ticket>` | `--dir <root>`, `--force` | 0 deleted, 1 refused by the guard or failed |
| `hub-sync` | `--dry-run` | Repairs the hub's registry against the team StatefulSets in the namespace: an entry the dispatcher wrote with no team behind it is unregistered completely, a handed-over and Ready team that is missing or incomplete is registered or completed, a team not handed over or not Ready is left alone, and the bearer file, subscription and alias left behind by an unregister that stopped halfway are found from their own names unless an entry still claims them. Names every finding. A team StatefulSet or pod read that fails aborts the run before it touches anything, and each team is read again immediately before it is unregistered -- where only a NotFound counts as gone, so a re-check that failed for another reason leaves that team registered and says nobody knows. With no Ready hub pod it reads and touches nothing. Exits 0 when the registry matches afterwards (re-read, not remembered), 1 when a difference stands or a repair failed, 3 when there is no Ready hub pod. `--dry-run` changes nothing and reports the same codes, so it works as a check. |

No arguments prints the usage and exits 2; an unknown command or option exits 1.

### Environment

| Variable | Default | Effect |
|---|---|---|
| `KUBECONFIG` | | The cluster. |
| `KUBECTL` | `kubectl` | The kubectl binary (the tests use a fake one). |
| `RIG_DISPATCH_NAMESPACE` | `openrig` | Namespace of teams and hub. |
| `RIG_DISPATCH_IMAGE` | the pin in `../kustomization.yaml` | Image for new team pods (`--image` wins). |
| `RIG_DISPATCH_HUB_POD` | `hub-0` | The hub to register teams with and to answer through. No Ready pod: registration is skipped and `answer` falls back. |
| `RIG_DISPATCH_ARCHIVE_DIR` | `./tickets` | Archive root (`--dir` wins). |
| `RIG_DISPATCH_QUEUE_LIMIT` | `100000` | Most queue rows read into an archive. |
| `RIG_DISPATCH_MAX_PAGES` | `100000` | Most pages per paged archive read. |
| `RIG_DISPATCH_USAGE_PAGE` | `5000` | Rows per page when archiving usage samples. |
| `RIG_DISPATCH_WATCH_DIR` | `~/.rig-dispatch/watch` | Where `watch` stores the last event id per ticket (`--state-dir` wins). |
| `RIG_DISPATCH_EVENTS_URL` | the pod's own loopback | Where `watch` opens the event stream. |
| `RIG_DISPATCH_WATCH_TICK` | `1` | Seconds between checks of a quiet stream for the verdict and the deadline. |
| `RIG_DISPATCH_WATCH_BACKSTOP` | `180` | Seconds of quiet after which `watch` reads the status anyway. |
| `RIG_DISPATCH_EVENTS_MAX_TIME` | `300` | Seconds one stream may last before it is reopened from the stored id. |
| `RIG_DISPATCH_HUB_LOCK` | `/home/openrig/.openrig/.registry.lock` (in the hub pod) | The file every hub registry edit is serialized under, in the hub's own volume beside the files it protects. One lock, taken by `start`, `delete` and `hub-sync`, so no two of them rewrite `hosts.yaml` or the settings at the same moment. |
| `RIG_DISPATCH_HUB_LOCK_TIMEOUT` | `60` | Seconds a hub registry edit waits for that lock before it gives up and says the hub is busy. Raise it only if edits really do queue for longer than this. |

### Objects, labels and annotations

Per ticket `<slug>` (the ticket key in lower case, other characters replaced by `-`, at most 40):

| Object | Name |
|---|---|
| StatefulSet (one replica) | `t-<slug>`, labels `app=openrig-team`, `openrig.dev/role=team`, `openrig.dev/ticket=<slug>` |
| Pod | `t-<slug>-0`, container `daemon` |
| Secret | `t-<slug>`, the team's bearer (key `bearer`) |
| Volume | from the StatefulSet's claim template; deleted with it |
| Host id on the hub | `t-<slug>` |
| Branch in the workspace | `ticket/<slug>` |
| Queue tag | `ticket:<slug>` |

Annotations on the StatefulSet (prefix `openrig.dev/`): `ticket-key`, `repo`, `ref`, `spec` (at
creation), `rig` (after `rig up`), `qitem` (the lead's ticket item) and `lead` (both at hand-over).

### Files a team writes

| Path in the pod | What |
|---|---|
| `/home/openrig/work/project` | The workspace, cloned on first boot. |
| `/home/openrig/work/result.json` | `{"status": "done" \| "failed" \| "needs-human", "branch", "commit", "summary"}`, written by the lead. |
| `/home/openrig/.openrig` | The daemon's home: database, sessions, settings. |

## The image

[`image/Dockerfile`](../image/Dockerfile) and [`image/entrypoint.sh`](../image/entrypoint.sh). Runs as uid
1000 (`openrig`) under `tini`.

| Variable | Default | Effect |
|---|---|---|
| `OPENRIG_AUTH_BEARER_TOKEN` | | Required for a non-loopback bind. Also written to `$OPENRIG_HOME/terminal-token` (0600) for the CLI in the seats. |
| `OPENRIG_BIND_HOST`, `OPENRIG_PORT` | the daemon's default (loopback), `7433` | The daemon's address. Team pods and the single host set `0.0.0.0`; the hub sets `127.0.0.1`. |
| `OPENRIG_HOST_NAME` | | Seeds the host's own id on first boot; afterwards the id lives in the volume. |
| `OPENRIG_NO_KERNEL` | | `1` skips the kernel rig (set on the hub). |
| `OPENRIG_WORKSPACE_REPO`, `OPENRIG_WORKSPACE_REF` | | Repository and ref cloned on first boot. |
| `OPENRIG_WORKSPACE_DIR` | `$HOME/work/project` | Where it is cloned. |
| `OPENRIG_KIT_DIR` | `/etc/openrig-kit` | The mounted kit. |
| `OPENRIG_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST` | | Provider variables passed into seats (from `dispatcher/team.env`). |
| `GIT_USER_NAME`, `GIT_USER_EMAIL` | `OpenRig agents`, `openrig@localhost` | Identity on the agents' commits. Team pods set `GIT_USER_NAME` to `OpenRig team t-<slug>`. |

Build: `deploy/kubernetes/build-image.sh [--push] [--skip-package]`, `IMAGE` overrides the repository.
The tag is `<version>-<short commit>`, with `-dirty-<UTC time>` for uncommitted changes in `packages/`
or `deploy/kubernetes/image/`.

## Daemon routes added or changed

Mounted in `packages/daemon/src/server.ts`. `/api/*` and `/metrics` share one browser boundary: a
non-self Host name needs `OPENRIG_ALLOWED_HOSTS` or a valid bearer, and browser Origins need
`OPENRIG_ALLOWED_ORIGINS`.

### `GET /api/fleet/summary`

`?fresh=1` bypasses the cache. `503 {"error":"fleet_summary_unavailable"}` if the daemon lacks the
services it reads. Source: `routes/fleet.ts`, `domain/fleet/fleet-summary*.ts`.

- **Top level:** `items` (one per host that answered), `hosts` (`{hostId, status, error?, failedStep?}`
  for every targeted host; `status` is `ok`, `unreachable`, `auth-failed` or `unsupported-transport`),
  `openQueue`, `generatedAt`, `stallThresholdMinutes`, `enabledProgressSources`, `hostTimeoutMs`,
  `concurrency`, `targetedHostIds`, `fromCache`, `cacheAgeMs`, `cacheStaleWhileRevalidate`,
  `cacheTtlMs`, and `registryError` when `hosts.yaml` exists but cannot be read.
- **Per host:** `hostId`, `kind` (`local` or `remote`), `selfHostId`, `status`, `reachable`, `rigCount`,
  `seatCount`, `seatsByActivity` (`working`, `idle`, `needsInput`, `unknown`, `total`), `attentionCount`,
  `openQueueCount`, `openQueueByState` (`pending`, `inProgress`, `blocked`), `overdueCount`,
  `undeliveredCount`, `stuckSweep`, `progress`, `rigs[]`, `partialFailures[]`.
- **Per rig:** `rigId`, `rigName`, `hostId`, `seatCount`, `seatsByActivity`, `attentionCount`,
  `seatsWithAssignedWork`, `lifecycleState`, `runningCount`, `psStatus`, `progress`, `seats[]`.
- **`progress`:** `lastQueueTransitionAt`, `lastSeatOutputAt`, `lastProgressAt`, `lastProgressSource`,
  `enabledProgressSources`, `minutesSinceProgress`, `stalled` (`true`, `false`, or `null` without a qualifying transition),
  `openWorkCount`, `progressReadsTruncated`.
- **`openQueue[]`:** `hostId`, `rigName`, `qitemId`, `state`, `destinationSession`, `sourceSession`,
  `blockedOn`, `handedOffTo`, `claimedAt`, `priority`, `summary`, `tags`, `tsCreated`, `tsUpdated`.

What the hub reads from each team, all under that team's deadline: `/healthz`, `/api/ps`,
`/api/rigs/:id/nodes`, `/api/queue/list` (open states, 200 rows), `/api/queue/overdue`,
`/api/queue/undelivered`, `/api/queue/recent-transitions` (20), and the transition log of up to 25 open
items, 4 at a time. A failed health probe means `unreachable`; a missing bearer or a 401/403 means
`auth-failed`; a failure after `/api/ps` is listed in `partialFailures` and the host stays `ok`.

### `GET /api/fleet/usage`

`?window_hours=<h>` (default 1, any positive number), `?top=<n>` (at least 1), `?fresh=1`.
`400 {"code":"fleet_usage_invalid_request"}` for a bad parameter. Source: `routes/fleet.ts`,
`domain/fleet/fleet-usage*.ts`.

- **Top level:** `items`, `hosts`, `generatedAt`, `windowHours`, `sinceIso`, `top[]` (seats with
  `hostId`), `topCap`, `totalSeatsRanked`, `unknown[]`, `totals` (`tokensDelta`, `resets`, `seatsRanked`,
  `seatsUnknown`, `hostsAnswered`, `hostsTargeted`; `null` when no host answered), `hostTimeoutMs`,
  `concurrency`, `targetedHostIds`, cache fields as above.
- **Per host:** `hostId`, `kind`, `status`, `reachable`, `statusError?`, `partialFailures[]`, `usage`
  (`state` `ok` or `unavailable`, `reason?`, `ranked[]`, `unknown[]`, `totals?`, absent rather than zero
  without a read).
- **Per seat:** `seatSession`, `tokensPerHour`, `tokensDelta`, `resets`, `spanHours`, `samples`,
  `windows[]`, `hostId`. Ranked by `tokensPerHour`, then host, then seat. There is deliberately no
  fleet-wide tokens-per-hour figure.

### `GET /metrics`

Prometheus text format (`text/plain; version=0.0.4; charset=utf-8`). `?window_hours=<h>` for the usage
window, `?fresh=1`. Needs the daemon's bearer when it has one (none on the loopback-bound hub).
`400 {"code":"metrics_invalid_request"}` for a bad `window_hours`;
`503 {"error":"fleet_metrics_unavailable"}` when the daemon lacks the services the summary reads; other
summary failures return 500. A failed usage read still returns 200 with `openrig_fleet_usage_read_ok 0`. Metric list and rules:
[monitoring.md](monitoring.md#what-is-published); source `domain/fleet/fleet-metrics.ts`.

| Metric | Type | Labels |
|---|---|---|
| `openrig_fleet_host_up` | gauge | `host` |
| `openrig_fleet_host_read_status` | gauge | `host`, `status` |
| `openrig_fleet_stall_threshold_seconds` | gauge | |
| `openrig_fleet_fanout_cache_age_seconds` | gauge | |
| `openrig_fleet_fanout_cache_stale` | gauge | |
| `openrig_fleet_rigs` | gauge | `host` |
| `openrig_fleet_queue_overdue_items` | gauge | `host` |
| `openrig_fleet_queue_undelivered_items` | gauge | `host` |
| `openrig_fleet_host_last_progress_timestamp_seconds` | gauge | `host` |
| `openrig_fleet_host_stalled` | gauge | `host` |
| `openrig_fleet_stuck_sweep_last_run_timestamp_seconds` | gauge | `host` |
| `openrig_fleet_stuck_sweep_consecutive_failures` | gauge | `host` |
| `openrig_fleet_stuck_sweep_findings_routed_total` | counter | `host` |
| `openrig_fleet_seats` | gauge | `host`, `rig`, `activity` (`working`, `idle`, `needs-input`, `unknown`) |
| `openrig_fleet_seats_with_assigned_work` | gauge | `host`, `rig` |
| `openrig_fleet_seats_running` | gauge | `host`, `rig` |
| `openrig_fleet_attention_items` | gauge | `host`, `rig` |
| `openrig_fleet_rig_last_progress_timestamp_seconds` | gauge | `host`, `rig` |
| `openrig_fleet_rig_stalled` | gauge | `host`, `rig` |
| `openrig_fleet_queue_items` | gauge | `host`, `rig` (`none` when unattributed), `state` |
| `openrig_fleet_usage_read_ok` | gauge | |
| `openrig_fleet_usage_window_seconds` | gauge | |
| `openrig_fleet_usage_sampled_tokens_delta` | gauge | `host` |
| `openrig_fleet_usage_resets` | gauge | `host` |
| `openrig_fleet_usage_seats_ranked` | gauge | `host` |
| `openrig_fleet_usage_seats_unknown` | gauge | `host` |

### The `?host=<id>` read-through

Forwards one GET to a registered host, with a 5 s timeout. Allowed paths
(`domain/hosts/read-through.ts`): `/api/rigs/summary`, `/api/rigs/:rigId/graph`,
`/api/rigs/:rigId/nodes`, `/api/rigs/:rigId/nodes/:logicalId`, `/api/ps`,
`/api/telemetry/usage/series` (added on this branch), `/api/slices`, `/api/slices/:name`,
`/api/slices/:name/doc/*`, `/api/missions/:missionId`, `/api/specs/library`,
`/api/specs/library/:id/review`. Anything else is refused with 403 `read_through_path_not_allowed`, any
other method with 405 `cross_host_write_refused`, and a transport failure returns 502
`remote_read_failed`. Queue routes are not readable this way.

### Writes forwarded to a team

- `POST /api/mission-control/action` with a non-local `hostId` (any verb; the CLI and TUI use it for
  `resolve`): forwarded to that host. The hub
  removes any `auditNotes.openrig_relay` from the caller and sets
  `auditNotes.openrig_relay.from_host` to its own host id. The forwarded actor is the caller's
  (`human@host` for a person; a seat `member@rig` becomes `member@rig@<hub id>`). On the team, a claimed
  `openrig_relay` is kept only when it matches the relay header. Source: `routes/mission-control.ts`,
  `routes/relay-origin.ts`.
- `POST /api/queue/:qitemId/update` with `hostId`: forwarded the same way, with the caller's `hostId` and
  `actorSession` removed and the identity headers set by the hub. Source: `routes/queue.ts`.

## Daemon settings

Set with `rig config set <key> <value>` on the daemon that does the fan-out (the hub), read with
`rig config get`, reset with `rig config reset`. Defined in
`packages/daemon/src/domain/user-settings/settings-store.ts`. Read again on every fan-out; an invalid
stored value falls back to the default.

| Key | Default | Env var | Meaning |
|---|---|---|---|
| `fleet.stall_threshold_minutes` | 30 | `OPENRIG_FLEET_STALL_THRESHOLD_MINUTES` | Minutes a team may hold open work without progress before it is stalled. |
| `fleet.host_timeout_ms` | 5000 | `OPENRIG_FLEET_HOST_TIMEOUT_MS` | Deadline per team for one fan-out leg. |
| `fleet.fanout_concurrency` | 4 | `OPENRIG_FLEET_FANOUT_CONCURRENCY` | Teams read at once. Raise it for a large fleet. |

All three must be positive integers. Not configurable: the cache lifetime (3 s) and the stale bound
(60 s), in `domain/fleet/fleet-settings.ts`. A CLI or TUI reader waits for the hub at least 20 s, or
`ceil(hosts / concurrency) × host timeout + 10 s` when that is longer.

Existing settings the deployment uses: `feed.subscriptions.<host>.enabled` (set to `true` per team by the
dispatcher, so the hub reads the team's queue state).

## CLI additions

| Command | What changed |
|---|---|
| `rig ps --all-hosts` | Existing flag. Now reads `/api/fleet/summary` first and uses it when the hub's `hosts` cover every host in the CLI's own registry; otherwise it dials each host itself. On the hub path, rig rows add `stalled`, `minutesSinceProgress`, `lastQueueTransitionAt`, `lastSeatOutputAt`, `openWorkCount`, and `--nodes` adds `activity`, `needsInputReason`, `lastActivityAt`. |
| `rig usage top --all-hosts` | New. `--window <duration>` (default `1h`; `90m`, `2d`, or hours), `--top <n>` (at least 1), `--json` (keys: `source` `hub` or `cli-fanout`, `windowHours`, `top`, `topCap`, `totalSeatsRanked`, `unknown`, `totals`, `targetedHostIds`, `items`, `hosts`). |
| `rig usage series --host <id>` | New. One host's series through the hub's read-through. Combine with `--seat`, `--lane`, `--since`, `--until`, `--limit`, `--json`. |
| `rig queue resolve --host <id>` | New. `--decision` required. Without `OPENRIG_SESSION_NAME`, recorded on the team as `human@host`. |
| `rig queue update --host <id>` | New. Same identity rules; the receipt names `remoteHost`. |

`--host` on queue verbs is explicit only: they never follow `rig host select`. `--host local` writes
locally. The CLI finds its daemon through `OPENRIG_URL`, then the running daemon's state file, then the
configured address.

## TUI additions

| Where | What |
|---|---|
| PULSE | `[host]` labels on remote rows; remote items in NEEDS YOU (with an answer hint), PARKED WITH BATON, BLOCKED ON AGENTS and UP NEXT; new sections HOSTS DOWN and STALLED. |
| TOPOLOGY | Remote teams as collapsed rows; rigs and seats read through the hub on expand; remote seats read-only, with their `rig send` / `rig capture` address. |
| Instance page | `FLEET USAGE · last 1h`: the top 10 seats with `[host]`, `+N more ranked seats`, unknown teams with their reason. |
| Commands | `answer <qitem> <decision>` (alias `ans`), routed to the item's host. |

Nothing changes without remote hosts. The TUI connects to `--url`, else `OPENRIG_URL`, else
`http://127.0.0.1:7433`.

## hosts.yaml on the hub

`/home/openrig/.openrig/hosts.yaml` in `hub-0`, written by the dispatcher with `rig host add`:

```yaml
hosts:
  - id: t-proj-123
    transport: http
    url: http://t-proj-123-0.teams.openrig.svc:7433
    bearer_file: /home/openrig/.openrig/hosts.d/t-proj-123.bearer
```

`id` must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`; `kernel`, `host`, `local` and `external` are reserved. An `http`
entry takes `url` and at most one of `bearer_env` or `bearer_file`. The fleet reads dial only `http`
entries and report `ssh` entries as `unsupported-transport`. There is no `rig host remove`.

`hub-sync` decides what belongs to the dispatcher in two ways. An entry whose `id` names a team
StatefulSet in the namespace is that team's entry, whatever it currently holds, so a wrong `transport`,
`url` or `bearer_file` is repaired, and so is a bearer file whose contents no longer match the team's
Secret. An entry with no team behind it is removed only when it is exactly what
`start` writes: `t-<slug>`, `transport: http`, `url: http://t-<slug>-0.teams.<ns>.svc:7433` and
`bearer_file: /home/openrig/.openrig/hosts.d/t-<slug>.bearer`. Anything else -- another transport, a
host you registered by hand, or a `t-` id pointing somewhere else -- is reported and left alone.

The same bar applies to the parts that live outside `hosts.yaml`. A bearer file, a
`feed.subscriptions.<id>.enabled` node or a `host-bindings.json` alias that no entry claims and no team
StatefulSet backs is removed when its id is `t-<slug>` for a slug `slug_of` could have produced, because
with nothing pointing at it that name is the only thing left to vouch for it. "No entry claims it" is the
wide question, not the narrow one: an entry claims the id it holds, the bearer file it names and the alias
whose binding points back at it, because those are the parts an unregister of that name would remove -- so
a host you registered by hand keeps its token even when the file it lives in is named like a team's. A
leftover whose id is not shaped like a team's is left alone either way.

## Tests

| What | Command |
|---|---|
| Dispatcher archive, report, delete guard, answer | `bash deploy/kubernetes/dispatcher/test/archive-test.sh` |
| Dispatcher watch and resume | `bash deploy/kubernetes/dispatcher/test/watch-test.sh` |
| Dispatcher `hub-sync`, hub registry ownership, registry lock | `bash deploy/kubernetes/dispatcher/test/hub-sync-test.sh` |
| Daemon fleet reads, metrics, read-through | `cd packages/daemon && npx vitest run test/fleet-summary.test.ts test/fleet-usage.test.ts test/fleet-usage-route.test.ts test/fleet-metrics.test.ts test/fleet-metrics-route.test.ts test/host-read-through.test.ts test/browser-boundary-routes.test.ts` |
| CLI fleet commands | `cd packages/cli && npx vitest run test/usage-fleet.test.ts` |
| TUI | `cd packages/tui && npx vitest run` |
| Types and lint | `npm run lint` |

The dispatcher tests use a fake `kubectl` with recorded responses and need no cluster. Unset
`OPENRIG_URL` and `OPENRIG_PORT` before running daemon tests on a machine that also runs OpenRig.
