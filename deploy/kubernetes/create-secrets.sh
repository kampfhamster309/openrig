#!/usr/bin/env bash
# Create the Secrets the openrig StatefulSet needs. Prompts for each token; values are never echoed
# or written to disk. Re-running replaces existing Secrets.
#   KUBECONFIG=... deploy/kubernetes/create-secrets.sh
# The daemon bearer is read from (or generated into) ~/.config/openrig/rig-0.bearer, which the
# operator's `rig host add --bearer-file` points at.
set -euo pipefail

ns=openrig
kubectl="${KUBECTL:-kubectl}"
apply() { "$kubectl" -n "$ns" apply -f - >/dev/null; }

bearer_file="$HOME/.config/openrig/rig-0.bearer"
if [ ! -s "$bearer_file" ]; then
  mkdir -p "$(dirname "$bearer_file")"
  (umask 077; openssl rand -hex 32 | tr -d '\n' > "$bearer_file")
fi
"$kubectl" -n "$ns" create secret generic openrig-daemon --from-file=bearer="$bearer_file" \
  --dry-run=client -o yaml | apply
echo "openrig-daemon: ok"

read -rsp 'GHCR token with read:packages: ' ghcr </dev/tty; echo
[ -n "$ghcr" ] || { echo "empty token" >&2; exit 1; }
# Tokens go to kubectl on stdin, never as arguments, which other local users could see in `ps`.
auth=$(printf '%s:%s' "${GHCR_USER:-kampfhamster309}" "$ghcr" | base64 -w0)
printf '{"auths":{"ghcr.io":{"auth":"%s"}}}' "$auth" |
  "$kubectl" -n "$ns" create secret generic ghcr-pull --type=kubernetes.io/dockerconfigjson \
    --from-file=.dockerconfigjson=/dev/stdin --dry-run=client -o yaml | apply
unset auth
unset ghcr
echo "ghcr-pull: ok"

read -rsp 'Claude Code OAuth token (from `claude setup-token`): ' claude </dev/tty; echo
[ -n "$claude" ] || { echo "empty token" >&2; exit 1; }
printf '%s' "$claude" | "$kubectl" -n "$ns" create secret generic openrig-agents \
  --from-file=CLAUDE_CODE_OAUTH_TOKEN=/dev/stdin --dry-run=client -o yaml | apply
unset claude
echo "openrig-agents: ok"

"$kubectl" -n "$ns" get secrets
