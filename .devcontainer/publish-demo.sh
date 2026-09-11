#!/usr/bin/env bash
set -euo pipefail

PORT=7681
LOG=$HOME/.cache/opencode-repl-tools-preview.log
CODESPACE=${CODESPACE_NAME:?CODESPACE_NAME is not set}
TOKEN=${GITHUB_TOKEN:?GITHUB_TOKEN is not set}

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
  echo "ttyd is not responding on port $PORT" >>"$LOG"
  exit 1
fi

GH_TOKEN="$TOKEN" gh codespace ports visibility "$PORT:public" -c "$CODESPACE" >>"$LOG" 2>&1

visibility=$(GH_TOKEN="$TOKEN" gh codespace ports -c "$CODESPACE" --json sourcePort,visibility \
  --jq ".[] | select(.sourcePort == $PORT) | .visibility")

if [[ "$visibility" != public ]]; then
  echo "port $PORT visibility is '$visibility', expected 'public'" >>"$LOG"
  exit 1
fi

url="https://${CODESPACE}-${PORT}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}/"
echo "OpenCode TUI: $url" >>"$LOG"

if [[ -n "${BROWSER:-}" ]]; then
  "$BROWSER" "$url" >/dev/null 2>&1 || true
fi
