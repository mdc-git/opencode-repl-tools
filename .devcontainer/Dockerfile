# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:26.8.2-bookworm-slim
ARG BUN_IMAGE=oven/bun:1
ARG RUNTIME_IMAGE=debian:bookworm-slim
ARG TTYD_VERSION=1.7.7
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

FROM bun-runtime AS opencode-tooling
ARG OPENCODE_UPDATE_CACHE_KEY
ENV BUN_INSTALL=/opt/opencode-runtime \
    PATH=/opt/opencode-runtime/bin:/usr/local/bin:/usr/bin:/bin
RUN --mount=type=cache,target=/root/.bun/install/cache \
    set -eux; \
    test -n "$OPENCODE_UPDATE_CACHE_KEY"; \
    bun install --global --trust "@opencode/cli@beta"; \
    echo "OpenCode bootstrap: $(opencode2 --version)"; \
    opencode2 update --method bun; \
    echo "OpenCode after update 1: $(opencode2 --version)"; \
    opencode2 update --method bun; \
    second="$(opencode2 --version)"; \
    echo "OpenCode after update 2: $second"; \
    opencode2 update --method bun; \
    third="$(opencode2 --version)"; \
    echo "OpenCode after update 3: $third"; \
    test "$second" = "$third"; \
    case "$third" in opencode\ v2.*) ;; *) echo "OpenCode updater did not converge on stable V2: $third" >&2; exit 1 ;; esac; \
    opencode_path="$(readlink -f "$(command -v opencode2)")"; \
    test -x "$opencode_path"

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
      libstdc++6 \
      python3 \
      python3-venv \
      tmux \
      util-linux; \
    groupadd --gid 1001 opencode-demo; \
    useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash opencode-demo; \
    chmod 0700 /home/opencode-demo; \
    find / -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod a-s {} +; \
    find / -xdev \( -type f -o -type d \) -perm -0002 -exec chmod o-w {} +

FROM runtime-base AS final
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY --from=ttyd-tooling /opt/ttyd/ttyd /usr/local/bin/ttyd
COPY --chown=1001:1001 --from=opencode-tooling /opt/opencode-runtime/ /opt/opencode-runtime/
COPY --from=node-dependencies /opt/opencode-repl-tools/node_modules/ /opt/opencode-repl-tools/node_modules/
COPY --from=python-dependencies /opt/opencode-repl-cache/ /opt/opencode-repl-cache/
COPY --chmod=0755 .devcontainer/run-demo-container.sh /usr/local/bin/run-demo-container
COPY --chmod=0755 .devcontainer/run-demo-session.sh /usr/local/bin/run-demo-session
COPY package.json bun.lock README.md /opt/opencode-demo/source/
COPY .opencode/ /opt/opencode-demo/source/.opencode/
COPY plugins/ /opt/opencode-demo/source/plugins/
ENV HOME=/home/opencode-demo
WORKDIR /home/opencode-demo
USER opencode-demo
CMD ["/usr/local/bin/run-demo-container"]
