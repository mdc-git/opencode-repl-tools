#!/usr/bin/env bash
set -euo pipefail

IMAGE=ghcr.io/mdc-git/opencode-repl-tools-demo:demo
SANDBOX_NAME=opencode-repl-tools-demo-sandbox
PROXY_NAME=opencode-repl-tools-demo-proxy
PUBLIC_PORT=7681
HOST_PORT=17681
CACHE_DIR=$HOME/.cache
LOG=$CACHE_DIR/opencode-repl-tools-preview.log

mkdir -p "$CACHE_DIR"
: >"$LOG"

docker pull "$IMAGE" >>"$LOG" 2>&1

host_gateway=$(ip -4 route show default | awk 'NR == 1 { print $3 }')
/usr/local/bin/run-demo-sandbox \
  "$IMAGE" \
  "$SANDBOX_NAME" \
  "$host_gateway:$HOST_PORT" \
  >>"$LOG"

controller_image=$(docker inspect "$HOSTNAME" --format '{{.Image}}')
docker rm --force "$PROXY_NAME" >/dev/null 2>&1 || true

docker run --detach \
  --name "$PROXY_NAME" \
  --user 65534:65534 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --network "container:$HOSTNAME" \
  --entrypoint /usr/bin/socat \
  --log-driver local \
  --log-opt max-size=2m \
  --log-opt max-file=2 \
  "$controller_image" \
  "TCP-LISTEN:$PUBLIC_PORT,bind=0.0.0.0,reuseaddr,fork" \
  "TCP:$host_gateway:$HOST_PORT" \
  >>"$LOG"

for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$PUBLIC_PORT/" >/dev/null; then
    exit 0
  fi

  if [[ "$(docker inspect --format '{{.State.Running}}' "$SANDBOX_NAME" 2>/dev/null || true)" != true ]]; then
    docker logs "$SANDBOX_NAME" >>"$LOG" 2>&1 || true
    echo "demo sandbox exited before ttyd became ready" >>"$LOG"
    exit 1
  fi

  if [[ "$(docker inspect --format '{{.State.Running}}' "$PROXY_NAME" 2>/dev/null || true)" != true ]]; then
    docker logs "$PROXY_NAME" >>"$LOG" 2>&1 || true
    echo "demo proxy exited before port $PUBLIC_PORT became ready" >>"$LOG"
    exit 1
  fi

  sleep 0.1
done

docker logs "$SANDBOX_NAME" >>"$LOG" 2>&1 || true
docker logs "$PROXY_NAME" >>"$LOG" 2>&1 || true
echo "demo controller did not become ready on port $PUBLIC_PORT" >>"$LOG"
exit 1
