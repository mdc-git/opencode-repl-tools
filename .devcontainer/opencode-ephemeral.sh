#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
  echo 'opencode-ephemeral must run from the trusted container supervisor' >&2
  exit 1
fi

workspace="$(readlink -f "${1:?workspace is required}")"
shift
test -x /opt/opencode-runtime/bin/opencode2
python_cache=/opt/opencode-repl-cache/opencode/repl-tools/python
sandbox_workspace=/workspace
state_root="$(mktemp -d /tmp/opencode-ephemeral.XXXXXX)"

cleanup() {
  rm -rf "$state_root"
}
trap cleanup EXIT

install -d -o 1001 -g 1001 -m 0700 \
  "$state_root/home" \
  "$state_root/home/.config/opencode" \
  "$state_root/home/.local/share/opencode/log" \
  "$state_root/home/.local/state/opencode" \
  "$state_root/home/.cache/opencode" \
  "$state_root/run-user" \
  "$state_root/xdg" \
  "$state_root/xdg/bin" \
  "$state_root/xdg/config/opencode" \
  "$state_root/xdg/data/opencode" \
  "$state_root/xdg/cache/opencode/repl-tools" \
  "$state_root/xdg/state/opencode" \
  "$state_root/xdg/npm"

system_mounts=()
for path in /etc/alternatives /etc/ld.so.cache /etc/ld.so.conf /etc/ld.so.conf.d \
  /etc/nsswitch.conf /etc/hosts /etc/resolv.conf /etc/passwd /etc/group \
  /etc/localtime /etc/machine-id /etc/ssl/certs /etc/fonts /etc/alsa \
  /etc/asound.conf /etc/vulkan /etc/OpenCL/vendors /etc/glvnd /etc/nvidia; do
  if [[ -e "$path" ]]; then
    system_mounts+=(--ro-bind "$path" "$path")
  fi
done

if (( $# == 0 )); then
  set -- opencode2 --standalone "$sandbox_workspace"
fi

set +e
bwrap \
  --die-with-parent \
  --unshare-ipc \
  --unshare-pid \
  --unshare-uts \
  --unshare-cgroup-try \
  --tmpfs / \
  --ro-bind /usr /usr \
  --ro-bind /opt /opt \
  --symlink usr/bin /bin \
  --symlink usr/sbin /sbin \
  --symlink usr/lib /lib \
  --symlink usr/lib64 /lib64 \
  "${system_mounts[@]}" \
  --ro-bind /sys /sys \
  --perms 1777 \
  --tmpfs /tmp \
  --dir /run \
  --dir /run/user \
  --bind "$state_root/run-user" /run/user/1001 \
  --bind "$state_root/home" /home/opencode-demo \
  --bind "$state_root/xdg" /tmp/opencode-xdg \
  --symlink /opt/opencode-runtime/bin/opencode2 /tmp/opencode-xdg/bin/opencode \
  --ro-bind "$python_cache" /tmp/opencode-xdg/cache/opencode/repl-tools/python \
  --bind "$workspace" "$sandbox_workspace" \
  --dev-bind /dev /dev \
  --proc /proc \
  --cap-add CAP_SETGID \
  --cap-add CAP_SETPCAP \
  --cap-add CAP_SETUID \
  --clearenv \
  --setenv HOME /home/opencode-demo \
  --setenv USER opencode-demo \
  --setenv LOGNAME opencode-demo \
  --setenv SHELL /bin/bash \
  --setenv TERM "${TERM:-xterm-256color}" \
  --setenv LANG C.UTF-8 \
  --setenv TMPDIR /tmp \
  --setenv XDG_RUNTIME_DIR /run/user/1001 \
  --setenv XDG_CONFIG_HOME /tmp/opencode-xdg/config \
  --setenv OPENCODE_CONFIG_DIR /tmp/opencode-xdg/config/opencode \
  --setenv XDG_DATA_HOME /tmp/opencode-xdg/data \
  --setenv XDG_CACHE_HOME /tmp/opencode-xdg/cache \
  --setenv XDG_STATE_HOME /tmp/opencode-xdg/state \
  --setenv OPENCODE_DB /tmp/opencode-xdg/data/opencode/opencode.db \
  --setenv NPM_CONFIG_CACHE /tmp/opencode-xdg/npm \
  --setenv OPENCODE_REPL_NODE /usr/local/bin/node \
  --setenv OPENCODE_REPL_PYTHON /usr/bin/python3 \
  --setenv PATH /opt/opencode-runtime/bin:/tmp/opencode-xdg/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  --chdir "$sandbox_workspace" \
  -- /usr/bin/setpriv \
    --reuid=1001 \
    --regid=1001 \
    --clear-groups \
    --bounding-set=-all \
    --inh-caps=-all \
    --ambient-caps=-all \
    --no-new-privs \
    -- "$@"
status=$?
set -e

if (( status != 0 )); then
  echo "sandbox command exited with status $status" >&2
  for log_root in \
    "$state_root/home/.local/share/opencode/log" \
    "$state_root/xdg/data/opencode/log"; do
    if [[ -d "$log_root" ]]; then
      while IFS= read -r -d '' log_file; do
        printf '%s\n' "--- $log_file ---" >&2
        cat "$log_file" >&2 || true
      done < <(find "$log_root" -type f -print0)
    fi
  done
fi

exit "$status"
