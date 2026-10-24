# The hub, tested on the cluster

Stage 2 of `docs/proposals/factory-on-kubernetes.md`: an OpenRig daemon in the cluster that runs no
rigs, whose `hosts.yaml` lists every team pod, so one point of truth shows every team. Built in
[`hub/`](hub/), wired into [`dispatcher/rig-dispatch`](dispatcher/rig-dispatch), network rules in
[`manifests/networkpolicy-hub.yaml`](manifests/networkpolicy-hub.yaml).

This file records what was **observed**, not what the design expects. Each row says yes or no, with
the command and the output that decided it. Two of the proposal's expectations did not
hold; they are recorded as no with the reason.

## Environment

| | |
|---|---|
| Cluster | single-node k3d (K3s v1.36.1, `local-path`), namespace `openrig` only |
| Image | `ghcr.io/kampfhamster309/openrig-host:0.6.10-f06e626b4-dirty-202610231150` (not rebuilt) |
| Hub | StatefulSet `hub`, pod `hub-0`, bind `127.0.0.1:7433`, `OPENRIG_NO_KERNEL=1` |
| Teams | two, `t-hubtest-a` and `t-hubtest-b`, three seats each (`claude-pi-k8s`) |
| Operator TUI | `0.6.8` installed locally; `0.6.10` available in the image |

Both tickets were deliberately tiny. HUBTEST-A added one file and finished. HUBTEST-B was written so
the team could not finish without a human: the brief named two plausible final filenames and told the
lead not to guess.

## The hub itself

| Expected | Obs. | Evidence |
|---|---|---|
| One more daemon from the same image, no rigs | yes | `kubectl -n openrig logs hub-0`: `starting daemon 0.6.10 (f06e626b) on 127.0.0.1:7433`, `startup reconcile: rigs=0`, `kernel-boot: OPENRIG_NO_KERNEL=1 — skipping kernel auto-boot` |
| Bound to loopback | yes | `OpenRig daemon listening on http://127.0.0.1:7433`; the daemon needs no bearer for a loopback bind (`assertBindAuthInvariant` short-circuits on `isLoopbackBind`) |
| Its own volume for `~/.openrig` | yes | `pvc/home-hub-0` 5Gi, `Bound`; `hosts.yaml`, `config.json` and `hosts.d/` all live under it |
| No agent credentials | yes | `hub/statefulset.yaml` has no `envFrom` and no `openrig-agents` reference; the only Secrets in the namespace are `ghcr-pull` and `openrig-agents`, and only team pods take the latter |
| Same hardened securityContext as team pods | yes | `runAsNonRoot`, uid/gid 1000, `fsGroup: 1000`, `seccompProfile: RuntimeDefault`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, `automountServiceAccountToken: false` |
| Pod becomes Ready | yes, with one change | `pod/hub-0 1/1 Running`. **The probe had to be an `exec` curl, not `httpGet`**: the kubelet probes the pod IP and a loopback bind has no listener there, so `httpGet` would never have gone Ready |

## NetworkPolicy

Tested with a third pod (`netpol-probe`, no OpenRig labels) plus the pods themselves. `http=000`
with `curl` exit 7 means the connection never completed, i.e. refused or dropped.

| Expected | Obs. | Evidence |
|---|---|---|
| Team pods accept 7433 from the hub pod only | yes | hub → team: `curl http://t-hubtest-a-0.teams.openrig.svc:7433/healthz` → `http=200`. Unlabelled probe → same URL → `http=000`. Team A → team B on 7433 → `http=000` |
| Hub may connect to team pods on 7433 | yes | `rig host doctor t-hubtest-a` in the hub: `✓ transport-reachability: healthz ok at http://t-hubtest-a-0.teams.openrig.svc:7433`, `✓ remote-identity: authenticated daemon API answers (/api/ps)` |
| Hub may connect to cluster DNS | yes | `getent hosts t-hubtest-a-0.teams.openrig.svc` in `hub-0` → `10.42.0.26 t-hubtest-a-0.teams.openrig.svc.cluster.local` |
| Hub connects to nothing else | yes | hub → `https://api.anthropic.com/` → `http=000` (`Failed to connect … after 4007 ms`); hub → `https://10.43.0.1:443/` (API server) → `http=000` |
| Team pods keep their current egress rules | yes | `openrig-team-from-hub` declares `policyTypes: [Ingress]` only, so it cannot restrict egress; the teams' egress stays in `openrig-host`. Teams still reached their model provider and git — both teams cloned the repo and ran a full three-seat task |
| The bearer still matters once the network allows it | yes | hub → team `/api/ps` **without** the bearer → `http=403`. The NetworkPolicy is not the only boundary |

