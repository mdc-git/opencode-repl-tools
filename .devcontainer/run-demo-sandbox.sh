#!/usr/bin/env bash
set -euo pipefail

IMAGE=${1:?demo image is required}
NAME=${2:?container name is required}
PUBLISH=${3:?publish address is required}

docker rm --force "$NAME" >/dev/null 2>&1 || true

docker run --detach \
  --name "$NAME" \
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
  --tmpfs /home/opencode-demo:rw,exec,nosuid,nodev,size=512m,uid=1001,gid=1001,mode=0700 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,uid=1001,gid=1001,mode=0700 \
  --network bridge \
  --publish "${PUBLISH}:7681" \
  --log-driver local \
  --log-opt max-size=10m \
  --log-opt max-file=2 \
  "$IMAGE"
