#!/usr/bin/env bash
set -euo pipefail

DEMO_USER=opencode-demo
DEMO_HOME=/home/$DEMO_USER
DEMO_ROOT=$DEMO_HOME/workspace
LOG=$HOME/.cache/opencode-repl-tools-preview.log
PORT=7681

mkdir -p "$HOME/.cache"
: >"$LOG"
rm -rf "$DEMO_ROOT"
install -d -m 755 -o "$DEMO_USER" -g "$DEMO_USER" "$DEMO_ROOT"
cp -a "${PWD}/." "$DEMO_ROOT/"
rm -rf "$DEMO_ROOT/.git" "$DEMO_ROOT/node_modules"
ln -s /opt/opencode-repl-tools/node_modules "$DEMO_ROOT/node_modules"
chown -R "$DEMO_USER:$DEMO_USER" "$DEMO_ROOT"

runuser -u "$DEMO_USER" -- env \
  HOME="$DEMO_HOME" \
  PATH="/usr/local/bin:/usr/bin:/bin" \
  OPENCODE_REPL_NODE=/usr/local/bin/node \
  OPENCODE_REPL_PYTHON=/usr/bin/python3 \
  nohup /usr/local/bin/ttyd \
    --writable \
    --interface 0.0.0.0 \
    --port "$PORT" \
    --cwd "$DEMO_ROOT" \
    "$DEMO_HOME/.opencode/bin/opencode2" --standalone "$DEMO_ROOT" \
    >>"$LOG" 2>&1 </dev/null &
