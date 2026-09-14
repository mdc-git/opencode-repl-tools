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
WORKSPACE=$SESSION_ROOT/workspace
PORT=7681

umask 077
ulimit -c 0
ulimit -n 256
ulimit -u 128

while true; do
  rm -rf "$SESSION_ROOT"
  install -d -o 1001 -g 1001 -m 0700 "$WORKSPACE"

  /usr/local/bin/opencode-ephemeral "$WORKSPACE" \
    /usr/local/bin/ttyd \
      --writable \
      --check-origin \
      --interface 0.0.0.0 \
      --port "$PORT" \
      /usr/local/bin/run-demo-client || true

  rm -rf "$SESSION_ROOT"
  echo "ttyd exited; restarting the demo listener" >&2
  sleep 1
done
