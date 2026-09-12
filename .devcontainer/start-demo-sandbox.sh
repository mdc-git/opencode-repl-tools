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

tooling_root="$(mktemp -d "$CACHE_DIR/opencode-tooling.XXXXXX")"
build_context="$(mktemp -d "$CACHE_DIR/opencode-runtime.XXXXXX")"
cleanup() {
  status=$?
  trap - EXIT
  if (( status != 0 )); then
    cat "$LOG" >&2 || true
  fi
  rm -rf "$tooling_root" "$build_context"
  exit "$status"
}
trap cleanup EXIT

export BUN_INSTALL="$tooling_root/bun"
export PATH="$BUN_INSTALL/bin:/usr/local/bin:/usr/bin:/bin"

bun install --global --trust "@opencode/cli@beta" >>"$LOG" 2>&1
bootstrap="$(opencode2 --version 2>>"$LOG")"
echo "OpenCode bootstrap: $bootstrap" >>"$LOG"

second=
third=
for pass in 1 2 3; do
  if ! timeout 180s opencode2 update --method bun >>"$LOG" 2>&1; then
    echo "OpenCode update pass $pass failed or timed out" >>"$LOG"
    exit 1
  fi
  version="$(opencode2 --version 2>>"$LOG")"
  echo "OpenCode after update $pass: $version" >>"$LOG"
  case "$pass" in
    2) second="$version" ;;
    3) third="$version" ;;
  esac
done

test -n "$second"
test "$second" = "$third"
case "$third" in
  "opencode v2."*) ;;
  *)
    echo "updater did not converge on a stable V2 build: $third" >>"$LOG"
    exit 1
    ;;
esac

opencode_path="$(readlink -f "$(command -v opencode2)")"
test -x "$opencode_path"
install -m 0755 "$opencode_path" "$build_context/opencode2"
cat >"$build_context/Dockerfile" <<'EOF'
# syntax=docker/dockerfile:1.7
ARG DEMO_IMAGE
FROM ${DEMO_IMAGE}
COPY --chmod=0755 opencode2 /opt/opencode/bin/opencode2
EOF

docker build \
  --build-arg "DEMO_IMAGE=$IMAGE" \
  --tag "$RUNTIME_IMAGE" \
  "$build_context" \
  >>"$LOG" 2>&1

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
test "$runtime_version" = "$third"

rm -rf "$tooling_root" "$build_context"
tooling_root=
build_context=
trap - EXIT

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
