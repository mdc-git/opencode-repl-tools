#!/usr/bin/env bash
set -euo pipefail

IMAGE=${1:?demo image is required}
NAME=${2:?container name is required}
PUBLISH=${3:?publish address is required}
RUNTIME_VOLUME=${4:?runtime volume is required}

container_id=$(docker container ls --all --quiet --filter "name=^/${NAME}$")
if [[ -n "$container_id" ]]; then
  docker rm --force "$container_id" >/dev/null
fi

docker run --detach \
  --name "$NAME" \
  --user 0:0 \
  --read-only \
  --cap-drop ALL \
  --cap-add CHOWN \
  --cap-add DAC_OVERRIDE \
  --cap-add SETGID \
  --cap-add SETPCAP \
  --cap-add SETUID \
  --cap-add SYS_ADMIN \
  --security-opt no-new-privileges:true \
  --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
  --cgroupns private \
  --pids-limit 128 \
  --memory 2g \
  --cpus 2 \
  --ulimit core=0:0 \
  --ulimit nofile=256:256 \
  --ulimit nproc=128:128 \
  --tmpfs /home/opencode-demo:rw,exec,nosuid,nodev,size=512m,uid=0,gid=0,mode=0700 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,uid=0,gid=0,mode=0700 \
  --mount "type=volume,source=$RUNTIME_VOLUME,target=/opt/opencode-runtime,readonly" \
  --network bridge \
  --publish "${PUBLISH}:7681" \
  --log-driver local \
  --log-opt max-size=10m \
  --log-opt max-file=2 \
  "$IMAGE"
