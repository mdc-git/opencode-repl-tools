# syntax=docker/dockerfile:1.7

ARG DOCKER_CLI_IMAGE=docker:29-cli

FROM ${DOCKER_CLI_IMAGE} AS docker-cli

FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gh git openssh-client; \
    docker_cli_target=/usr/local/bin/docker; \
    test ! -e "$docker_cli_target"

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --chmod=0755 .devcontainer/run-demo-sandbox.sh /usr/local/bin/run-demo-sandbox
COPY --chmod=0755 .devcontainer/start-demo-sandbox.sh /usr/local/bin/start-demo-sandbox
COPY --chmod=0755 .devcontainer/publish-demo.sh /usr/local/bin/publish-demo

RUN set -eux; \
    docker --version; \
    gh --version; \
    git --version; \
    curl --version >/dev/null
