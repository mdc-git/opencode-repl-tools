#!/usr/bin/env bash
set -euo pipefail

IMAGE=ghcr.io/mdc-git/opencode-repl-tools-demo:demo
NAME=opencode-repl-tools-demo-sandbox
PUBLIC_PORT=7681
HOST_PORT=17681
CACHE_DIR=$HOME/.cache
LOG=$CACHE_DIR/opencode-repl-tools-preview.log
PROXY_PID=$CACHE_DIR/opencode-repl-tools-proxy.pid

mkdir -p "$CACHE_DIR"
: >"$LOG"

if [[ -f "$PROXY_PID" ]]; then
  proxy_pid=$(cat "$PROXY_PID")
  if [[ -r "/proc/$proxy_pid/cmdline" ]] \
    && tr '\0' ' ' <"/proc/$proxy_pid/cmdline" | grep -Fq "socat TCP-LISTEN:$PUBLIC_PORT"; then
    kill "$proxy_pid" >/dev/null 2>&1 || true
  fi
  rm -f "$PROXY_PID"
fi

docker pull "$IMAGE" >>"$LOG" 2>&1

host_gateway=$(ip -4 route show default | awk 'NR == 1 { print $3 }')
/usr/local/bin/run-demo-sandbox "$IMAGE" "$NAME" "$host_gateway:$HOST_PORT" >>"$LOG"

nohup socat \
  "TCP-LISTEN:$PUBLIC_PORT,bind=0.0.0.0,reuseaddr,fork" \
  "TCP:$host_gateway:$HOST_PORT" \
  </dev/null >>"$LOG" 2>&1 &
echo "$!" >"$PROXY_PID"

for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$PUBLIC_PORT/" >/dev/null; then
    exit 0
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "$NAME" 2>/dev/null || true)" != true ]]; then
    docker logs "$NAME" >>"$LOG" 2>&1 || true
    echo "demo sandbox exited before ttyd became ready" >>"$LOG"
    exit 1
  fi
  sleep 0.1
done

docker logs "$NAME" >>"$LOG" 2>&1 || true
echo "demo sandbox did not become ready" >>"$LOG"
exit 1
