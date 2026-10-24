# Troubleshooting

Symptoms, their usual causes, and what to do. Most of these were met while building and testing this
deployment.

```bash
export KUBECONFIG=<the cluster's kubeconfig>
NS=openrig
D=deploy/kubernetes/dispatcher/rig-dispatch
HUB="kubectl -n $NS exec -i hub-0 -c daemon --"
```

## Starting a team

| Symptom | Cause and fix |
|---|---|
| The team pod stays `Pending`. | Not enough CPU or memory on any node, or no storage class can bind the volume. `kubectl -n $NS describe pod t-<slug>-0` names which. Lower `--cpu`/`--memory`, wait for capacity, or set a default storage class. Then run `start` again; it resumes. |
| `start` fails with "was not created". | A `ResourceQuota` rejected the pod. `kubectl -n $NS describe statefulset t-<slug>` shows `FailedCreate`. Wait for another team to finish, then run `start` again. |
| `ImagePullBackOff`. | The `ghcr-pull` Secret is missing or has no read access, or the pinned tag was never pushed. Check `kubectl -n $NS get secret ghcr-pull` and the tag in `kustomization.yaml`. |
| The pod never becomes Ready, `start` times out. | The workspace clone failed (wrong `--repo` or `--ref`, a private repository without credentials, or egress blocked). `kubectl -n $NS logs t-<slug>-0 -c daemon` shows the entrypoint's messages. |
| A pod fails to start with a ConfigMap error. | The kit's volume `items` in `rig-dispatch` name a key that is not in the `openrig-kit` ConfigMap. Keep every key listed there, or edit both places together ([setup.md](setup.md#4-the-team-template)). |
| `rig up failed`. | The spec path does not exist in the pod (`--spec` is a path inside the pod, under `/etc/openrig-kit`), or the spec is invalid. Run `kubectl -n $NS exec t-<slug>-0 -c daemon -- rig up <spec> --yes` to see the error. |
| Seats start but fail to call the model. | The provider variable is in the `openrig-agents` Secret but not named in `OPENRIG_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST` (in `dispatcher/team.env`), or egress to the provider is blocked by the NetworkPolicy. Variables that OpenRig does not know are never passed, even when named. |
| `rig send` inside a pod returns 401. | The terminal routes need the bearer on a non-loopback bind. The entrypoint writes it to `$OPENRIG_HOME/terminal-token`; if `OPENRIG_AUTH_BEARER_TOKEN` was empty at boot, that file is missing. Check the team's Secret. |

## The hub and its views