## Dispatcher registration

| Expected | Obs. | Evidence |
|---|---|---|
| `start` registers the team after its pod is Ready | yes, after two fixes | `[rig-dispatch] registered t-hubtest-a with the hub at http://t-hubtest-a-0.teams.openrig.svc:7433`; `hosts.yaml` then carries `id: t-hubtest-a`, `transport: http`, `bearer_file: …/t-hubtest-a.bearer`, `notes: ticket HUBTEST-A, rig claude-pi-k8s` |
| Bearer file mode 0600, absolute path | yes | `ls -l` in `hub-0`: `-rw------- 1 openrig openrig 64 … t-hubtest-a.bearer`. It is written on stdin, so the bearer never appears in a command line |
| `feed.subscriptions.t-<slug>.enabled true` | yes | `config.json`: `{"feed":{"subscriptions":{"t-hubtest-a":{"enabled":true}, …}}}` |
| `delete` unregisters | yes | `[rig-dispatch] unregistered t-hubtest-a from the hub`, then after both deletes: `hosts.yaml` = `hosts: []`, `hosts.d/` empty, `config.json` = `{"feed":{"subscriptions":{}}}`, and `host-bindings.json` = `{"version":1,"bindings":{}}` |
| Idempotent | yes | A second `start` logged `hub already has host t-hubtest-a` and changed nothing; a second `delete HUBTEST-A` on a gone ticket succeeded; the remove mode prints `absent` and exits 0 |
| Without a hub the dispatcher works as before | yes | Before the hub existed the same `start` logged `no Ready hub pod hub-0; hubtest-a is not registered with any hub` (wording since widened into the M1 warning) and still created the pod, brought the rig up and handed over the ticket |
| No restart needed to pick up a host | yes | `rig host list` in the hub showed both teams `reachable` with no daemon restart; `hosts.yaml` and `config.json` are re-read per request |

Two deviations from the brief, both improvements found on the way:

- The brief assumed there is no `rig config unset`. There is: **`rig config reset <key>`**, and for
  the dynamic class it deletes the whole `feed.subscriptions.<host>` node. Unregistering therefore
  leaves no `enabled: false` residue behind a host that no longer exists.
- There is still no `rig host remove`, so `hosts.yaml` is edited directly with the CLI's own `yaml`
  dependency through `node` (the image has no PyYAML). `hub_registry` has `has` and `remove` modes
  and `hub_register` re-reads the file after `rig host add`, so a silent no-op fails loudly.

## Operator access

| Expected | Obs. | Evidence |
|---|---|---|
| `kubectl port-forward` to the hub works although it binds loopback | yes | `kubectl -n openrig port-forward pod/hub-0 17433:7433` then `curl http://127.0.0.1:17433/healthz` → `http=200`; `/api/health` returned a JSON body. port-forward connects inside the pod's network namespace, so loopback is reachable even though the kubelet's own probes cannot be |
| The TUI runs against it with a short `OPENRIG_HOME` | yes | `OPENRIG_HOME=/tmp/tuihome node "$(npm root -g)/@openrig/cli/tui/dist/main.js" --url http://127.0.0.1:17433` opened, showed `hub-0` in TOPOLOGY and `(no rigs served — proven empty)`. SYSTEM ▸ Connections confirmed the target: `daemon: ok · 0.6.10`, `host: hub-0 (named)`, `target: http://127.0.0.1:17433/` |

## What the hub shows with today's code

This is the proposal's list, checked against what was on the screen and in the responses at the same
moment. Two rows came out **no**.

