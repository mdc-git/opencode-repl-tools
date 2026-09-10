#!/usr/bin/env bash
set -euo pipefail

DEMO_USER=opencode-demo
DEMO_HOME=/home/$DEMO_USER
DEMO_SOURCE=/opt/opencode-demo/source
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

rm -rf "$DEMO_SOURCE"
install -d -m 0755 -o root -g root "$DEMO_SOURCE"
cp -a "$SOURCE/." "$DEMO_SOURCE/"
rm -rf "$DEMO_SOURCE/.git" "$DEMO_SOURCE/node_modules"
chown -R root:root "$DEMO_SOURCE"
chmod -R a-w "$DEMO_SOURCE"
chmod -R a+rX "$DEMO_SOURCE"

# The public demo must never be able to alter the real Codespaces checkout.
# The remote Codespaces user is root, so the editor and lifecycle machinery
# retain access while the unprivileged demo identity cannot traverse it.
chmod 0700 "$SOURCE"

while true; do
  runuser -u "$DEMO_USER" -- env -i \
    HOME="$DEMO_HOME" \
    USER="$DEMO_USER" \
    LOGNAME="$DEMO_USER" \
    SHELL=/bin/bash \
    LANG=C.UTF-8 \
    PATH=/usr/local/bin:/usr/bin:/bin \
    /usr/local/bin/ttyd \
      --writable \
      --check-origin \
      --max-clients 1 \
      --interface 0.0.0.0 \
      --port "$PORT" \
      /usr/local/bin/run-demo-session \
      >>"$LOG" 2>&1 || true
  echo "ttyd exited; restarting" >>"$LOG"
  sleep 1
done
