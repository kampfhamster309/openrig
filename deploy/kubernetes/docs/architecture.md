# Architecture: OpenRig as a software factory on Kubernetes

What this branch builds, how the pieces fit, and why they are built the way they are. For the steps,
see [setup.md](setup.md), [operating.md](operating.md) and [monitoring.md](monitoring.md).

## The idea

A ticket comes in. The factory starts a team of coding agents for it in its own pod, the team builds and
reviews the change, and the factory collects the result and the history before the pod goes away. Many
teams run at once. One place, the hub, shows every team: what each is doing, which one needs a human,
which one has stopped making progress, and what each uses. Humans answer teams from that same place.

OpenRig provides the team: a daemon per host that runs agent seats in tmux, a queue the seats hand work
through, and a TUI and CLI. This branch adds what a fleet of short-lived hosts needs: the Kubernetes
deployment, a dispatcher, and OpenRig changes so one daemon can see and answer every other.

## The pieces

```text
 operator machine                              cluster, namespace openrig
┌──────────────────────────────┐             ┌──────────────────────────────────────────────────────┐
│ rig-dispatch (bash, kubectl) │──exec──────▶│ team pod t-proj-123-0          team pod t-proj-456-0 │
│   start / watch / answer /   │             │ ┌───────────────────────┐      ┌──────────────────┐  │
│   archive / report / delete  │──exec──┐    │ │ OpenRig daemon :7433  │      │ OpenRig daemon   │  │
│                              │        │    │ │ tmux: lead, builder,  │      │ tmux: seats      │  │
│ ./tickets/<slug>/ (archives) │        │    │ │   reviewer            │      │ workspace, queue │  │
│                              │        │    │ │ /home/openrig/work    │      └────────▲─────────┘  │
│ TUI / rig CLI ──port-forward─┼────┐   │    │ └──────────▲────────────┘               │            │
└──────────────────────────────┘    │   │    │            │ http + bearer, port 7433    │            │
                                    │   │    │ ┌──────────┴─────────────────────────────┴─────────┐  │
 Prometheus (optional, see          │   └───▶│ │ hub-0: OpenRig daemon, no rigs, loopback only    │  │
 monitoring.md) ────────────────────┴───────▶│ │ hosts.yaml = every team, one bearer per team     │  │
                                             │ │ fleet summary, fleet usage, /metrics, relay      │  │
                                             │ └──────────────────────────────────────────────────┘  │
                                             └──────────────────────────────────────────────────────┘
```

| Piece | What it is | Where |
|---|---|---|
| Image | Node 22, tmux, git, the agent CLIs and OpenRig packed from this checkout. The entrypoint clones the workspace on first boot, writes the terminal token and runs the daemon in the foreground. | [`image/`](../image), [`build-image.sh`](../build-image.sh) |
| Team pod | One per ticket: a StatefulSet `t-<slug>` with one replica, its own volume and its own bearer Secret. Runs one rig from the kit. The daemon binds `0.0.0.0:7433` with a bearer, and NetworkPolicy lets only the hub connect. | created by [`rig-dispatch`](../dispatcher/rig-dispatch) |
| Kit | ConfigMap `openrig-kit` mounted at `/etc/openrig-kit`: the rig spec and the files it refers to. | [`kit/`](../kit), [`kustomization.yaml`](../kustomization.yaml) |
| Hub | `hub-0`, one more daemon from the same image with no rigs (`OPENRIG_NO_KERNEL=1`), bound to loopback. Its `hosts.yaml` lists every team pod over the `http` transport. It is the single point of truth for the fleet. | [`hub/`](../hub) |
| Dispatcher | A bash script on the operator machine. It reaches pods only through `kubectl exec`, keeps all ticket state in labels and annotations, and registers teams on the hub. | [`dispatcher/`](../dispatcher) |
| NetworkPolicies | No ingress to team pods except the hub on 7433; no ingress to the hub; egress to DNS and public addresses only. | [`manifests/`](../manifests) |
| Single host | Optional long-lived host `rig-0`, driven by hand. Not part of the factory flow. | [`single-host/`](../single-host) |

## How a ticket flows

1. **Start.** `rig-dispatch start` creates the team's Secret and StatefulSet, waits for the pod to be
   Ready (the entrypoint has cloned the repository), runs `rig up` of the rig spec inside the pod, and
   creates a queue item for the lead with the brief and a completion contract. Then it registers the
   team on the hub as host `t-<slug>`.
2. **Work.** The lead delegates to its seats through the queue. Seats commit on `ticket/<slug>` in the
   pod's workspace. A question for a human is a queue item blocked on a human.
3. **Watch.** The hub reads every team through its fan-out (below), so the TUI, `rig ps --all-hosts`,
   `rig usage top --all-hosts` and `/metrics` show the team. `rig-dispatch watch` follows the team's own
   event stream and reports when it finishes or needs a human.