| Proposal expected | Obs. | Evidence |
|---|---|---|
| NEEDS YOU across all teams, each item labelled with its team's host id (`/api/review/fleet`) | **no** in the TUI; the daemon read is yes | The daemon read was right twice. At 13:17 `GET /api/review/fleet` returned `{"hostId":"t-hubtest-b","summary":"HUBTEST-B: should HUBTEST-B.md become NOTES.md or HUBTEST-NOTES.md?","leg":"park-on-human","qitemId":"qitem-…7ed2c7733cf4eaa0"}` — team B's parked item, team A had none then. After that one was answered, a second needs-you item was parked on **team A** at 13:23:24 purely to test the TUI, and the fleet read returned it as `hostId: t-hubtest-a`. At 13:23:56, with that item live, the TUI's FEED ▸ Human requests said `No current items in the available source window`. Three reasons, all TUI-side: PULSE's ▲ NEEDS YOU is built by `pulse/pulse-model.ts:needsRows()` from `client.queueAttention()` — the **hub's own** queue, empty on a daemon that runs no rigs; the fleet read lands in `snap.needs`, which `render.ts:256` uses only filtered to `item.target === session`, i.e. inside a seat's drill-in, and a remote host has no seats in the tree to drill into; and `render.ts:needsLine()`, the only code that formats the `[hostId]` label, is defined and **never called** |
| Every team as a host in the topology, reachable or not, and down hosts in the hosts-down list | **no** in the TUI; the aggregate reads are yes | The aggregate reads are right: `/api/review/fleet` and `/api/queue/attention-aggregate` both returned `local`, `t-hubtest-a`, `t-hubtest-b` with `status: ok`. The TUI tree showed `hub-0` only. `tui/src/hydrate.ts` still builds remote hosts with `rigs: []`, and `snap.hostsDown` — populated at `hydrate.ts:715` from any host whose status is not `ok` — is never read by `render.ts` |
| From a shell in the hub, `rig ps --all-hosts --nodes -A` for every seat of every team | yes | In `hub-0`, the command returned `[host=t-hubtest-a]` and `[host=t-hubtest-b]` blocks with all three seats each: `orch.lead running idle`, `dev.build running idle`, `review.r1 running idle` |
| `rig capture\|send <seat>@<rig>@t-<slug>` for any seat | yes | In `hub-0`: `rig capture review-r1@claude-pi-k8s@t-hubtest-b --lines 6` → `[via host=t-hubtest-b (http://t-hubtest-b-0.teams.openrig.svc:7433)]` followed by the rendered pane |
| It does **not** show the teams' rigs and seats in the TUI tree, their blocked and in-progress items, or usage | yes, confirmed absent | Same cause as the two rows above. The blocked item was visible in `/api/queue/attention-aggregate` (`{"hostId":"t-hubtest-b","state":"blocked"}`) and in `rig ps`, never in the TUI |

