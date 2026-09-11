# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:26.8.2-bookworm-slim
ARG TTYD_VERSION=1.7.7
ARG GH_VERSION=2.100.0
ARG OPENCODE_CACHE_KEY=2026-09-10

FROM ${NODE_IMAGE} AS base
ENV DEBIAN_FRONTEND=noninteractive
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl python3 python3-venv tmux util-linux
RUN set -eux; \
    groupadd --gid 1001 opencode-demo; \
    useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash opencode-demo; \
    chmod 0700 /home/opencode-demo

FROM base AS ttyd-tooling
ARG TTYD_VERSION
RUN set -eux; \
    curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/SHA256SUMS" -o /tmp/ttyd-checksums; \
    curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64" -o /tmp/ttyd; \
    grep ' ttyd.x86_64$' /tmp/ttyd-checksums | sed 's#ttyd.x86_64#/tmp/ttyd#' | sha256sum -c -; \
    install -D -m 0755 /tmp/ttyd /opt/ttyd/ttyd

FROM base AS gh-tooling
ARG GH_VERSION
RUN set -eux; \
    archive="gh_${GH_VERSION}_linux_amd64.tar.gz"; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt" -o /tmp/gh-checksums; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${archive}" -o "/tmp/${archive}"; \
    cd /tmp; \
    grep " ${archive}$" gh-checksums | sha256sum -c -; \
    tar -xzf "${archive}"; \
    install -D -m 0755 "gh_${GH_VERSION}_linux_amd64/bin/gh" /opt/gh/gh

FROM base AS opencode-tooling
ARG OPENCODE_CACHE_KEY
USER opencode-demo
RUN set -eux; \
    test -n "${OPENCODE_CACHE_KEY}"; \
    curl -fsSL https://opencode.ai/v2/install | bash; \
    test -x /home/opencode-demo/.opencode/bin/opencode2
USER root

FROM base AS node-dependencies
WORKDIR /opt/opencode-repl-tools
COPY package.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --omit=dev --ignore-scripts --package-lock=false --no-audit --no-fund

FROM base AS python-dependencies
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

FROM base AS final
COPY --from=ttyd-tooling /opt/ttyd/ttyd /usr/local/bin/ttyd
COPY --from=gh-tooling /opt/gh/gh /usr/local/bin/gh
COPY --from=opencode-tooling /home/opencode-demo/.opencode/ /opt/opencode/
COPY --from=node-dependencies /opt/opencode-repl-tools/node_modules/ /opt/opencode-repl-tools/node_modules/
COPY --from=python-dependencies /opt/opencode-repl-cache/ /opt/opencode-repl-cache/
COPY --chmod=0755 .devcontainer/run-demo-container.sh /usr/local/bin/run-demo-container
COPY --chmod=0755 .devcontainer/run-demo-session.sh /usr/local/bin/run-demo-session
COPY --chmod=0755 .devcontainer/publish-demo.sh /usr/local/bin/publish-demo
RUN set -eux; \
    chown -R root:root /opt/opencode /opt/opencode-repl-tools /opt/opencode-repl-cache /usr/local/bin/gh /usr/local/bin/ttyd /usr/local/bin/run-demo-container /usr/local/bin/run-demo-session /usr/local/bin/publish-demo; \
    chmod -R a-w /opt/opencode /opt/opencode-repl-tools /opt/opencode-repl-cache; \
    chmod -R a+rX /opt/opencode /opt/opencode-repl-tools /opt/opencode-repl-cache; \
    chmod 0700 /root /usr/local/bin/gh /usr/local/bin/ttyd /usr/local/bin/run-demo-container /usr/local/bin/publish-demo; \
    chmod 0755 /usr/local/bin/run-demo-session; \
    find / -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod a-s {} +; \
    find / -xdev \( -type f -o -type d \) -perm -0002 -exec chmod o-w {} +; \
    test -x /usr/local/bin/ttyd; \
    test -x /usr/local/bin/gh; \
    test -x /usr/bin/tmux; \
    test -x /usr/bin/setpriv; \
    test -x /opt/opencode/bin/opencode2; \
    test -x /usr/local/bin/run-demo-container; \
    test -x /usr/local/bin/run-demo-session; \
    test -x /usr/local/bin/publish-demo; \
    node --version; \
    python3 --version
CMD ["/usr/local/bin/run-demo-container"]
