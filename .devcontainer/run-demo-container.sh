#!/usr/bin/env bash
set -euo pipefail

DEMO_USER=opencode-demo
DEMO_HOME=/home/$DEMO_USER
DEMO_ROOT=$DEMO_HOME/workspace
SOURCE=${OPENCODE_DEMO_SOURCE:-/workspaces/${RepositoryName:-opencode-repl-tools}}
LOG=/root/.cache/opencode-repl-tools-preview.log
PORT=7681

mkdir -p "$(dirname "$LOG")"
: >"$LOG"

for _ in $(seq 1 100); do
  if [[ -f "$SOURCE/package.json" && -d "$SOURCE/plugins/repl" ]]; then
    break
  fi
  sleep 0.1
done

if [[ ! -f "$SOURCE/package.json" || ! -d "$SOURCE/plugins/repl" ]]; then
  echo "demo source is not ready at $SOURCE" >>"$LOG"
  exit 1
fi

rm -rf "$DEMO_ROOT"
install -d -m 0755 -o "$DEMO_USER" -g "$DEMO_USER" "$DEMO_ROOT"
cp -a "$SOURCE/." "$DEMO_ROOT/"
rm -rf "$DEMO_ROOT/.git" "$DEMO_ROOT/node_modules"
ln -s /opt/opencode-repl-tools/node_modules "$DEMO_ROOT/node_modules"
chown -R "$DEMO_USER:$DEMO_USER" "$DEMO_ROOT"

exec runuser -u "$DEMO_USER" -- env -i \
  HOME="$DEMO_HOME" \
  USER="$DEMO_USER" \
  LOGNAME="$DEMO_USER" \
  SHELL=/bin/bash \
  LANG=C.UTF-8 \
  PATH=/usr/local/bin:/usr/bin:/bin \
  OPENCODE_REPL_NODE=/usr/local/bin/node \
  OPENCODE_REPL_PYTHON=/usr/bin/python3 \
  /usr/local/bin/ttyd \
    --writable \
    --interface 0.0.0.0 \
    --port "$PORT" \
    --cwd "$DEMO_ROOT" \
    "$DEMO_HOME/.opencode/bin/opencode2" --standalone "$DEMO_ROOT" \
    >>"$LOG" 2>&1
