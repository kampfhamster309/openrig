# OpenRig host image: one container is one OpenRig host (daemon + tmux + agent CLIs).
# Built by deploy/kubernetes/build-image.sh, which packs OpenRig from this checkout into the
# build context as openrig.tgz. Layers follow docker/testbed/Dockerfile, without the stub assets.

ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# tmux runs the seats; python3/make/g++ build better-sqlite3 on install (see the testbed Dockerfile);
# python3 also runs pi-seat-status. ripgrep, jq, less and rsync are for the agents and test suites.
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git tmux tini procps locales \
      python3 make g++ ripgrep jq less rsync; \
    sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen; locale-gen; \
    rm -rf /var/lib/apt/lists/*
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 TERM=xterm-256color

ARG NODE_VERSION=22.23.4
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) NODE_ARCH=x64 ;; \
      arm64) NODE_ARCH=arm64 ;; \
      *) echo "unsupported or empty TARGETARCH=${TARGETARCH}; build with BuildKit" >&2; exit 1 ;; \
    esac; \
    tarball="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"; \
    curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
      | awk -v f="$tarball" '$2 == f { print $1 "  /tmp/node.tar.xz" }' | sha256sum -c -; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner; \
    rm -f /tmp/node.tar.xz; \
    node --version

# Agent CLIs, pinned. Bump deliberately; OpenRig's runtime adapters are version-sensitive.
ARG CLAUDE_CODE_VERSION=2.1.309
ARG PI_VERSION=1.1.0
RUN set -eux; \
    npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@earendil-works/pi-coding-agent@${PI_VERSION}"; \
    claude --version; pi --version

COPY openrig.tgz /tmp/openrig.tgz
RUN set -eux; npm install -g /tmp/openrig.tgz; rm -f /tmp/openrig.tgz; rig --version

RUN useradd --create-home --uid 1000 --shell /bin/bash openrig
COPY entrypoint.sh /usr/local/bin/openrig-entrypoint
RUN chmod 0755 /usr/local/bin/openrig-entrypoint

ARG OPENRIG_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/kampfhamster309/openrig" \
      org.opencontainers.image.revision="${OPENRIG_REVISION}"

USER openrig
WORKDIR /home/openrig
EXPOSE 7433
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/openrig-entrypoint"]
