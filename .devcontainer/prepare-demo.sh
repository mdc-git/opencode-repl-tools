#!/usr/bin/env bash
set -euo pipefail

DEMO_USER=opencode-demo
DEMO_HOME=/home/$DEMO_USER
TTYD_VERSION=1.7.7

if ! id -u "$DEMO_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEMO_USER"
fi
chmod 700 "$DEMO_HOME"

source /usr/local/share/nvm/nvm.sh
nvm install 26
nvm alias default 26

install -d -m 755 -o "$DEMO_USER" -g "$DEMO_USER" "$DEMO_HOME/.local/bin"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/$TTYD_VERSION/SHA256SUMS" -o "$work/SHA256SUMS"
curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/$TTYD_VERSION/ttyd.x86_64" -o "$work/ttyd.x86_64"
(
  cd "$work"
  grep ' ttyd.x86_64$' SHA256SUMS | sha256sum -c -
)
install -m 755 -o "$DEMO_USER" -g "$DEMO_USER" "$work/ttyd.x86_64" "$DEMO_HOME/.local/bin/ttyd"

runuser -u "$DEMO_USER" -- env HOME="$DEMO_HOME" PATH=/usr/local/bin:/usr/bin:/bin bash -c \
  'curl -fsSL https://opencode.ai/v2/install | bash'
