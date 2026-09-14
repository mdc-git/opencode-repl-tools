# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:26.8.2-bookworm-slim
ARG BUN_IMAGE=oven/bun:1
ARG RUNTIME_IMAGE=debian:bookworm-slim
ARG TTYD_VERSION=1.7.7
ARG BUBBLEWRAP_VERSION=0.12.0
ARG BUBBLEWRAP_SHA256=9760d007363e3abba7c747489910f9f82d9fca53ba3bd3282e396fa3c97a3314
ARG OPENCODE_UPDATE_CACHE_KEY=local

FROM ${NODE_IMAGE} AS node-runtime

FROM ${BUN_IMAGE} AS bun-runtime
USER root

FROM node-runtime AS tooling-base
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl python3 python3-venv
RUN set -eux; \
    groupadd --gid 1001 opencode-demo; \
    useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash opencode-demo

FROM tooling-base AS ttyd-tooling
ARG TTYD_VERSION
RUN set -eux; \
    curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/SHA256SUMS" -o /tmp/ttyd-checksums; \
    curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64" -o /tmp/ttyd; \
    grep ' ttyd.x86_64$' /tmp/ttyd-checksums | sed 's#ttyd.x86_64#/tmp/ttyd#' | sha256sum -c -; \
    install -D -m 0755 /tmp/ttyd /opt/ttyd/ttyd

FROM ${RUNTIME_IMAGE} AS bubblewrap-tooling
ARG BUBBLEWRAP_VERSION
ARG BUBBLEWRAP_SHA256
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      libcap-dev \
      meson \
      ninja-build \
      pkg-config \
      xz-utils
RUN set -eux; \
    curl -fsSL \
      "https://github.com/containers/bubblewrap/releases/download/v${BUBBLEWRAP_VERSION}/bubblewrap-${BUBBLEWRAP_VERSION}.tar.xz" \
      -o /tmp/bubblewrap.tar.xz; \
    printf '%s  %s\n' "$BUBBLEWRAP_SHA256" /tmp/bubblewrap.tar.xz | sha256sum -c -; \
    mkdir /tmp/bubblewrap-src; \
    tar -xJf /tmp/bubblewrap.tar.xz -C /tmp/bubblewrap-src --strip-components=1; \
    meson setup /tmp/bubblewrap-src/_build /tmp/bubblewrap-src \
      -Dselinux=disabled \
      -Dman=disabled \
      -Dbash_completion=disabled \
      -Dzsh_completion=disabled \
      -Dtests=false; \
    meson compile -C /tmp/bubblewrap-src/_build; \
    install -D -m 0755 /tmp/bubblewrap-src/_build/bwrap /opt/bubblewrap/bwrap; \
    /opt/bubblewrap/bwrap --version | grep -Fx 'bubblewrap 0.12.0'

FROM bun-runtime AS opencode-tooling
ARG OPENCODE_UPDATE_CACHE_KEY
ENV BUN_INSTALL=/opt/opencode-runtime \
    BUN_INSTALL_GLOBAL_DIR=/opt/opencode-runtime/install/global \
    BUN_INSTALL_BIN=/opt/opencode-runtime/bin \
    PATH=/opt/opencode-runtime/bin:/usr/local/bin:/usr/bin:/bin
RUN --mount=type=cache,target=/root/.bun/install/cache \
    set -eux; \
    test -n "$OPENCODE_UPDATE_CACHE_KEY"; \
    bun install --global --trust "@opencode/cli@beta"; \
    echo "OpenCode bootstrap: $(opencode2 --version)"; \
    opencode2 update --method bun; \
    echo "OpenCode after update 1: $(opencode2 --version)"; \
    opencode2 update --method bun; \
    stable="$(opencode2 --version)"; \
    echo "OpenCode stable seed: $stable"; \
    case "$stable" in opencode\ v2.*) ;; *) echo "OpenCode updater did not produce stable V2: $stable" >&2; exit 1 ;; esac; \
    opencode_path="$(readlink -f "$(command -v opencode2)")"; \
    test -x "$opencode_path"; \
    case "$opencode_path" in /opt/opencode-runtime/*) ;; *) exit 1 ;; esac; \
    install -D -m 0755 "$opencode_path" /opt/opencode-bootstrap/opencode2

FROM bun-runtime AS node-dependencies
WORKDIR /opt/opencode-repl-tools
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    set -eux; \
    bun install --production --frozen-lockfile --ignore-scripts

FROM tooling-base AS python-dependencies
COPY plugins/repl/requirements.txt /tmp/requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip \
    set -eux; \
    requirements_sha="$(sha256sum /tmp/requirements.txt | cut -d' ' -f1)"; \
    python_version="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"; \
    venv="/opt/opencode-repl-cache/opencode/repl-tools/python/${python_version}/${requirements_sha}/venv"; \
    python3 -m venv "$venv"; \
    "$venv/bin/pip" install --disable-pip-version-check --no-compile -r /tmp/requirements.txt; \
    chmod -R a-w /opt/opencode-repl-cache; \
    chmod -R a+rX /opt/opencode-repl-cache

FROM ${RUNTIME_IMAGE} AS runtime-base
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      libatomic1 \
      libcap2 \
      libstdc++6 \
      python3 \
      util-linux; \
    groupadd --gid 1001 opencode-demo; \
    useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash opencode-demo; \
    chmod 0700 /home/opencode-demo; \
    install -d -o 1001 -g 1001 -m 0755 \
      /opt/opencode-update-cache \
      /opt/opencode-runtime \
      /opt/opencode-runtime/bin \
      /opt/opencode-runtime/install \
      /opt/opencode-runtime/install/global; \
    ln -s /opt/opencode-bootstrap/opencode2 /opt/opencode-runtime/bin/opencode2; \
    chown -h 1001:1001 /opt/opencode-runtime/bin/opencode2; \
    find / -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod a-s {} +; \
    find / -xdev \( -type f -o -type d \) -perm -0002 -exec chmod o-w {} +

FROM runtime-base AS final
COPY --chmod=0755 --from=bubblewrap-tooling /opt/bubblewrap/bwrap /usr/bin/bwrap
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY --from=ttyd-tooling /opt/ttyd/ttyd /usr/local/bin/ttyd
COPY --chmod=0755 --from=opencode-tooling /opt/opencode-bootstrap/opencode2 /opt/opencode-bootstrap/opencode2
COPY --from=node-dependencies /opt/opencode-repl-tools/node_modules/ /opt/opencode-repl-tools/node_modules/
COPY --from=python-dependencies /opt/opencode-repl-cache/ /opt/opencode-repl-cache/
COPY --chmod=0755 .devcontainer/opencode-ephemeral.sh /usr/local/bin/opencode-ephemeral
COPY --chmod=0755 .devcontainer/run-demo-container.sh /usr/local/bin/run-demo-container
COPY --chmod=0755 .devcontainer/smoke-demo-tui.sh /usr/local/bin/smoke-demo-tui
COPY package.json bun.lock README.md /opt/opencode-demo/source/
COPY .opencode/ /opt/opencode-demo/source/.opencode/
COPY plugins/ /opt/opencode-demo/source/plugins/
ENV HOME=/home/opencode-demo
WORKDIR /home/opencode-demo
USER root
CMD ["/usr/local/bin/run-demo-container"]
