#!/usr/bin/env bash
# Build the OpenRig host image from this checkout, optionally pushing it.
#   deploy/kubernetes/build-image.sh [--push] [--skip-package]
# IMAGE overrides the repository (default ghcr.io/kampfhamster309/openrig-host).
# Prints the image reference on the last line.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$REPO_ROOT/deploy/kubernetes"
IMAGE="${IMAGE:-ghcr.io/kampfhamster309/openrig-host}"
push=0 package=1
for arg in "$@"; do
  case "$arg" in
    --push) push=1 ;;
    --skip-package) package=0 ;;
    *) echo "usage: $0 [--push] [--skip-package]" >&2; exit 2 ;;
  esac
done

base="$(grep -v '^#' "$REPO_ROOT/docker/testbed/base-image" | grep -m1 .)"
rev="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
version="$(node -p "require('$REPO_ROOT/packages/cli/package.json').version")"
tag="$IMAGE:$version-$rev"
[ -z "$(git -C "$REPO_ROOT" status --porcelain -- packages deploy/kubernetes/image)" ] || tag="$tag-dirty-$(date -u +%Y%m%d%H%M)"

context="$(mktemp -d)"
trap 'rm -rf "$context"' EXIT
cp "$HERE/image/Dockerfile" "$HERE/image/entrypoint.sh" "$context/"

if [ "$package" = 1 ]; then
  bash "$REPO_ROOT/scripts/build-package.sh" >&2
fi
(cd "$REPO_ROOT/packages/cli" && npm pack --silent --pack-destination "$context" | tail -n1) >/dev/null
mv "$context"/openrig-cli-*.tgz "$context/openrig.tgz"

DOCKER_BUILDKIT=1 docker build \
  --build-arg BASE_IMAGE="$base" \
  --build-arg OPENRIG_REVISION="$(git -C "$REPO_ROOT" rev-parse HEAD)" \
  -t "$tag" "$context" >&2

if [ "$push" = 1 ]; then
  docker push "$tag" >&2
fi
echo "$tag"
