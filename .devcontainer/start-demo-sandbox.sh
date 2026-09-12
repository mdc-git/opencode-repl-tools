#!/usr/bin/env bash
set -euo pipefail

IMAGE=ghcr.io/mdc-git/opencode-repl-tools-demo:demo
RUNTIME_IMAGE=opencode-repl-tools-demo:runtime
SANDBOX_NAME=opencode-repl-tools-demo-sandbox
PORT=7681
CACHE_DIR=$HOME/.cache
LOG=$CACHE_DIR/opencode-repl-tools-preview.log
UPDATE_API=https://opencode.ai/update/api/beta/cli/npm
INSTALLER_URL=https://opencode.ai/v2/install

mkdir -p "$CACHE_DIR"
: >"$LOG"

docker pull "$IMAGE" >>"$LOG" 2>&1
base_id="$(docker image inspect --format '{{.Id}}' "$IMAGE")"

fetch_latest_version() {
  local metadata version
  metadata="$(curl -fsSL "$UPDATE_API")"
  version="$(printf '%s' "$metadata" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
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

for attempt in 1 2 3; do
  latest_version="$(fetch_latest_version)"
  echo "latest OpenCode v2: $latest_version" >>"$LOG"

  cached_runtime_version="$(docker image inspect --format '{{index .Config.Labels "io.opencode.version"}}' "$RUNTIME_IMAGE" 2>/dev/null || true)"
  cached_runtime_base="$(docker image inspect --format '{{index .Config.Labels "io.opencode.base"}}' "$RUNTIME_IMAGE" 2>/dev/null || true)"

  if [[ "$cached_runtime_version" != "$latest_version" || "$cached_runtime_base" != "$base_id" ]]; then
    binary="$CACHE_DIR/opencode-$latest_version"
    if [[ ! -x "$binary" ]]; then
      install_home="$(mktemp -d "$CACHE_DIR/opencode-install.XXXXXX")"
      if ! curl -fsSL "$INSTALLER_URL" \
        | HOME="$install_home" VERSION="$latest_version" bash -s -- --no-modify-path \
          >>"$LOG" 2>&1; then
        rm -rf "$install_home"
        cat "$LOG" >&2
        exit 1
      fi
      install -m 0755 "$install_home/.opencode/bin/opencode" "$binary"
      rm -rf "$install_home"
    fi

    build_context="$(mktemp -d "$CACHE_DIR/opencode-runtime.XXXXXX")"
    trap 'status=$?; if (( status != 0 )); then cat "$LOG" >&2 || true; fi; rm -rf "${build_context:-}"; exit "$status"' EXIT
    install -m 0755 "$binary" "$build_context/opencode2"

    cat >"$build_context/Dockerfile" <<'EOF'
# syntax=docker/dockerfile:1.7
ARG DEMO_IMAGE
FROM ${DEMO_IMAGE}
ARG OPENCODE_VERSION
ARG OPENCODE_BASE
LABEL io.opencode.version="$OPENCODE_VERSION" \
      io.opencode.base="$OPENCODE_BASE"
COPY --chmod=0755 opencode2 /opt/opencode/bin/opencode2
EOF

    docker build \
      --build-arg "DEMO_IMAGE=$IMAGE" \
      --build-arg "OPENCODE_VERSION=$latest_version" \
      --build-arg "OPENCODE_BASE=$base_id" \
      --tag "$RUNTIME_IMAGE" \
      "$build_context" \
      >>"$LOG" 2>&1

    rm -rf "$build_context"
    build_context=
    trap - EXIT
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
    break
  fi

  echo "OpenCode v2 advanced during startup: $installed_version -> $confirmed_latest; refreshing" >>"$LOG"
  if (( attempt == 3 )); then
    echo "OpenCode v2 changed repeatedly during startup" >>"$LOG"
    cat "$LOG" >&2
    exit 1
  fi
done

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
