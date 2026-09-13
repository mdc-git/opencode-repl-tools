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

docker inspect --format \
  'demo security config: user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}} privileged={{.HostConfig.Privileged}} pids={{.HostConfig.PidsLimit}} memory={{.HostConfig.Memory}} nanocpus={{.HostConfig.NanoCpus}} network={{.HostConfig.NetworkMode}} cgroupns={{.HostConfig.CgroupnsMode}} binds={{json .HostConfig.Binds}} capdrop={{json .HostConfig.CapDrop}} capadd={{json .HostConfig.CapAdd}} security={{json .HostConfig.SecurityOpt}}' \
  "$NAME" >&2
docker inspect --format \
  'demo runtime mount: name={{range .Mounts}}{{if eq .Destination "/opt/opencode-runtime"}}{{.Name}}{{end}}{{end}} rw={{range .Mounts}}{{if eq .Destination "/opt/opencode-runtime"}}{{.RW}}{{end}}{{end}}' \
  "$NAME" >&2

for _ in $(seq 1 100); do
  if ttyd_status="$(docker exec "$NAME" sh -ceu '
    for proc in /proc/[0-9]*; do
      if [ "$(cat "$proc/comm" 2>/dev/null || true)" != ttyd ]; then
        continue
      fi
      grep -E "^(Name|Uid|NoNewPrivs|CapInh|CapPrm|CapEff|CapBnd|CapAmb):" "$proc/status"
      exit 0
    done
    exit 1
  ' 2>/dev/null)"; then
    printf '%s\n' 'demo ttyd security status:' "$ttyd_status" >&2
    break
  fi
  if ! docker inspect --format '{{.State.Running}}' "$NAME" | grep -qx true; then
    break
  fi
  sleep 0.1
done
