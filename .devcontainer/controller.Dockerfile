# syntax=docker/dockerfile:1.7

ARG DEMO_IMAGE=ghcr.io/mdc-git/opencode-repl-tools-demo:demo
ARG DOCKER_CLI_IMAGE=docker:29-cli
ARG GH_VERSION=2.100.0

FROM ${DOCKER_CLI_IMAGE} AS docker-cli

FROM ${DEMO_IMAGE}
ARG GH_VERSION
USER root
ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/root

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    set -eux; \
    chmod 1777 /tmp; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl git openssh-client; \
    archive="gh_${GH_VERSION}_linux_amd64.tar.gz"; \
    base="https://github.com/cli/cli/releases/download/v${GH_VERSION}"; \
    curl -fsSL "$base/gh_${GH_VERSION}_checksums.txt" -o /tmp/gh-checksums; \
    curl -fsSL "$base/$archive" -o "/tmp/$archive"; \
    grep " $archive$" /tmp/gh-checksums | sed "s# $archive# /tmp/$archive#" | sha256sum -c -; \
    tar -xzf "/tmp/$archive" -C /tmp; \
    install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh-* /tmp/gh_${GH_VERSION}_linux_amd64

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --chmod=0755 .devcontainer/run-demo-sandbox.sh /usr/local/bin/run-demo-sandbox
COPY --chmod=0755 .devcontainer/start-demo-sandbox.sh /usr/local/bin/start-demo-sandbox
COPY --chmod=0755 .devcontainer/publish-demo.sh /usr/local/bin/publish-demo

WORKDIR /workspaces

RUN set -eux; \
    bun --version; \
    docker --version; \
    docker buildx version; \
    gh --version; \
    git --version; \
    curl --version >/dev/null
