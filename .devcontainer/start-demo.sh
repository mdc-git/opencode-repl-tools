#!/usr/bin/env bash
set -euo pipefail

DEMO_USER=opencode-demo
DEMO_HOME=/home/$DEMO_USER
DEMO_ROOT=$DEMO_HOME/workspace
LOG=$HOME/.cache/opencode-repl-tools-preview.log
PORT=7681

mkdir -p "$HOME/.cache"
rm -rf "$DEMO_ROOT"
sudo install -d -m 755 -o "$DEMO_USER" -g "$DEMO_USER" "$DEMO_ROOT"
sudo cp -a "${PWD}/." "$DEMO_ROOT/"
sudo chown -R "$DEMO_USER:$DEMO_USER" "$DEMO_ROOT"
sudo rm -rf "$DEMO_ROOT/.git"

source /usr/local/share/nvm/nvm.sh
NODE26_BIN=$(nvm which 26)
NODE26_DIR=$(dirname "$NODE26_BIN")

if [[ -z "${CODESPACE_NAME:-}" ]]; then
  echo "CODESPACE_NAME is not set" >"$LOG"
  exit 1
fi

gh codespace ports visibility "$PORT:public" -c "$CODESPACE_NAME" >"$LOG" 2>&1

sudo -u "$DEMO_USER" -H env \
  HOME="$DEMO_HOME" \
  PATH="$NODE26_DIR:$DEMO_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  OPENCODE_REPL_NODE="$NODE26_BIN" \
  OPENCODE_REPL_PYTHON=/usr/bin/python3 \
  nohup "$DEMO_HOME/.local/bin/ttyd" \
    --writable \
    --interface 0.0.0.0 \
    --port "$PORT" \
    --cwd "$DEMO_ROOT" \
    "$DEMO_HOME/.opencode/bin/opencode2" --standalone "$DEMO_ROOT" \
    >>"$LOG" 2>&1 </dev/null &
