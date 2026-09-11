#!/usr/bin/env bash
set -euo pipefail

if [[ "${OPENCODE_DEMO_ENV_SANITIZED:-}" != 1 ]]; then
  exec env -i \
    HOME=/home/opencode-demo \
    USER=opencode-demo \
    LOGNAME=opencode-demo \
    SHELL=/bin/bash \
    LANG=C.UTF-8 \
    PATH=/usr/local/bin:/usr/bin:/bin \
    OPENCODE_DEMO_ENV_SANITIZED=1 \
    "$0"
fi

DEMO_HOME=/home/opencode-demo
TMUX_TMPDIR=$DEMO_HOME/tmux
PORT=7681

umask 077
ulimit -c 0
ulimit -n 256
ulimit -u 128

install -d -m 0700 "$TMUX_TMPDIR"

while true; do
  env -i \
    HOME="$DEMO_HOME" \
    TMUX_TMPDIR="$TMUX_TMPDIR" \
    USER=opencode-demo \
    LOGNAME=opencode-demo \
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
      /usr/bin/tmux new-session -A -s opencode-demo /usr/local/bin/run-demo-session || true

  env -i \
    HOME="$DEMO_HOME" \
    TMUX_TMPDIR="$TMUX_TMPDIR" \
    USER=opencode-demo \
    LOGNAME=opencode-demo \
    PATH=/usr/local/bin:/usr/bin:/bin \
    /usr/bin/tmux kill-server >/dev/null 2>&1 || true
  rm -rf "$DEMO_HOME/session"

  echo "ttyd exited; restarting with a fresh demo session" >&2
  sleep 1
done
