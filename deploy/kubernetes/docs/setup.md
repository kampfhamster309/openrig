# Setting up OpenRig on Kubernetes

This guide takes an empty cluster to a running factory: the shared objects, the hub, the dispatcher
on the operator machine, and a first ticket from start to delete. What each piece is and why it is
built that way is in [architecture.md](architecture.md). Day-to-day work is in
[operating.md](operating.md), and watching the fleet is in [monitoring.md](monitoring.md).

All paths are relative to the repository root. All commands assume:

```bash
export KUBECONFIG=<the cluster's kubeconfig>
NS=openrig
D=deploy/kubernetes/dispatcher/rig-dispatch
```

## 1. What you need

**The cluster**

- Kubernetes 1.30 or newer with a CNI that enforces NetworkPolicy. Without enforcement the manifests
  still apply, but the pods are not isolated from each other, and the security model in
  [architecture.md](architecture.md#security) does not hold. The deployment was tested on K3s
  (single-node k3d), whose built-in policy controller enforces them.
- A storage class for `ReadWriteOnce` volumes. Team pods use the cluster's default class. The hub
  names `local-path` in [`hub/statefulset.yaml`](../hub/statefulset.yaml); change it if your cluster
  has no such class. On more than one node, use a networked class, because `local-path` ties each
  pod to the node that holds its volume.
- Room for the teams you want in flight. Each team pod requests 500m CPU and 4Gi memory by default
  (limit 4Gi), with a 20Gi volume. The hub requests 250m and 512Mi, with a 5Gi volume. An idle
  three-seat team used about 0.7 GiB in tests (about 300 MiB per agent CLI). Builds and tests in the
  workspace come on top, so measure your own workload and set `--cpu`, `--memory` and `--storage` per
  ticket.
- Outbound access from the pods to your model provider (or LLM gateway) and to the Git remote of the
  repositories the teams work on.

**Access for the operator**

The dispatcher runs on the operator machine with the operator's kubeconfig. In namespace `openrig` it
needs: `get`, `list`, `create`, `delete` and `patch` on `statefulsets`, `secrets` and
`persistentvolumeclaims`;
`get`, `list` and `watch` on `pods`; and `create` on `pods/exec` and `pods/portforward`. Anyone with
`pods/exec` or `pods/portforward` on the hub can see every team, and anyone with `pods/exec` on a team
pod can act as that team, so grant these per person. An example Role is in [section 9](#9-access-for-more-people).

**On the operator machine**

- `kubectl`, `jq`, `git`, `bash` 4 or newer, `openssl`, `column` (util-linux).
- Docker with BuildKit (for building the image) and a login to your registry.
- Node 22 and the OpenRig CLI built from this branch, for the TUI and the fleet commands. The CLI
  must be no older than the hub's daemon. Install it from the checkout:

  ```bash
  npm ci
  bash scripts/build-package.sh
  (cd packages/cli && npm pack --pack-destination /tmp)
  npm install -g /tmp/openrig-cli-*.tgz
  rig --version
  ```

## 2. Build and publish the image

One image serves the hub, team pods and the optional single host. It holds Node 22, tmux, git, the
agent CLIs and OpenRig packed from this checkout. Its entrypoint runs the daemon in the foreground.

```bash
docker login <registry>
IMAGE=<registry>/<org>/openrig-host deploy/kubernetes/build-image.sh --push
# the last line is the image reference, for example <registry>/<org>/openrig-host:0.7.2-b8eca34c8
```

- The tag is `<OpenRig version>-<short commit>`. If `packages/` or `deploy/kubernetes/image/` have
  uncommitted changes, `-dirty-<UTC timestamp>` is appended, so a dirty build never reuses a clean
  tag.
- Agent CLI versions are pinned in [`image/Dockerfile`](../image/Dockerfile) (`ARG` lines). Change
  them there and rebuild.
- `--skip-package` reuses the last package build, which saves time when only the Dockerfile changed.

Pin the image in all three kustomizations. `rig-dispatch` reads the pin from the first one for new
team pods:

```bash
for f in deploy/kubernetes/kustomization.yaml deploy/kubernetes/hub/kustomization.yaml \
         deploy/kubernetes/single-host/kustomization.yaml; do
  sed -i -E "s#newName: .*#newName: <registry>/<org>/openrig-host#; s#newTag: .*#newTag: <tag>#" "$f"
done
```

## 3. Namespace and Secrets

```bash
kubectl apply -f deploy/kubernetes/manifests/namespace.yaml
```

Three Secrets are used. None of them is in the repository.

| Secret | Keys | Used by |
|---|---|---|
| `ghcr-pull` | `.dockerconfigjson` | Every pod, to pull a private image. Keep the name, or change `imagePullSecrets` in the manifests and in `rig-dispatch`. Not needed for a public image. |
| `openrig-agents` | one key per provider variable, for example `ANTHROPIC_API_KEY` | Every team pod, as environment. Seats see a variable only when it is also named in `dispatcher/team.env` (below). |
| `openrig-daemon` | `bearer` | Only the optional single host. Team pods get their own Secret from the dispatcher. |

Create them without putting a token on a command line, where other local users could see it in
`ps`. Write the values to a file only you can read, create the Secret from it, and delete the file:

```bash
umask 077
cat > /tmp/agents.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
kubectl -n $NS create secret generic openrig-agents --from-env-file=/tmp/agents.env
rm /tmp/agents.env

# the pull secret: build the docker config in a private file, never on a command line
printf '{"auths":{"<registry>":{"auth":"%s"}}}' \
  "$(printf '%s:%s' '<user>' "$(cat ~/.config/registry-read-token)" | base64 -w0)" > /tmp/pull.json
kubectl -n $NS create secret generic ghcr-pull --type=kubernetes.io/dockerconfigjson \
  --from-file=.dockerconfigjson=/tmp/pull.json
rm /tmp/pull.json
```

[`create-secrets.sh`](../create-secrets.sh) is the interactive script used in testing. It creates
`ghcr-pull` for `ghcr.io` (user from `GHCR_USER`), an `openrig-agents` Secret with a single
`CLAUDE_CODE_OAUTH_TOKEN` key, and `openrig-daemon` from a bearer it generates into
`~/.config/openrig/rig-0.bearer`, all in namespace `openrig`. For API keys, create `openrig-agents` as
above instead.

Then name the provider variables in [`dispatcher/team.env`](../dispatcher/team.env). OpenRig passes a
provider variable into a seat only when it is named in `OPENRIG_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST`
and is one OpenRig knows: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` and a few runtime-specific
ones (`KNOWN_PROVIDER_AUTH_ENV` in `packages/daemon/src/startup.ts`).

```bash
# dispatcher/team.env
OPENRIG_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST=ANTHROPIC_API_KEY
```

To route model traffic through an LLM gateway, put its key and `ANTHROPIC_BASE_URL` (or
`OPENAI_BASE_URL`) in the Secret and name both. Giving each team its own gateway key is what makes
exact cost per team possible; see [monitoring.md](monitoring.md#what-the-usage-numbers-are).

## 4. The team template

A team pod runs one rig, started from a rig spec in the kit. The kit is the ConfigMap `openrig-kit`,
built from [`kit/`](../kit) by [`kustomization.yaml`](../kustomization.yaml) and mounted read-only at
`/etc/openrig-kit` in every team pod. `rig-dispatch start` runs `rig up /etc/openrig-kit/rig.yaml`
unless `--spec` names another file.

The `kit/rig.yaml` in this directory is the example the deployment was tested with. Replace it with
your team. The dispatcher relies on these points:

- **A lead.** The ticket goes to the member whose logical id is `orch.lead` (`--lead` to change it).
  The lead receives the brief with a completion contract appended, so it must be able to organize the
  others and follow the contract.
- **A reviewer.** The contract makes the change complete only after a reviewer approved it. Give review
  seats a pod id starting with `review` (session names are `<pod>-<member>@<rig>`, for example
  `review-r1@feature-team`), so that `report` counts review rounds.
- **The workspace.** Members work in `/home/openrig/work/project`, where the entrypoint clones the
  ticket's repository.
- **No prompts.** Nobody answers permission prompts in a pod, so use `permission_policy: builtin:yolo`
  and `non_interruptive: true`. The pod is the sandbox (see [architecture.md](architecture.md#security)).
- **Agent specs** referenced by path in the image, for example
  `path:/usr/local/lib/node_modules/@openrig/cli/daemon/specs/agents/review/independent-reviewer`.

A minimal team with a lead, a builder and a reviewer:

```yaml
version: "0.2"
name: feature-team
summary: A lead organizes the ticket, a builder implements it, a reviewer checks it.
permission_policy: builtin:yolo
non_interruptive: true
pods:
  - id: orch
    label: Orchestration
    members:
      - id: lead
        agent_ref: "path:/usr/local/lib/node_modules/@openrig/cli/daemon/specs/agents/orchestration/orchestrator"
        runtime: claude-code
        profile: default
        cwd: /home/openrig/work/project
    edges: []
  - id: dev
    label: Development
    members:
      - id: build
        agent_ref: "path:/usr/local/lib/node_modules/@openrig/cli/daemon/specs/agents/development/implementer"
        runtime: claude-code
        profile: default
        cwd: /home/openrig/work/project
    edges: []
  - id: review
    label: Review
    members:
      - id: r1
        agent_ref: "path:/usr/local/lib/node_modules/@openrig/cli/daemon/specs/agents/review/independent-reviewer"
        runtime: claude-code
        profile: default
        cwd: /home/openrig/work/project
    edges: []
edges:
  - { kind: delegates_to, from: orch.lead, to: dev.build }
  - { kind: delegates_to, from: orch.lead, to: review.r1 }
  - { kind: can_observe, from: review.r1, to: dev.build }
```

The ConfigMap uses flat keys, and the pods lay them out as files through a fixed list of `items`. To
add a file, for example a second rig spec, add it to `configMapGenerator` in `kustomization.yaml` and
to the `items` of the `kit` volume in `rig-dispatch` (search for `openrig-kit`). Keep the existing keys
even if your rig does not use them: a pod whose `items` name a missing key does not start.

Kit edits take effect without restarting anything: the ConfigMap has no name hash, and mounted files
update within about a minute. Running teams keep the rig they started with.

## 5. Network egress

[`manifests/networkpolicy.yaml`](../manifests/networkpolicy.yaml) denies all ingress to team pods
(except from the hub, see below) and allows egress to cluster DNS and to public addresses only. Every
private range is excluded: other pods, the node network, the API server, the LAN and link-local
addresses.

- The second egress rule allows one LAN address and port. It exists for a model server on the test
  network. Replace it with your own internal endpoints (an LLM gateway, an internal Git server), or
  delete it.
- If the model provider or Git remote is public, the third rule already covers it.
- [`manifests/networkpolicy-hub.yaml`](../manifests/networkpolicy-hub.yaml) lets the hub reach team
  daemons on port 7433, and nothing else reach them.

## 6. Apply the shared objects and the hub

```bash
kubectl apply -k deploy/kubernetes          # namespace, Services, NetworkPolicies, the kit, the image pin
kubectl apply -k deploy/kubernetes/hub      # the hub: one daemon that sees every team
kubectl -n $NS rollout status statefulset/hub
kubectl -n $NS exec hub-0 -c daemon -- curl -fsS http://127.0.0.1:7433/healthz
```

Team pods are not part of these manifests. The dispatcher creates one per ticket.

[`single-host/`](../single-host) is optional: one long-lived host `rig-0` that you drive by hand with
`rig up --host`. It is not part of the factory flow. See [operating.md](operating.md#a-long-lived-host).

## 7. Connect the operator machine to the hub

The hub binds loopback inside its pod, so the only way in is `kubectl`:

```bash
kubectl -n $NS port-forward pod/hub-0 17433:7433 &
OPENRIG_HOME=$HOME/.openrig-hub-view OPENRIG_URL=http://127.0.0.1:17433 \
  node "$(npm root -g)/@openrig/cli/tui/dist/main.js" --url http://127.0.0.1:17433
```

- A separate `OPENRIG_HOME` keeps the hub view apart from any local OpenRig on the same machine.
- Set `OPENRIG_URL` to the hub explicitly. Without it, the TUI falls back to the default port 7433,
  which on a machine that also runs OpenRig locally is the local daemon, and you see your local rigs
  instead of the fleet. The title line names the host the TUI reads (`TOPOLOGY · hub-0`).
- `rig tui` opens the TUI for the local daemon and has no `--url`, so the hub view starts the TUI
  directly as above.
- Without the port-forward, every read also works through `kubectl exec`, which is what the
  dispatcher uses:

  ```bash
  kubectl -n $NS exec -i hub-0 -c daemon -- rig ps --all-hosts --nodes -A
  ```

## 8. First ticket

Run a small ticket end to end before you rely on the setup:

```bash
cat > /tmp/hello.md <<'EOF'
Add a file HELLO.md at the repository root with one line: "hello from the factory".
EOF
$D start HELLO-1 --repo https://github.com/<org>/<repo>.git --ref main --brief-file /tmp/hello.md
$D status HELLO-1
$D watch HELLO-1 --timeout 1800      # exit 0 done, 3 needs a human, 1 failed, 4 timeout
$D collect HELLO-1 --into ~/src/<repo>
$D report HELLO-1
$D delete HELLO-1
```

What to check on the way:

- `start` prints the pod becoming Ready, the rig coming up and the ticket handed to the lead. With the
  hub running, it also registers the team as host `t-hello-1`.
- In the TUI, the host `t-hello-1` appears with its rig and seats, and its queue items show in PULSE
  with the `[t-hello-1]` label.
- `collect` writes `./tickets/hello-1/` and fetches the result into your repository as
  `refs/tickets/hello-1`.
- `delete` passes its guard only after a complete archive, then removes the pod, its volume, its Secret
  and its entry on the hub.

If something fails, see [troubleshooting.md](troubleshooting.md).

## 9. Access for more people

The dispatcher has no server of its own; each operator runs it with their own kubeconfig. A namespaced
Role that covers it (adapt to your cluster's conventions; this Role was written for the guide, not
tested as written):

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: openrig-operator, namespace: openrig }
rules:
  - apiGroups: ["apps"]
    resources: ["statefulsets"]
    verbs: ["get", "list", "create", "delete", "patch"]
  - apiGroups: [""]
    resources: ["secrets", "persistentvolumeclaims"]
    verbs: ["get", "list", "create", "delete", "patch"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/exec", "pods/portforward"]
    verbs: ["create"]
```

A person who should only watch needs `pods/portforward` on `hub-0` and nothing on team pods. Today
OpenRig records an answer given through the hub as "a human, relayed from the hub", not as a named
person; see [architecture.md](architecture.md#answering-a-team-from-the-hub).
