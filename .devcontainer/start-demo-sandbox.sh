#!/usr/bin/env bash
set -euo pipefail

IMAGE=ghcr.io/mdc-git/opencode-repl-tools-demo:demo
NAME=opencode-repl-tools-demo-sandbox
PUBLIC_PORT=7681
HOST_PORT=17681
CACHE_DIR=$HOME/.cache
LOG=$CACHE_DIR/opencode-repl-tools-preview.log

mkdir -p "$CACHE_DIR"
: >"$LOG"

docker pull "$IMAGE" >>"$LOG" 2>&1

host_gateway=$(ip -4 route show default | awk 'NR == 1 { print $3 }')
/usr/local/bin/run-demo-sandbox "$IMAGE" "$NAME" "$host_gateway:$HOST_PORT" >>"$LOG"

exec socat \
  "TCP-LISTEN:$PUBLIC_PORT,bind=0.0.0.0,reuseaddr,fork" \
  "TCP:$host_gateway:$HOST_PORT" \
  >>"$LOG" 2>&1
