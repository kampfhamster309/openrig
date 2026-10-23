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
$D answer PROJ-123 <qitem> "Use the existing retry helper."
$D collect PROJ-123 --into ~/src/repo   # archive to ./tickets/proj-123, fetch refs/tickets/proj-123
$D delete PROJ-123
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
  its reachability); `delete` unregisters it, with `rig config reset` as the unset. Both are
  idempotent, and with no Ready hub pod in the namespace they are no-ops, so the dispatcher works
  exactly as before.
- **It binds loopback.** Nothing in the cluster dials the hub, and the operator comes in through
  `kubectl port-forward`, which connects inside the pod. A loopback bind needs no bearer, so reaching
  the hub is exactly having `pods/portforward` on the namespace. Its readiness probe is therefore an
  `exec` curl, not `httpGet`: the kubelet probes the pod IP, where a loopback bind has no listener.
- **What it shows, and what it does not.** The daemon-side fan-outs work: `/api/review/fleet` stamps
  every needs-you item with its team's `hostId`, the attention aggregate reports each team's status,
  and `rig ps --all-hosts --nodes -A` lists every seat. The TUI does not render those yet: it shows
  `hub-0` only, because remote hosts still hydrate with `rigs: []` and nothing reads the hosts-down
  list. That gap is stage 3.1 and 3.2, and HUB-TEST.md records the evidence.

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
