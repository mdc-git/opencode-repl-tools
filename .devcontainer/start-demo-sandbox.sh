#!/usr/bin/env bash
set -euo pipefail

IMAGE=ghcr.io/mdc-git/opencode-repl-tools-demo:demo
SANDBOX_NAME=opencode-repl-tools-demo-sandbox
PORT=7681
CACHE_DIR=$HOME/.cache
LOG=$CACHE_DIR/opencode-repl-tools-preview.log

mkdir -p "$CACHE_DIR"
: >"$LOG"

docker pull "$IMAGE" >>"$LOG" 2>&1

/usr/local/bin/run-demo-sandbox \
  "$IMAGE" \
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
