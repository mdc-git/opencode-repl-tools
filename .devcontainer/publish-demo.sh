#!/usr/bin/env bash
set -euo pipefail

PORT=7681
CACHE_DIR=$HOME/.cache
LOG=$CACHE_DIR/opencode-repl-tools-preview.log
ERROR_LOG=$CACHE_DIR/opencode-repl-tools-publish-error.log
CODESPACE=${CODESPACE_NAME:?CODESPACE_NAME is not set}
TOKEN=${GITHUB_TOKEN:?GITHUB_TOKEN is not set}

rm -f "$ERROR_LOG"

published=0
for _ in $(seq 1 120); do
  visibility=$(GH_TOKEN="$TOKEN" gh codespace ports -c "$CODESPACE" --json sourcePort,visibility \
    --jq ".[] | select(.sourcePort == $PORT) | .visibility" 2>"$ERROR_LOG" || true)

  if [[ "$visibility" == public ]]; then
    published=1
    break
  fi

  if [[ -n "$visibility" ]] \
    && GH_TOKEN="$TOKEN" gh codespace ports visibility "$PORT:public" -c "$CODESPACE" \
      >"$ERROR_LOG" 2>&1; then
    visibility=$(GH_TOKEN="$TOKEN" gh codespace ports -c "$CODESPACE" --json sourcePort,visibility \
      --jq ".[] | select(.sourcePort == $PORT) | .visibility" 2>"$ERROR_LOG" || true)
    if [[ "$visibility" == public ]]; then
      published=1
      break
    fi
  fi

  sleep 1
done

if (( published == 0 )); then
  echo "failed to make port $PORT public after waiting for Codespaces port registration" >>"$LOG"
  if [[ -s "$ERROR_LOG" ]]; then
    cat "$ERROR_LOG" >>"$LOG"
  fi
  exit 1
fi

rm -f "$ERROR_LOG"
url="https://${CODESPACE}-${PORT}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}/"
echo "OpenCode TUI: $url" >>"$LOG"

if [[ -n "${BROWSER:-}" ]]; then
  "$BROWSER" "$url" >/dev/null 2>&1 || true
fi
