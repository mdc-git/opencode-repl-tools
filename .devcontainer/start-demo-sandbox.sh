#!/usr/bin/env bash
set -euo pipefail

IMAGE=ghcr.io/mdc-git/opencode-repl-tools-demo:demo
RUNTIME_IMAGE=opencode-repl-tools-demo:runtime
SANDBOX_NAME=opencode-repl-tools-demo-sandbox
PORT=7681
CACHE_DIR=$HOME/.cache
LOG=$CACHE_DIR/opencode-repl-tools-preview.log
VERSION_API=https://api.github.com/repos/anomalyco/opencode/git/matching-refs/tags/v2.

mkdir -p "$CACHE_DIR"
: >"$LOG"

build_context=
cleanup() {
  status=$?
  if [[ -n "$build_context" ]]; then
    rm -rf "$build_context"
  fi
  if (( status != 0 )); then
    cat "$LOG" >&2 || true
  fi
  exit "$status"
}
trap cleanup EXIT

docker pull "$IMAGE" >>"$LOG" 2>&1
base_id="$(docker image inspect --format '{{.Id}}' "$IMAGE")"

fetch_latest_version() {
  local refs version
  refs="$(curl -fsSL "$VERSION_API")"
  version="$(printf '%s' "$refs" \
    | grep -oE '"ref"[[:space:]]*:[[:space:]]*"refs/tags/v2\.[0-9]+\.[0-9]+"' \
    | sed -E 's/.*v([0-9]+\.[0-9]+\.[0-9]+)"/\1/' \
    | sort -V \
    | tail -n 1)"
  test -n "$version"
  printf '%s\n' "$version"
}

runtime_version() {
  docker run --rm \
    --read-only \
    --tmpfs /home/opencode-demo:rw,exec,nosuid,nodev,size=512m,uid=1001,gid=1001,mode=0700 \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,uid=1001,gid=1001,mode=0700 \
    --entrypoint /opt/opencode/bin/opencode2 \
    "$RUNTIME_IMAGE" \
    --version \
    2>>"$LOG" \
    | awk '{print $NF}' \
    | sed 's/^v//'
}

runtime_ready=false
for attempt in 1 2 3; do
  latest_version="$(fetch_latest_version)"
  opencode_image="ghcr.io/anomalyco/opencode:$latest_version"
  echo "latest OpenCode v2: $latest_version" >>"$LOG"

  cached_runtime_version="$(docker image inspect --format '{{index .Config.Labels "io.opencode.version"}}' "$RUNTIME_IMAGE" 2>/dev/null || true)"
  cached_runtime_base="$(docker image inspect --format '{{index .Config.Labels "io.opencode.base"}}' "$RUNTIME_IMAGE" 2>/dev/null || true)"

  if [[ "$cached_runtime_version" != "$latest_version" || "$cached_runtime_base" != "$base_id" ]]; then
    build_context="$(mktemp -d "$CACHE_DIR/opencode-runtime.XXXXXX")"
    cat >"$build_context/Dockerfile" <<'EOF'
# syntax=docker/dockerfile:1.7
ARG DEMO_IMAGE
ARG OPENCODE_IMAGE
FROM ${OPENCODE_IMAGE} AS opencode-release
RUN /usr/local/bin/opencode --version

FROM ${DEMO_IMAGE}
ARG OPENCODE_VERSION
ARG OPENCODE_BASE
LABEL io.opencode.version="$OPENCODE_VERSION" \
      io.opencode.base="$OPENCODE_BASE"
COPY --from=opencode-release /usr/local/bin/opencode /opt/opencode/bin/opencode2
EOF

    if ! docker build \
      --build-arg "DEMO_IMAGE=$IMAGE" \
      --build-arg "OPENCODE_IMAGE=$opencode_image" \
      --build-arg "OPENCODE_VERSION=$latest_version" \
      --build-arg "OPENCODE_BASE=$base_id" \
      --tag "$RUNTIME_IMAGE" \
      "$build_context" \
      >>"$LOG" 2>&1; then
      echo "failed to build runtime from $opencode_image" >>"$LOG"
      if (( attempt == 3 )); then
        exit 1
      fi
      rm -rf "$build_context"
      build_context=
      sleep 1
      continue
    fi

    rm -rf "$build_context"
    build_context=
  fi

  installed_version="$(runtime_version)"
  echo "runtime OpenCode v2: $installed_version" >>"$LOG"
  if [[ "$installed_version" != "$latest_version" ]]; then
    echo "runtime OpenCode version mismatch: expected $latest_version, got $installed_version" >>"$LOG"
    docker image rm --force "$RUNTIME_IMAGE" >>"$LOG" 2>&1 || true
    continue
  fi

  confirmed_latest="$(fetch_latest_version)"
  if [[ "$installed_version" == "$confirmed_latest" ]]; then
    runtime_ready=true
    break
  fi

  echo "OpenCode v2 advanced during startup: $installed_version -> $confirmed_latest; refreshing" >>"$LOG"
  docker image rm --force "$RUNTIME_IMAGE" >>"$LOG" 2>&1 || true
  if (( attempt < 3 )); then
    continue
  fi
done

if [[ "$runtime_ready" != true ]]; then
  echo "could not prepare the latest OpenCode v2 runtime" >>"$LOG"
  exit 1
fi

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
    exit 1
  fi

  sleep 0.1
done

docker logs "$SANDBOX_NAME" >>"$LOG" 2>&1 || true
echo "demo sandbox did not become ready on port $PORT" >>"$LOG"
exit 1
