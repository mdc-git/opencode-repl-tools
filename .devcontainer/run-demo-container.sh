#!/usr/bin/env bash
set -euo pipefail

DEMO_USER=opencode-demo
DEMO_UID=$(id -u "$DEMO_USER")
DEMO_GID=$(id -g "$DEMO_USER")
DEMO_SOURCE=/opt/opencode-demo/source
SOURCE=${OPENCODE_DEMO_SOURCE:-/workspaces/${RepositoryName:-opencode-repl-tools}}
LOG=/root/.cache/opencode-repl-tools-preview.log
PORT=7681

mkdir -p "$(dirname "$LOG")"
: >"$LOG"

for dir in /tmp /var/tmp /dev/shm; do
  if [[ -d "$dir" ]]; then
    chmod 0755 "$dir"
  fi
done

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

rm -rf "$DEMO_SOURCE"
install -d -m 0755 -o root -g root "$DEMO_SOURCE"
cp -a "$SOURCE/." "$DEMO_SOURCE/"
rm -rf "$DEMO_SOURCE/.git" "$DEMO_SOURCE/node_modules"
chown -R root:root "$DEMO_SOURCE"
chmod -R a-w "$DEMO_SOURCE"
chmod -R a+rX "$DEMO_SOURCE"

chmod 0700 "$(dirname "$SOURCE")" "$SOURCE"

while true; do
  /usr/bin/setpriv \
    --reuid="$DEMO_UID" \
    --regid="$DEMO_GID" \
    --clear-groups \
    --inh-caps=-all \
    --bounding-set=-all \
    --no-new-privs \
    env -i \
      HOME=/home/opencode-demo \
      USER="$DEMO_USER" \
      LOGNAME="$DEMO_USER" \
      SHELL=/bin/bash \
      LANG=C.UTF-8 \
      PATH=/usr/local/bin:/usr/bin:/bin \
      /usr/local/bin/ttyd \
        --writable \
        --check-origin \
        --max-clients 4 \
        --exit-no-conn \
        --interface 0.0.0.0 \
        --port "$PORT" \
        /usr/bin/tmux new-session -A -s opencode-demo /usr/local/bin/run-demo-session \
        >>"$LOG" 2>&1 || true

  /usr/bin/setpriv \
    --reuid="$DEMO_UID" \
    --regid="$DEMO_GID" \
    --clear-groups \
    --inh-caps=-all \
    --bounding-set=-all \
    --no-new-privs \
    /usr/bin/tmux kill-server >/dev/null 2>&1 || true
  rm -rf /home/opencode-demo/session

  echo "ttyd exited; restarting with a fresh demo session" >>"$LOG"
  sleep 1
done
