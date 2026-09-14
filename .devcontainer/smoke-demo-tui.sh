#!/usr/bin/env bash
set -euo pipefail

workspace=/tmp/opencode-tui-smoke
capture=/tmp/opencode-tui-smoke.log
rm -rf "$workspace" "$capture"
install -d -m 0700 "$workspace"
cp -a /opt/opencode-demo/source/. "$workspace/"
chmod -R u+rwX,go-rwx "$workspace"
chown -R 1001:1001 "$workspace"
ln -s /opt/opencode-repl-tools/node_modules "$workspace/node_modules"

/usr/local/bin/opencode-ephemeral "$workspace" /bin/sh -ceu '
  id
  stat -c "%u:%g %a %n" \
    /home \
    /home/opencode-demo \
    /home/opencode-demo/.claude \
    /home/opencode-demo/.agents
  readlink -f /home/opencode-demo/.claude
  readlink -f /home/opencode-demo/.agents
'

set +e
timeout --signal=TERM --kill-after=2s 8s \
  script -qefc \
    "/usr/local/bin/opencode-ephemeral '$workspace' /usr/bin/env OPENCODE_PRINT_LOGS=1 TERM=xterm-256color opencode2 --standalone /workspace" \
    "$capture"
status=$?
set -e

cat "$capture"
rm -rf "$workspace" "$capture"

if [[ $status -eq 124 ]]; then
  exit 0
fi

echo "standalone TUI exited before the smoke window completed (status=$status)" >&2
exit 1
