#!/usr/bin/env bash
set -euo pipefail

IMAGE=ghcr.io/mdc-git/opencode-repl-tools-demo:demo
RUNTIME_IMAGE=opencode-repl-tools-demo:runtime
SANDBOX_NAME=opencode-repl-tools-demo-sandbox
PORT=7681
CACHE_DIR=$HOME/.cache
LOG=$CACHE_DIR/opencode-repl-tools-preview.log

mkdir -p "$CACHE_DIR"
: >"$LOG"

docker pull "$IMAGE" >>"$LOG" 2>&1

build_context="$(mktemp -d "$CACHE_DIR/opencode-runtime.XXXXXX")"
cleanup_build() {
  status=$?
  if (( status != 0 )); then
    cat "$LOG" >&2 || true
  fi
  rm -rf "$build_context"
  exit "$status"
}
trap cleanup_build EXIT

cat >"$build_context/Dockerfile" <<'EOF'
# syntax=docker/dockerfile:1.7
ARG DEMO_IMAGE
ARG BUN_IMAGE=oven/bun:1

FROM ${BUN_IMAGE} AS opencode-tooling
ARG OPENCODE_UPDATE_CACHE_KEY
USER root
ENV BUN_INSTALL=/opt/opencode-install \
    PATH=/opt/opencode-install/bin:/usr/local/bin:/usr/bin:/bin \
    HOME=/root
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
    opencode_path="$(readlink -f "$(command -v opencode2)")"; \
    test -x "$opencode_path"; \
    install -D -m 0755 "$opencode_path" /opt/opencode/bin/opencode2; \
    /opt/opencode/bin/opencode2 --version

FROM ${DEMO_IMAGE}
COPY --from=opencode-tooling /opt/opencode/bin/opencode2 /opt/opencode/bin/opencode2
EOF

update_cache_key="$(date +%s%N)"
docker build \
  --build-arg "DEMO_IMAGE=$IMAGE" \
  --build-arg "OPENCODE_UPDATE_CACHE_KEY=$update_cache_key" \
  --tag "$RUNTIME_IMAGE" \
  "$build_context" \
  >>"$LOG" 2>&1

rm -rf "$build_context"
trap - EXIT

runtime_version="$(
  docker run --rm \
    --read-only \
    --tmpfs /home/opencode-demo:rw,exec,nosuid,nodev,size=512m,uid=1001,gid=1001,mode=0700 \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,uid=1001,gid=1001,mode=0700 \
    --entrypoint /opt/opencode/bin/opencode2 \
    "$RUNTIME_IMAGE" \
    --version \
    2>>"$LOG"
)"
echo "runtime OpenCode: $runtime_version" >>"$LOG"
case "$runtime_version" in
  "opencode v2."*) ;;
  *)
    echo "runtime OpenCode is not a stable V2 build: $runtime_version" >>"$LOG"
    cat "$LOG" >&2
    exit 1
    ;;
esac

/usr/local/bin/run-demo-sandbox \
  "$RUNTIME_IMAGE" \
  "$SANDBOX_NAME" \
  "127.0.0.1:$PORT" \
  >>"$LOG"

for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$PORT/" >/dev/null; then
    exit 0
  fi

  if [[ "$(docker inspect --format '{{.State.Running}}' "$SANDBOX_NAME" 2>/dev/null || true)" != true ]]; then
    docker logs "$SANDBOX_NAME" >>"$LOG" 2>&1 || true
    echo "demo sandbox exited before ttyd became ready" >>"$LOG"
    cat "$LOG" >&2
    exit 1
  fi

  sleep 0.1
done

docker logs "$SANDBOX_NAME" >>"$LOG" 2>&1 || true
echo "demo sandbox did not become ready on port $PORT" >>"$LOG"
cat "$LOG" >&2
exit 1
