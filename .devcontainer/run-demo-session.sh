#!/usr/bin/env bash
set -euo pipefail

DEMO_HOME=/home/opencode-demo
SESSION_ROOT=$DEMO_HOME/session
SESSION_HOME=$SESSION_ROOT/home
WORKSPACE=$SESSION_HOME/workspace
TMPDIR=$SESSION_HOME/tmp
DEMO_SOURCE=/opt/opencode-demo/source
PYTHON_CACHE=/opt/opencode-repl-cache/opencode/repl-tools/python

exec 9>"$DEMO_HOME/.session.lock"
if ! flock -n 9; then
  echo 'A previous demo session is still shutting down. Reconnect in a moment.' >&2
  exit 1
fi

rm -rf "$SESSION_ROOT"
install -d -m 0700 "$SESSION_HOME" "$TMPDIR"
install -d -m 0755 "$WORKSPACE"
cp -a "$DEMO_SOURCE/." "$WORKSPACE/"
chmod -R u+rwX "$WORKSPACE"
ln -s /opt/opencode-repl-tools/node_modules "$WORKSPACE/node_modules"

install -d -m 0755 "$SESSION_HOME/.cache/opencode/repl-tools"
ln -s "$PYTHON_CACHE" "$SESSION_HOME/.cache/opencode/repl-tools/python"

cd "$WORKSPACE"
exec env -i \
  HOME="$SESSION_HOME" \
  TMPDIR="$TMPDIR" \
  USER=opencode-demo \
  LOGNAME=opencode-demo \
  SHELL=/bin/bash \
  LANG=C.UTF-8 \
  PATH=/usr/local/bin:/usr/bin:/bin \
  OPENCODE_REPL_NODE=/usr/local/bin/node \
  OPENCODE_REPL_PYTHON=/usr/bin/python3 \
  /opt/opencode/bin/opencode2 --standalone "$WORKSPACE"
