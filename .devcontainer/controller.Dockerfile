FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl iproute2 socat \
    && rm -rf /var/lib/apt/lists/*

COPY --chmod=0755 .devcontainer/run-demo-sandbox.sh /usr/local/bin/run-demo-sandbox
COPY --chmod=0755 .devcontainer/start-demo-sandbox.sh /usr/local/bin/start-demo-sandbox
COPY --chmod=0755 .devcontainer/publish-demo.sh /usr/local/bin/publish-demo
