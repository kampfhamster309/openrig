#!/usr/bin/env bash
# OpenRig host entrypoint (runs under tini). Prepares the persistent home, then runs the daemon in
# the foreground: `rig daemon start` detaches, which would let the container exit.
#
# Environment (all optional unless noted):
#   OPENRIG_AUTH_BEARER_TOKEN  required by the daemon for a non-loopback bind
#   OPENRIG_WORKSPACE_REPO     git URL cloned into OPENRIG_WORKSPACE_DIR on first boot
#   OPENRIG_WORKSPACE_REF      branch or tag to check out (default: the remote's default branch)
#   OPENRIG_WORKSPACE_DIR      default $HOME/work/project
#   OPENRIG_PI_SEATS           space-separated Pi seat session names to seed, e.g. dev-build@my-rig
#   OPENRIG_KIT_DIR            mounted kit (default /etc/openrig-kit); pi/models.json and
#                              pi-extensions/*.ts in it are seeded into each Pi seat's agent dir
#   GIT_USER_NAME, GIT_USER_EMAIL  identity for the agents' commits
set -euo pipefail

log() { echo "[openrig-entrypoint] $*" >&2; }

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

: "${OPENRIG_HOME:=$HOME/.openrig}"
: "${OPENRIG_KIT_DIR:=/etc/openrig-kit}"
: "${OPENRIG_WORKSPACE_DIR:=$HOME/work/project}"
export OPENRIG_HOME
mkdir -p "$OPENRIG_HOME"

git config --global user.name "${GIT_USER_NAME:-OpenRig agents}"
git config --global user.email "${GIT_USER_EMAIL:-openrig@localhost}"
git config --global init.defaultBranch main

# With a non-loopback bind the daemon's terminal routes (`rig send`, compaction, terminal) require
# the bearer, and the CLI in the seats reads it from this file. Seats run as the daemon's user and
# could read its environment anyway; the ingress NetworkPolicy is what keeps the bearer useful
# only from inside this pod or through a port-forward.
if [ -n "${OPENRIG_AUTH_BEARER_TOKEN:-}" ]; then
  # chmod as well: umask covers only a new file, and fsGroup relaxes the mode of existing ones.
  (umask 077; printf '%s' "$OPENRIG_AUTH_BEARER_TOKEN" > "$OPENRIG_HOME/terminal-token")
  chmod 0600 "$OPENRIG_HOME/terminal-token"
fi

# Clone into a temporary directory and move it into place, so an interrupted first boot never
# leaves a half-cloned workspace that later boots would take as done.
if [ -n "${OPENRIG_WORKSPACE_REPO:-}" ] && [ ! -d "$OPENRIG_WORKSPACE_DIR/.git" ]; then
  log "cloning $OPENRIG_WORKSPACE_REPO into $OPENRIG_WORKSPACE_DIR"
  mkdir -p "$(dirname "$OPENRIG_WORKSPACE_DIR")"
  rm -rf "$OPENRIG_WORKSPACE_DIR.clone"
  git clone --quiet ${OPENRIG_WORKSPACE_REF:+--branch "$OPENRIG_WORKSPACE_REF"} \
    "$OPENRIG_WORKSPACE_REPO" "$OPENRIG_WORKSPACE_DIR.clone"
  mv -T "$OPENRIG_WORKSPACE_DIR.clone" "$OPENRIG_WORKSPACE_DIR"
fi

# `rig up` writes these into the seats' cwd; keep them out of the team's commits.
if [ -d "$OPENRIG_WORKSPACE_DIR/.git" ]; then
  exclude="$OPENRIG_WORKSPACE_DIR/.git/info/exclude"
  for f in /CLAUDE.md /AGENTS.md /.mcp.json; do
    grep -qxF "$f" "$exclude" 2>/dev/null || echo "$f" >> "$exclude"
  done
fi

# A Pi seat reads models.json and extensions from $OPENRIG_HOME/state/pi/<seat>/agent, never
# ~/.pi/agent, and OpenRig does not write them (docs/reference/rig-spec.md, "Pi"). The kit's copies
# are authoritative and refreshed on every boot.
for seat in ${OPENRIG_PI_SEATS:-}; do
  agent_dir="$OPENRIG_HOME/state/pi/$seat/agent"
  mkdir -p "$agent_dir/extensions"
  if [ -f "$OPENRIG_KIT_DIR/pi/models.json" ]; then
    install -m 0600 "$OPENRIG_KIT_DIR/pi/models.json" "$agent_dir/models.json"
  fi
  rm -f "$agent_dir"/extensions/*.ts
  for ext in "$OPENRIG_KIT_DIR"/pi-extensions/*.ts; do
    [ -e "$ext" ] && install -m 0644 "$ext" "$agent_dir/extensions/$(basename "$ext")"
  done
  log "seeded Pi seat $seat"
done

daemon_entry="$(npm root -g)/@openrig/cli/daemon/dist/index.js"
log "starting daemon $(rig --version) on ${OPENRIG_BIND_HOST:-127.0.0.1}:${OPENRIG_PORT:-7433}"
exec node "$daemon_entry"
