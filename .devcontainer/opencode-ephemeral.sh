#!/usr/bin/env bash
set -euo pipefail

workspace="$(readlink -f "${1:?workspace is required}")"
shift
opencode_bin="$(readlink -f "$(command -v opencode2)")"
python_cache=/opt/opencode-repl-cache/opencode/repl-tools/python

system_mounts=()
for path in /etc/alternatives /etc/ld.so.cache /etc/ld.so.conf /etc/ld.so.conf.d \
  /etc/nsswitch.conf /etc/hosts /etc/resolv.conf /etc/passwd /etc/group \
  /etc/localtime /etc/machine-id /etc/ssl/certs /etc/fonts /etc/alsa \
  /etc/asound.conf /etc/vulkan /etc/OpenCL/vendors /etc/glvnd /etc/nvidia; do
  if [[ -e "$path" ]]; then
    system_mounts+=(--ro-bind "$path" "$path")
  fi
done

bwrap \
  --die-with-parent \
  --unshare-user \
  --disable-userns \
  --tmpfs / \
  --ro-bind /usr /usr \
  --ro-bind /opt /opt \
  --symlink usr/bin /bin \
  --symlink usr/sbin /sbin \
  --symlink usr/lib /lib \
  --symlink usr/lib64 /lib64 \
  "${system_mounts[@]}" \
  --ro-bind /sys /sys \
  --ro-bind /proc /proc \
  --perms 0700 \
  --dir "$HOME" \
  --dir /run/user \
  --tmpfs /tmp \
  --perms 0700 \
  --dir /tmp/opencode-xdg \
  --dir /tmp/opencode-xdg/bin \
  --ro-bind "$opencode_bin" /tmp/opencode-xdg/bin/opencode2 \
  --symlink opencode2 /tmp/opencode-xdg/bin/opencode \
  --dir /tmp/opencode-xdg/config/opencode \
  --dir /tmp/opencode-xdg/data/opencode \
  --dir /tmp/opencode-xdg/cache/opencode/repl-tools \
  --ro-bind "$python_cache" /tmp/opencode-xdg/cache/opencode/repl-tools/python \
  --dir /tmp/opencode-xdg/state \
  --dir /tmp/opencode-xdg/npm \
  --dir "$workspace" \
  --bind "$workspace" "$workspace" \
  --dev /dev \
  --clearenv \
  --setenv HOME "$HOME" \
  --setenv USER "${USER:-opencode-demo}" \
  --setenv LOGNAME "${LOGNAME:-opencode-demo}" \
  --setenv SHELL /bin/bash \
  --setenv TERM "${TERM:-xterm-256color}" \
  --setenv LANG C.UTF-8 \
  --setenv TMPDIR /tmp \
  --setenv XDG_CONFIG_HOME /tmp/opencode-xdg/config \
  --setenv OPENCODE_CONFIG_DIR /tmp/opencode-xdg/config/opencode \
  --setenv XDG_DATA_HOME /tmp/opencode-xdg/data \
  --setenv XDG_CACHE_HOME /tmp/opencode-xdg/cache \
  --setenv XDG_STATE_HOME /tmp/opencode-xdg/state \
  --setenv OPENCODE_DB /tmp/opencode-xdg/data/opencode/opencode.db \
  --setenv NPM_CONFIG_CACHE /tmp/opencode-xdg/npm \
  --setenv OPENCODE_REPL_NODE /usr/local/bin/node \
  --setenv OPENCODE_REPL_PYTHON /usr/bin/python3 \
  --setenv PATH /tmp/opencode-xdg/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  --chdir "$workspace" \
  -- opencode2 --standalone "$workspace" "$@"
