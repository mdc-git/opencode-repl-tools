#!/usr/bin/env bash
set -euo pipefail

if [[ "${OPENCODE_DEMO_ENV_SANITIZED:-}" != 1 ]]; then
  exec env -i \
    HOME=/home/opencode-demo \
    USER=root \
    LOGNAME=root \
    SHELL=/bin/bash \
    LANG=C.UTF-8 \
    PATH=/opt/opencode-runtime/bin:/usr/local/bin:/usr/bin:/bin \
    OPENCODE_DEMO_ENV_SANITIZED=1 \
    "$0"
fi

DEMO_HOME=/home/opencode-demo
SESSION_ROOT=$DEMO_HOME/session
SESSION_HOME=$SESSION_ROOT/home
WORKSPACE=$SESSION_HOME/workspace
DEMO_SOURCE=/opt/opencode-demo/source
PORT=7681

umask 077
ulimit -c 0
ulimit -n 256
ulimit -u 128

while true; do
  rm -rf "$SESSION_ROOT"
  install -d -o 1001 -g 1001 -m 0700 "$SESSION_HOME"
  install -d -m 0700 "$WORKSPACE"
  cp -a "$DEMO_SOURCE/." "$WORKSPACE/"
  chmod -R u+rwX,go-rwx "$WORKSPACE"
  chown -R 1001:1001 "$WORKSPACE"
  ln -s /opt/opencode-repl-tools/node_modules "$WORKSPACE/node_modules"

  /usr/local/bin/opencode-ephemeral "$WORKSPACE" \
    /usr/local/bin/ttyd \
      --writable \
      --check-origin \
      --interface 0.0.0.0 \
      --port "$PORT" \
      opencode2 --standalone /workspace || true

  rm -rf "$SESSION_ROOT"
  echo "ttyd exited; starting a fresh demo session" >&2
  sleep 1
done