The two **no** rows are the proposal's own stage 3.1 and 3.2 (remote rigs in the TUI through the
read-through, cross-host queue state in the TUI). The daemon side of stage 2 is enough; the TUI side
is not there yet, and the operator's one point of truth today is `rig ps` and the fan-out routes in a
shell inside `hub-0`, not the TUI tree. Fixing the first row needs no new daemon work: the fleet read
already returns the items and their `hostId`, so 3.2 is a TUI change to feed ▲ NEEDS YOU from
`/api/review/fleet` (or the attention aggregate's items) instead of the local queue.

## The needs-you path end to end

| Step | Obs. | Evidence |
|---|---|---|
| The team asks instead of guessing | yes | team B parked its ticket item: `state: blocked`, `blockedOn: human@host`, `summary: "HUBTEST-B: should HUBTEST-B.md become NOTES.md or HUBTEST-NOTES.md?"` |
| It reaches the hub, labelled with the team | yes | the fleet row above, `hostId: t-hubtest-b`, `leg: park-on-human` |
| `rig-dispatch answer` unblocks it | yes, after a fix | `rig queue resolve` derives its actor from the seat env, so a bare `kubectl exec` shell failed with `--actor is required when OPENRIG_SESSION_NAME is not set`. `cmd_answer` now runs it as the ticket's lead session. The row went `blocked` → `in-progress` with `lastNudgeResult: claimed` |
| The team continues and finishes | yes | `git log ticket/hubtest-b`: `a057d70f chore: rename HUBTEST-B.md to NOTES.md` on top of `3e1cd00b chore: add HUBTEST-B.md`; `git show --stat` → `HUBTEST-B.md => NOTES.md`, `1 file changed, 0 insertions`. `result.json` then read `{"status": "done", … "human decided the name, so renamed to NOTES.md in a follow-up commit"}` |
| The needs-you item clears | yes | after the answer, `/api/review/fleet` → `needsYou: 0`, `/api/queue/attention-aggregate` → `items: []` |
| Two tickets at once | yes | both pods Ready and both teams working in parallel; `rig ps --all-hosts --nodes -A` from the hub listed six seats across two hosts |
| `collect` then `delete`, and the hub forgets | yes | `collect` wrote `status.json`, `queue.json`, `nodes.json`, per-seat `usage-*.json` and a `result.bundle` (576 B and 880 B) per ticket. After `delete`: no team StatefulSet, Pod or PVC left, `hosts: []`, `hosts.d/` empty, empty subscriptions, and the fleet and aggregate reads returned `local` only |

## Defects found by running this, and fixed

1. `hub_ready` used a jsonpath with escaped quotes inside `$( )`, so the backslashes stayed literal,
   `kubectl` reported `unterminated filter`, and a Ready hub was reported as absent. Both teams came
   up unregistered.
2. `hub_registry` built its pipeline as `printf script | kubectl exec -i … env NPM_ROOT=$(hub_npm_root) …`.
   The command substitution ran with the pipeline's stdin open, so the inner `kubectl exec -i` read
   the script meant for `node -`. `node` got empty input, exited 0, `has` said the host was present,
   and `rig host add` was skipped — leaving bearer files and feed subscriptions for hosts that were
   never in `hosts.yaml`. Fixed by resolving the npm root before the pipeline, giving the inner exec
   `</dev/null`, and re-reading `hosts.yaml` after the add.
3. `rig-dispatch answer` failed with `--actor is required`; it now names the ticket's lead session.

## Round 2: the review fixes, verified

The review found no blocking issue; two medium and two low findings were about failure paths and
wording. M2, M1, L1, L2 and D3 are code, D1, D2 and D4 are docs. All are fixed.

- **M2** — `hub_register` now runs after the queue handover, so a Ready-but-failing hub can no longer
  strand a team with a running rig and no ticket. The log order shows it: `handed HUBTEST-C to
  orch-lead@claude-pi-k8s as qitem-…045161190b8e72c8` is printed **before** `registered t-hubtest-c
  with the hub at http://t-hubtest-c-0.teams.openrig.svc:7433`. The failure is still `die`, so `start`
  still exits non-zero.
- **M1** — both not-Ready paths now log a warning naming what was left behind. Register: `no hosts.yaml
  entry, no bearer file /home/openrig/.openrig/hosts.d/t-<slug>.bearer, no
  feed.subscriptions.t-<slug>.enabled`, plus `re-run start <ticket>`. Unregister: names the host and
  gives the three hand commands. No `hub-sync` was built; it is listed under Next.
- **L1** — the rewrite goes through `writeAtomic` (tmp file + `renameSync`, mode 0600) for both
  `hosts.yaml` and `host-bindings.json`. After a full register/delete cycle `ls -A ~/.openrig/` shows
  no leftover `*.tmp-*`. The concurrent `start`/`delete` lost-update is documented in the README and
  under Not tested; it is not fixed here.
- **L2** — `unregistered $host from the hub` is logged only when all three steps succeeded, otherwise
  `WARNING: $host is only partly unregistered; check hosts.yaml, … by hand`. A failed subscription set
  is now a `die`, like a failed add.
- **D3** — `hub_registry remove` also drops the alias from `host-bindings.json`, matching on the key
  or on `bindings[*].hostId`, and tolerates the file being absent or unreadable.

Verified with one tiny ticket, `HUBTEST-C`, end to end on the cluster:

| Step | Observed |
|---|---|
| `start` hands over **and** registers | `handed HUBTEST-C to orch-lead@claude-pi-k8s as qitem-…045161190b8e72c8`, then `registered t-hubtest-c with the hub at http://t-hubtest-c-0.teams.openrig.svc:7433`; `hosts.yaml` gained the entry, `hosts.d/t-hubtest-c.bearer` was `-rw-------`, `config.json` had `"t-hubtest-c": {"enabled": true}`, and `/api/queue/attention-aggregate` returned `local` + `t-hubtest-c`, both `ok` |
| the identity binding is learned | `rig host doctor t-hubtest-c` → `✓ host-identity-binding: learned host identity 't-hubtest-c' (first contact)`, and `host-bindings.json` then held `bindings["t-hubtest-c"]` |
| `delete` forgets all four | `hosts.yaml` → `hosts: []`; `hosts.d/` empty; `config.json` → `{"feed":{"subscriptions":{}}}`; `host-bindings.json` → `{"version":1,"bindings":{}}`; `rig host list` → `No hosts registered in /home/openrig/.openrig/hosts.yaml` |
| no temp files, no cluster residue | no `*.tmp-*` in `~/.openrig`; only `hub-0` and `pvc/home-hub-0` left in the namespace |

## Reproducing

```bash
export KUBECONFIG=...
kubectl apply -k deploy/kubernetes && kubectl apply -k deploy/kubernetes/hub
kubectl -n openrig rollout status statefulset/hub

D=deploy/kubernetes/dispatcher/rig-dispatch
$D start PROJ-123 --repo <url> --brief-file brief.md     # registers with the hub
$D status                                                # phase, seats, open items
$D answer PROJ-123 <qitem> "Use NOTES.md."              # unblock a parked decision
$D collect PROJ-123 --into ~/src/repo
$D delete PROJ-123                                      # unregisters

# the operator's view
kubectl -n openrig port-forward pod/hub-0 17433:7433 &
OPENRIG_HOME=/tmp/tuihome node "$(npm root -g)/@openrig/cli/tui/dist/main.js" --url http://127.0.0.1:17433
# and, today, the reads that actually show the teams:
kubectl -n openrig exec -i hub-0 -c daemon -- rig ps --all-hosts --nodes -A
kubectl -n openrig exec -i hub-0 -c daemon -- rig host list
```

## Not tested

- More than two teams, and therefore the fleet fan-out's shared 4 s deadline under load. The
  proposal's scale note (stage 3.3) is unverified.
- Hub restart and volume survival across a reschedule. `local-path` ties the pod to one node, and
  only one node exists here.
- Anything that needs a second namespace or a second cluster.
- A hub that is down or Ready-but-failing at `start` or `delete` time. The code now logs a warning
  naming exactly what was left behind and the commands to clean it, and `start` hands the ticket over
  before it registers so a failing hub cannot strand a team. Neither path was forced on the cluster.
- Concurrent `start` and `delete` for different tickets. `rig host add` is last-write-wins, so a
  concurrent pair can drop one host entry; the unregister rewrite is atomic (tmp + rename), so the
  daemon never sees a half-written file, but the lost update is real and only a re-run repairs it.
- The `0.6.10` TUI over a port-forward from the operator's own machine. The TUI runs above were
  `0.6.8` locally (which never calls `/api/review/fleet`) and `0.6.10` inside `hub-0`; the rendering
  conclusions come from the `0.6.10` source plus the `0.6.10` TUI in the pod.

## Next

- **`rig-dispatch hub-sync`.** A reconcile that registers every team StatefulSet the hub does not know
  and forgets every `t-*` host with no StatefulSet, run at the end of `start` and `delete`. It is the
  real fix for both the down-hub residue and the concurrent-update race above, and it is deliberately
  out of this ticket.
- Stage 3.1 and 3.2, which turn the two **no** rows above into yes. 3.2 needs no daemon change: the
  fleet read already returns the items and their `hostId`.