| Symptom | Cause and fix |
|---|---|
| The TUI shows your local rigs, not the fleet. | `OPENRIG_URL` was not set to the hub, so the TUI read the default port 7433 on your machine. Start it as in [setup.md](setup.md#7-connect-the-operator-machine-to-the-hub); the title line names the host it reads. |
| The TUI shows only `hub-0` and no teams. | The teams are not registered (see the next row), or the TUI is older than the hub. Use a TUI built from the same branch as the hub's image. |
| A team is missing on the hub. | The hub was not Ready when `start` ran, or its registration failed after the hand-over. `$D hub-sync --dry-run` says so, and `$D hub-sync` registers every handed-over, Ready team the hub is missing. For one team alone, `$D start <ticket>` again resumes and registers without handing the ticket over twice. `$HUB rig host list` shows what the hub knows. |
| A team appears on the hub with `unreachable` long after its `delete`. | A stale entry: the hub was not Ready during `delete`, or the StatefulSet was removed some other way. `$D hub-sync` removes it completely -- the `hosts.yaml` entry, the bearer file, the subscription and the alias. If the `delete` failed partway, the entry may already be gone and only the bearer file, the subscription or the alias left; `hub-sync` finds those too and finishes the removal. Hand cleanup ([operating.md](operating.md#the-hub-and-registration)) is the fallback for when the dispatcher cannot reach the hub. |
| `hub-sync` refuses to run and names a failed read. | The cluster did not answer, and a list that did not answer is not a list of nothing. Nothing was read and nothing was changed. Find out why `kubectl -n $NS get statefulsets -l openrig.dev/role=team` fails -- API server unreachable, throttling, RBAC -- and run it again. |
| One team disappeared from the hub after two dispatcher commands ran at once. | Registry edits are serialized in the hub pod, so this should not happen with a current dispatcher. If a row is missing anyway -- an older dispatcher, or a crash between two edits of one registration -- `$D hub-sync` restores it. If an edit said the hub's registry lock was held, raise `RIG_DISPATCH_HUB_LOCK_TIMEOUT`. |
| A team shows `auth-failed`. | The hub's bearer file for it is missing, empty or unreadable, or the team's Secret changed. `$D hub-sync` compares the file with the team's Secret and rewrites it from the Secret whenever they differ, as does `start <ticket>`. |
| A team's queue is empty on the hub but not in the pod. | `feed.subscriptions.t-<slug>.enabled` is not set on the hub, so the hub lists the host but never reads its queue. `start` sets it; `$D hub-sync` repairs it on every host it owns. |
| The port-forward stopped. | It ends when the operator machine sleeps or the hub pod restarts. Start it again. |
| `rig ps --all-hosts` from the operator machine lists hosts that are not teams, or reports teams as unreachable. | The CLI used your local host registry and fell back to dialling the hosts itself, which cannot reach team pods. Run the command in the hub pod (`$HUB rig ps --all-hosts`), or use a separate `OPENRIG_HOME` with `OPENRIG_URL` pointing at the hub. |
| Fleet reads are slow with many teams. | Each read waits for the slowest batch of teams. Raise `fleet.fanout_concurrency`, or lower `fleet.host_timeout_ms` so a dead team costs less ([reference.md](reference.md#daemon-settings)). |
| The status line says `showing the last successful read`. | The last fleet read failed and the TUI kept the previous one. The hub's log has the reason: `kubectl -n $NS logs hub-0 -c daemon`. |

## Stalls and findings

| Symptom | Cause and fix |
|---|---|
| A team shows as STALLED while its agents are clearly busy. | Long work without queue transitions. Terminal activity is deliberately not progress. Have agents post a short note on their item during long work (`rig queue update <qitem> --note "..."`), or raise `fleet.stall_threshold_minutes` on the hub. |
| A team stalls for real. | Look at its seats (`$HUB rig ps --all-hosts --nodes -A`, or the TUI's topology) and capture the busy one: `kubectl -n $NS exec t-<slug>-0 -c daemon -- rig capture <session> --lines 60`. Message the lead with `rig send`, or answer what it waits for. `wait --stall` sends such a message automatically. |
| Seats keep receiving `Stuck sweep: successor-verification-required` items after handing work back to the seat that assigned it. | A known OpenRig behaviour: an item closed as handed off to its own creator has no successor item, and the sweep asks for one. Nothing is lost. The seat records `rig queue update <item> --note "custody-verified: <target> <how>"` and closes the finding. |
| No stall verdict for a team with open work. | No qualifying transition was found among the reads (`stalled: null`). This happens with only system transitions, or many open items (`progressReadsTruncated`). |

## Answers, archives and deletes

| Symptom | Cause and fix |
|---|---|
| `answer` exits 5. | The answer may or may not have landed, and nothing was re-issued. Read the item in the team pod (`kubectl -n $NS exec t-<slug>-0 -c daemon -- rig queue show <qitem>`) before answering again. |
| `answer` exits 1 with `remote-error`. | The team refused the answer (for example, the item is no longer waiting for a human). Read the item; do not repeat the answer under another name. |
| The answer is recorded as the lead, not a human. | The hub could not take it and `answer` fell back to resolving inside the team pod. The log line says why. |
| `archive` exits 1. | A part failed; `manifest.json` names it with its error. Run `archive` again while the pod exists. |
| `delete` refuses. | The archive is incomplete, damaged, or older than the team's current state. The message names each part. Run `archive` (or `collect`) again, then `delete`. Use `--force` only when you accept losing the history. |
| `collect --into` fails to fetch. | The bundle is kept at `<root>/<slug>/result.bundle`; fetch it by hand: `git fetch <bundle> ticket/<slug>:refs/tickets/<slug>`. |

## Watching events

| Symptom | Cause and fix |
|---|---|
| `watch` is quiet although the team works. | Normal between transitions. Every 180 s of quiet it reads the status anyway (the backstop), so a missed event costs latency, not the verdict. |
| `watch` says the stream `would not stay open` and switches to polling. | Three connections failed. Either `kubectl exec` to the pod fails, or an unreadable event row blocks replay from the stored id ([operating.md](operating.md#how-watch-works)). Polling still reports the ticket. |
| A restarted team pod with a new volume sends no events to `watch`. | The stored event id is above the new volume's ids. The backstop status read still reports the ticket. `delete` and `start` of the same key start a fresh store. |

## The cluster

| Symptom | Cause and fix |
|---|---|
| `kubectl apply -k` reports NetworkPolicies as `configured` without a change in the repository. | Someone changed them in the cluster. The apply restored the repository's version. Find out who changed them before relying on the isolation. |
| A team pod restarted. | Its seats stopped with it; the volume kept state, sessions and workspace. `status` shows `degraded`; `wait` (or `start` again) brings the rig back with `rig up <rig> --existing`. `watch` only reports it. |
| The hub pod restarted. | Its registry and settings are on its volume. The fleet cache refills on the first read. Restart your port-forward. |
| Teams run an older image than the hub. | Expected: the image is fixed per team at `start`, and the hub only uses routes older images serve. New tickets get the new pin. |
