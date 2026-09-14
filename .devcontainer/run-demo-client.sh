#!/usr/bin/env bash
set -euo pipefail

client_root="$(mktemp -d /tmp/opencode-client.XXXXXX)"
home="$client_root/home"
workspace="$client_root/workspace"
xdg="$client_root/xdg"
tmp="$client_root/tmp"

cleanup() {
  rm -rf "$client_root"
}
trap cleanup EXIT

umask 077
install -d -m 0700 \
  "$home" \
  "$workspace" \
  "$tmp" \
  "$xdg/config/opencode" \
  "$xdg/data/opencode" \
  "$xdg/cache/opencode/repl-tools" \
  "$xdg/state/opencode" \
  "$xdg/npm"

cp -a --no-preserve=ownership /opt/opencode-demo/source/. "$workspace/"
chmod -R u+rwX,go-rwx "$workspace"
ln -s /opt/opencode-repl-tools/node_modules "$workspace/node_modules"
ln -s /tmp/opencode-xdg/cache/opencode/repl-tools/python \
  "$xdg/cache/opencode/repl-tools/python"

export HOME="$home"
export TMPDIR="$tmp"
export XDG_CONFIG_HOME="$xdg/config"
export OPENCODE_CONFIG_DIR="$xdg/config/opencode"
export XDG_DATA_HOME="$xdg/data"
export XDG_CACHE_HOME="$xdg/cache"
export XDG_STATE_HOME="$xdg/state"
export OPENCODE_DB="$xdg/data/opencode/opencode.db"
export NPM_CONFIG_CACHE="$xdg/npm"

cd "$workspace"
if (( $# == 0 )); then
  set -- opencode2 --standalone "$workspace"
fi

"$@"
