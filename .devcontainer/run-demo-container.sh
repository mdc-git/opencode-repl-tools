#!/usr/bin/env bash
set -euo pipefail

if [[ "${OPENCODE_DEMO_ENV_SANITIZED:-}" != 1 ]]; then
  exec env -i \
    HOME=/root \
    LANG=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    RepositoryName="${RepositoryName:-opencode-repl-tools}" \
    OPENCODE_DEMO_SOURCE="${OPENCODE_DEMO_SOURCE:-}" \
    OPENCODE_DEMO_ENV_SANITIZED=1 \
    "$0"
fi

DEMO_USER=opencode-demo
DEMO_UID=$(id -u "$DEMO_USER")
DEMO_GID=$(id -g "$DEMO_USER")
DEMO_HOME=/home/opencode-demo
TMUX_TMPDIR=$DEMO_HOME/tmux
DEMO_SOURCE=/opt/opencode-demo/source
SOURCE=${OPENCODE_DEMO_SOURCE:-/workspaces/${RepositoryName:-opencode-repl-tools}}
LOG=/root/.cache/opencode-repl-tools-preview.log
PORT=7681

umask 077
ulimit -c 0
ulimit -n 256
ulimit -u 128

mkdir -p "$(dirname "$LOG")"
: >"$LOG"
install -d -m 0700 -o "$DEMO_UID" -g "$DEMO_GID" "$TMUX_TMPDIR"

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
      HOME="$DEMO_HOME" \
      TMUX_TMPDIR="$TMUX_TMPDIR" \
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
    env TMUX_TMPDIR="$TMUX_TMPDIR" /usr/bin/tmux kill-server >/dev/null 2>&1 || true
  rm -rf "$DEMO_HOME/session"

  echo "ttyd exited; restarting with a fresh demo session" >>"$LOG"
  sleep 1
done
