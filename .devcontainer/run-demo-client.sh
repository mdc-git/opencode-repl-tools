#!/usr/bin/env bash
set -euo pipefail

client_root="$(mktemp -d /tmp/opencode-client.XXXXXX)"
xdg="$client_root/xdg"

cleanup() {
  rm -rf "$client_root"
}
trap cleanup EXIT

umask 077
install -d -m 0700 \
  "$xdg/config/opencode" \
  "$xdg/data/opencode" \
  "$xdg/cache/opencode/repl-tools" \
  "$xdg/state/opencode" \
  "$xdg/npm"

ln -s /tmp/opencode-xdg/cache/opencode/repl-tools/python \
  "$xdg/cache/opencode/repl-tools/python"

export XDG_CONFIG_HOME="$xdg/config"
export OPENCODE_CONFIG_DIR="$xdg/config/opencode"
export XDG_DATA_HOME="$xdg/data"
export XDG_CACHE_HOME="$xdg/cache"
export XDG_STATE_HOME="$xdg/state"
export OPENCODE_DB="$xdg/data/opencode/opencode.db"
export NPM_CONFIG_CACHE="$xdg/npm"

if (( $# == 0 )); then
  set -- opencode2 --standalone /workspace
fi

"$@"
