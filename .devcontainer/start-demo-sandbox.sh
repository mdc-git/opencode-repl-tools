#!/usr/bin/env bash
set -euo pipefail

IMAGE=ghcr.io/mdc-git/opencode-repl-tools-demo:demo
RUNTIME_VOLUME=opencode-repl-tools-demo-runtime
UPDATER_NAME=opencode-repl-tools-demo-updater
SANDBOX_NAME=opencode-repl-tools-demo-sandbox
PORT=7681
CACHE_DIR=$HOME/.cache
LOG=$CACHE_DIR/opencode-repl-tools-preview.log

mkdir -p "$CACHE_DIR"
: >"$LOG"

cleanup() {
  status=$?
  trap - EXIT
  docker rm --force "$UPDATER_NAME" >/dev/null 2>&1 || true
  if (( status != 0 )); then
    cat "$LOG" >&2 || true
  fi
  exit "$status"
}
trap cleanup EXIT

echo 'Preparing OpenCode demo image...' >&2
timeout --kill-after=5s 120s docker pull "$IMAGE" >>"$LOG" 2>&1

docker rm --force "$UPDATER_NAME" >/dev/null 2>&1 || true
docker rm --force "$SANDBOX_NAME" >/dev/null 2>&1 || true
docker volume rm --force "$RUNTIME_VOLUME" >/dev/null 2>&1 || true
docker volume create "$RUNTIME_VOLUME" >/dev/null

echo 'Updating OpenCode runtime...' >&2
timeout --kill-after=5s 120s docker run --rm \
  --name "$UPDATER_NAME" \
  --user 1001:1001 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --cgroupns private \
  --pids-limit 128 \
  --memory 2g \
  --cpus 2 \
  --ulimit core=0:0 \
  --ulimit nofile=256:256 \
  --ulimit nproc=128:128 \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=256m,uid=1001,gid=1001,mode=0700 \
  --mount "type=volume,source=$RUNTIME_VOLUME,target=/opt/opencode-runtime" \
  --network bridge \
  --entrypoint /usr/bin/env \
  "$IMAGE" \
  -i \
  HOME=/tmp/home \
  BUN_INSTALL=/opt/opencode-runtime \
  BUN_INSTALL_GLOBAL_DIR=/opt/opencode-runtime/install/global \
  BUN_INSTALL_BIN=/opt/opencode-runtime/bin \
  PATH=/opt/opencode-runtime/bin:/usr/local/bin:/usr/bin:/bin \
  /bin/bash -ceu '
    mkdir -p "$HOME"
    test -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}${GITHUB_CODESPACE_TOKEN:-}"

    before="$(opencode2 --version)"
    printf "OpenCode before update: %s\n" "$before"

    set +e
    update_output="$(opencode2 update --method bun 2>&1)"
    update_status=$?
    set -e

    printf "%s\n" "$update_output"
    if (( update_status != 0 )); then
      exit "$update_status"
    fi
    if grep -Fq "Upgrade failed" <<<"$update_output"; then
      exit 1
    fi

    after="$(opencode2 --version)"
    printf "OpenCode after update: %s\n" "$after"
    case "$after" in
      "opencode v2."*) ;;
      *) exit 1 ;;
    esac

    opencode_path="$(readlink -f "$(command -v opencode2)")"
    test -x "$opencode_path"
    case "$opencode_path" in
      /opt/opencode-runtime/*) ;;
      *) exit 1 ;;
    esac
  ' >>"$LOG" 2>&1

echo 'Starting public OpenCode sandbox...' >&2
/usr/local/bin/run-demo-sandbox \
  "$IMAGE" \
  "$SANDBOX_NAME" \
  "127.0.0.1:$PORT" \
  "$RUNTIME_VOLUME" \
  >>"$LOG"

for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$PORT/" >/dev/null; then
    trap - EXIT
    echo 'OpenCode demo is ready.' >&2
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