4. **Answer.** A human answers through the hub; the team records the answer as a human's, with the hub
   as its origin.
5. **Finish.** The lead writes `result.json` (`done`, `failed` or `needs-human`).
6. **Collect and delete.** `collect` archives the team's history and fetches the result branch as a git
   bundle; `report` computes figures from the archive; `delete` refuses unless the archive is complete
   and current, then removes the team and unregisters it from the hub.

## The hub's fleet reads

All fleet reads on the hub follow the same rules.

**Built only from routes old team images serve.** Team pods keep the image they started with and are
often older than the hub. So the hub composes everything from routes every team image already has
(`/healthz`, `/api/ps`, `/api/rigs/...`, `/api/queue/...`, `/api/telemetry/usage/top`), and no feature
on this branch needs a new route on the team side. Upgrading the hub never requires restarting teams.

**One fan-out.** `packages/daemon/src/domain/fleet/fleet-fanout.ts` reads all hosts with a deadline per
host (a slow team cannot delay the others past its own deadline), a concurrency limit, and a short cache
with stale-while-revalidate, so one fan-out serves every TUI, CLI and scraper reading at that moment.
The cost per team stays constant however many people watch. The settings are in
[reference.md](reference.md#daemon-settings).

**Unknown is not zero.** A host that did not answer is reported with its reason (unreachable, auth
failed, timed out) and contributes nothing to any total. It is never shown as idle or as zero usage.

**Reads**

| Read | What it gives | Used by |
|---|---|---|
| `GET /api/fleet/summary` | Per host: reachability, rigs, seats by activity, open queue items in every state with what they are blocked on, overdue and undelivered counts, the stuck-sweep heartbeat, the time since last progress and the stall verdict. | TUI (PULSE, topology), `rig ps --all-hosts`, `/metrics` |
| `GET /api/fleet/usage` | Per host: reachability and its usage top. Fleet-wide: the top seats labelled by host, and totals only where numbers can be added. | TUI (instance page), `rig usage top --all-hosts`, `/metrics` |
| `GET /metrics` | Prometheus text format, built from the two reads above through their cache. | Prometheus |
| `GET /api/review/fleet`, `/api/queue/attention-aggregate` | Needs-you items stamped with their host, and each host's attention class. Existed before this branch. | TUI NEEDS YOU |
| `?host=<id>` read-through | Forwards a single GET to one host, for a fixed allowlist of read routes (rigs, nodes, `ps`, the usage series, and a few more). Queue routes are excluded on purpose. | TUI drill-in, `rig usage series --host` |

**The stall rule.** A team is *stalled* when it has open work and no progress for longer than
`fleet.stall_threshold_minutes` (default 30), whatever its seats' activity says. Progress is a queue
transition written by a seat or a human, including a note-only update, so agents doing long work post a
short note as a heartbeat. Transitions written by system actors (`…@system` such as the watchdog,
`system`, `system:*`, `daemon@kernel`) do not count, because they keep firing on exactly the team that
is stuck. Pane output does not count either: a terminal's content changes every second while an agent's
spinner runs, also during a hung command. It is reported separately as `lastSeatOutputAt`.

## Answering a team from the hub

`rig queue resolve --host <team> <qitem> --decision <text>` (and `rig queue update --host`) run on the
hub and are forwarded to the team. The hub strips the caller's claimed actor and stamps it again from
its own context:

- A person running the command in the hub pod with no seat in the environment is recorded on the team as
  `human@host` with `claimed:v1` provenance.
- The hub adds its own host id to the mission-control audit row as `auditNotes.openrig_relay.from_host`
  (`packages/daemon/src/routes/relay-origin.ts`).

So the team's history says that a human answered, and that the answer came through the hub. It cannot
yet say which person: access to the hub is Kubernetes access, with no identity per person. The TUI on the
hub offers `answer <qitem> <decision>` for a remote item, and `rig-dispatch answer` uses the same path.

## What OpenRig gained on this branch

Each change is general multi-host work, not specific to Kubernetes. Commits are on the branch
`kubernetes-integration`, stacked on `main` at `f06e626b4`.

| Commit | Change |
|---|---|
| `44925e72a` | **TUI: cross-host queue state in PULSE.** NEEDS YOU shows the fleet's needs-you items with a `[host]` label and the command to answer on that host; the attention aggregate feeds the other sections; hosts that are down are shown. |
| `8f1cd113b` | **TUI: remote rigs and seats in the topology.** A reachable remote host expands to its rigs and seats through the read-through, read only while expanded. Seats show the address for `rig send` and `rig capture`. |
| `2bb5d42e2` | **Answering a remote team.** `rig queue resolve --host` and `rig queue update --host`, forwarded with the relay audit above, and the TUI's `answer` for remote items. |
| `968ed13ba` | **The fleet summary.** `GET /api/fleet/summary` with the per-host deadline, concurrency limit, cache and stall verdict; `rig ps --all-hosts` uses it and falls back to its own fan-out against an older daemon. |
| `85ea56454` | **TUI: the fleet summary in PULSE.** Remote items blocked on an agent in BLOCKED ON AGENTS, remote idle in-progress items in PARKED, and a STALLED section with how long a team has made no progress. |
| `76b524726` | **Fleet usage.** `GET /api/fleet/usage` on the shared fan-out, summed only where numbers add. |
| `871567e27` | **`rig usage top --all-hosts`**, with the same fallback rule as `rig ps --all-hosts`. |
| `80a55a956` | **`rig usage series --host`**: one seat's usage series on a remote host, through the read-through, whose allowlist gains exactly this one path. |
| `8d9ecee11` | **TUI: FLEET USAGE** on the hub's instance page: the top seats with `[host]`, and hosts that did not answer. |
| `f504189a4` | **`GET /metrics`**: the fleet as one Prometheus scrape target, behind the same browser boundary as `/api/*`. |

Deployment commits (all under `deploy/kubernetes/`):

| Commit | Change |
|---|---|
| `a03661f38` | The image, a team pod per ticket, and `rig-dispatch` (`start`, `status`, `wait`, `collect`, `delete`). |
| `8c4caedd9` | The long-lived single host becomes optional. |
| `edc7a5d63`, `decac5757` | The hub, and registering and unregistering team pods with it. |
| `9daa57f78`, `299127dff` | [HUB-TEST.md](../HUB-TEST.md): what the hub was observed to do, with evidence, and its failure paths. |
| `abcdd69d0`, `88b127e40`, `462068342` | The ticket archive, the delete guard, `report`, and `answer` through the hub. |
| `d210d573b` | `rig-dispatch watch`: following a team's events with resume. |
| `87232db28` | `rig-dispatch hub-sync`: repairing the hub's registry against the teams that exist, and one lock around every registry edit in the hub pod. |
| `71300a97a`, `571c086ec` | Image pins. |

Each feature was proven live against real team pods in the test cluster before it was merged here; the
evidence for the hub is in [HUB-TEST.md](../HUB-TEST.md).

## Security

| Concern | Measure |
|---|---|
| Agents run without permission prompts | The pod is the boundary: non-root (uid 1000), no privilege escalation, all capabilities dropped, `RuntimeDefault` seccomp, no service-account token, and egress limited by NetworkPolicy to DNS and public addresses. A team reaches its model provider and its Git remote, not the cluster, the node network, the API server or the LAN. |
| What an agent can read | Its provider credentials (the variables named in the allowlist) and its own pod's bearer, since seats run as the daemon's user. No Git push credentials, no service-account token. |
| A team's bearer leaks | One bearer per team, valid for that pod only, and only the hub can connect to the pod. |
| The hub holds every team's bearer | The hub runs no agents, binds loopback, has egress only to DNS and team daemons, and is reached only through `kubectl port-forward` or `exec`. Access to the hub is access to the namespace. |
| `/metrics` from a browser | It sits behind the same browser boundary as `/api/*`, so a web page cannot read it through a rebound host name. |
| The dispatcher can create pods and exec into them | Namespace-scoped RBAC for the people who run it ([setup.md](setup.md#9-access-for-more-people)). |
| Provider credentials | One Secret, passed into seats only for variables named in `OPENRIG_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST`. With an LLM gateway, each team can get its own revocable key. |
| Git credentials | None in the pod. The result leaves as a git bundle through `kubectl exec`. If teams must push, give each a credential for its one repository in its own Secret. |

## What is not built

- **Exact cost per ticket.** OpenRig's usage numbers are sampled readings. Exact tokens and cost come
  from an LLM gateway with one key per team; the deployment supports pointing seats at one
  (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`) but does not include it.
- **Who answered.** Answers are recorded as "a human, relayed from the hub", not as a named person.
- **Reconciling the hub by itself.** `hub-sync` repairs the hub's registry when it drifts, but nothing
  runs it: a team deleted while the hub was down stays registered until someone runs
  `$D hub-sync` ([operating.md](operating.md#the-hub-and-registration)). There is no controller, no
  periodic sync, and `start`, `delete` and `watch --all` do not call it -- one ticket's command
  rewriting another ticket's registration is a larger blast radius than the drift it would fix, and a
  command that did it could not keep its own exit codes.
- **A queue for tickets beyond capacity.** `start` waits for the pod and times out; it does not queue.
- **Prometheus access to the hub.** `/metrics` exists; how a scraper reaches the loopback-bound hub is a
  deploy choice, described in [monitoring.md](monitoring.md#scraping-metrics-with-prometheus).
- **Object storage for archives.** A sync command is described, not built
  ([operating.md](operating.md#keeping-archives-in-object-storage)).
- **Actions on remote seats in the TUI.** The TUI shows remote seats and answers remote questions; to
  send to or capture a remote seat, it prints the `rig` command to run.
