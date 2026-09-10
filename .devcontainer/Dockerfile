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
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        python3 \
        python3-venv \
        util-linux

RUN set -eux; \
    groupadd --gid 1001 opencode-demo; \
    useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash opencode-demo; \
    install -d -m 0755 -o opencode-demo -g opencode-demo /home/opencode-demo/.cache


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
    npm install \
        --omit=dev \
        --ignore-scripts \
        --package-lock=false \
        --no-audit \
        --no-fund


FROM base AS python-dependencies
COPY plugins/repl/requirements.txt /tmp/requirements.txt

RUN --mount=type=cache,target=/root/.cache/pip \
    set -eux; \
    python3 -m venv /opt/opencode-repl-python; \
    /opt/opencode-repl-python/bin/pip install \
        --disable-pip-version-check \
        --no-compile \
        -r /tmp/requirements.txt


FROM base AS final

COPY --from=ttyd-tooling /opt/ttyd/ttyd /usr/local/bin/ttyd
COPY --from=gh-tooling /opt/gh/gh /usr/local/bin/gh
COPY --from=opencode-tooling --chown=opencode-demo:opencode-demo \
    /home/opencode-demo/.opencode/ /home/opencode-demo/.opencode/
COPY --from=node-dependencies \
    /opt/opencode-repl-tools/node_modules/ /opt/opencode-repl-tools/node_modules/
COPY --from=python-dependencies \
    /opt/opencode-repl-python/ /opt/opencode-repl-python/

RUN set -eux; \
    test -x /usr/local/bin/ttyd; \
    test -x /usr/local/bin/gh; \
    test -x /home/opencode-demo/.opencode/bin/opencode2; \
    test -x /opt/opencode-repl-python/bin/python; \
    node --version; \
    python3 --version

CMD ["sleep", "infinity"]
