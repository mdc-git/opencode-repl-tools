#!/usr/bin/env bash
set -euo pipefail

DEMO_HOME=/home/opencode-demo
SESSION_ROOT=$DEMO_HOME/session
SESSION_HOME=$SESSION_ROOT/home
WORKSPACE=$SESSION_HOME/workspace
DEMO_SOURCE=/opt/opencode-demo/source
OPENCODE_RUNTIME=/opt/opencode-runtime

umask 077

exec 9>"$DEMO_HOME/.session.lock"
if ! flock -n 9; then
  echo 'A previous demo session is still shutting down. Reconnect in a moment.' >&2
  exit 1
fi

rm -rf "$SESSION_ROOT"
install -d -m 0700 "$SESSION_HOME" "$WORKSPACE"
cp -a "$DEMO_SOURCE/." "$WORKSPACE/"
chmod -R u+rwX,go-rwx "$WORKSPACE"
ln -s /opt/opencode-repl-tools/node_modules "$WORKSPACE/node_modules"

exec env -i \
  HOME="$SESSION_HOME" \
  USER=opencode-demo \
  LOGNAME=opencode-demo \
  SHELL=/bin/bash \
  LANG=C.UTF-8 \
  PATH="$OPENCODE_RUNTIME/bin:/usr/local/bin:/usr/bin:/bin" \
  /usr/local/bin/opencode-ephemeral "$WORKSPACE"
