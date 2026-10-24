# OpenRig on Kubernetes

Run OpenRig as a software factory: one team of coding agents per ticket, each in its own pod, and one
hub that shows every team, tells you which one needs a human or has stopped making progress, lets you
answer it, and publishes the fleet for Prometheus. A dispatcher on the operator machine starts teams,
follows them, collects their result and history, and removes them.

```text
operator machine                       cluster (namespace openrig)
  rig-dispatch ──── kubectl exec ────▶  team pod t-<ticket>-0   (one per ticket: daemon, seats, workspace)
  TUI / rig CLI ─── port-forward ───▶  hub-0 ── http + bearer ──▶ every team pod
  ./tickets/  (archives)                 └─ /metrics for Prometheus
```

## Documentation

| Read | For |
|---|---|
| [docs/architecture.md](docs/architecture.md) | What is built, how the pieces fit, why, the security model, and what is not built yet. |
| [docs/setup.md](docs/setup.md) | From an empty cluster to a first ticket: image, Secrets, team template, egress, hub, operator machine. |
| [docs/operating.md](docs/operating.md) | Running tickets: start, watch, answer, collect, report, delete; the hub's registration; upgrades; capacity. |
| [docs/monitoring.md](docs/monitoring.md) | The TUI on the hub, the fleet CLI, the stall verdict, events, Prometheus metrics, alerts and dashboards, what usage numbers mean. |
| [docs/reference.md](docs/reference.md) | Every command, flag, variable, route, setting and metric. |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Symptoms, causes and fixes. |
| [HUB-TEST.md](HUB-TEST.md) | The first test of the hub on a real cluster, with evidence (historical). |

## Quick start

```bash
export KUBECONFIG=<the cluster's kubeconfig>
IMAGE=<registry>/<org>/openrig-host deploy/kubernetes/build-image.sh --push   # pin the printed tag in the three kustomizations
kubectl apply -f deploy/kubernetes/manifests/namespace.yaml
# create the Secrets openrig-agents and ghcr-pull, name the provider variables in dispatcher/team.env
kubectl apply -k deploy/kubernetes          # shared objects and the team template (kit)
kubectl apply -k deploy/kubernetes/hub      # the hub

D=deploy/kubernetes/dispatcher/rig-dispatch
$D start PROJ-123 --repo https://github.com/org/repo.git --ref main --brief-file proj-123.md
$D watch PROJ-123                           # 0 done, 3 needs a human, 1 failed, 4 timeout
$D answer PROJ-123 <qitem> "<decision>"     # when it needs a human
$D collect PROJ-123 --into ~/src/repo       # archive the history, fetch the result
$D report PROJ-123
$D delete PROJ-123

kubectl -n openrig port-forward pod/hub-0 17433:7433 &
OPENRIG_HOME=$HOME/.openrig-hub-view OPENRIG_URL=http://127.0.0.1:17433 \
  node "$(npm root -g)/@openrig/cli/tui/dist/main.js" --url http://127.0.0.1:17433
```

Each step is explained in [docs/setup.md](docs/setup.md).

## What is here

| Path | What it is |
|---|---|
| `image/`, `build-image.sh` | The host image (Node 22, tmux, git, agent CLIs, OpenRig from this checkout) and its build. |
| `manifests/` | Namespace, the headless `teams` Service, NetworkPolicies. |
| `kustomization.yaml` | The shared objects, the kit ConfigMap, and the image pin new team pods get. |
| `kit/` | The team template, mounted at `/etc/openrig-kit`: the rig spec and the files it refers to. The files here are the example used in testing; replace `rig.yaml` with your team. |
| `hub/` | The hub: a daemon with no rigs whose `hosts.yaml` lists every team. |
| `dispatcher/` | `rig-dispatch`, `team.env` (the environment every team pod gets), and tests that run without a cluster. |
| `create-secrets.sh` | Creates the Secrets interactively. |
| `single-host/` | Optional: one long-lived host driven by hand. |
| `docs/` | The documentation above. |

## Tests

```bash
bash deploy/kubernetes/dispatcher/test/archive-test.sh
bash deploy/kubernetes/dispatcher/test/watch-test.sh
bash deploy/kubernetes/dispatcher/test/hub-sync-test.sh
```

All three use a fake `kubectl` and need no cluster. The OpenRig tests for the fleet reads, CLI and TUI are
listed in [docs/reference.md](docs/reference.md#tests).
