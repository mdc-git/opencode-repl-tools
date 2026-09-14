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

/usr/local/bin/opencode-ephemeral "$workspace" /bin/bash -ceu '
  probe_client() {
    /usr/local/bin/run-demo-client /bin/sh -ceu '\''
      printf "%s|%s|%s|%s|%s|%s|%s|%s|%s\n" \
        "$HOME" \
        "$TMPDIR" \
        "$XDG_CONFIG_HOME" \
        "$XDG_DATA_HOME" \
        "$XDG_CACHE_HOME" \
        "$XDG_STATE_HOME" \
        "$OPENCODE_CONFIG_DIR" \
        "$OPENCODE_DB" \
        "$NPM_CONFIG_CACHE"
    '\''
  }

  first="$(probe_client)"
  second="$(probe_client)"
  test "$first" != "$second"

  for probe in "$first" "$second"; do
    IFS="|" read -r home tmp config data cache state config_dir db npm <<EOF
$probe
EOF
    root="${home%/home}"
    case "$root" in /tmp/opencode-client.*) ;; *) exit 1 ;; esac
    test "$tmp" = "$root/tmp"
    test "$config" = "$root/xdg/config"
    test "$data" = "$root/xdg/data"
    test "$cache" = "$root/xdg/cache"
    test "$state" = "$root/xdg/state"
    test "$config_dir" = "$root/xdg/config/opencode"
    test "$db" = "$root/xdg/data/opencode/opencode.db"
    test "$npm" = "$root/xdg/npm"
    test ! -e "$root"
  done
'

set +e
timeout --signal=TERM --kill-after=2s 8s \
  script -qefc \
    "/usr/local/bin/opencode-ephemeral '$workspace' /usr/bin/env OPENCODE_PRINT_LOGS=1 TERM=xterm-256color opencode2 --standalone /workspace" \
    "$capture"
status=$?
set -e

cat "$capture"

healthy=1
grep -Fq 'message="location services booted" directory=/workspace' "$capture" || healthy=0
grep -Fq 'message="event stream connected" component=client' "$capture" || healthy=0
grep -Fq 'message="plugin reconciliation completed" component=plugin' "$capture" || healthy=0
if grep -Fq 'UnexpectedStatus' "$capture" || grep -Fq 'http.status=500' "$capture"; then
  healthy=0
fi

rm -rf "$workspace" "$capture"

if [[ $healthy -eq 1 && ( $status -eq 124 || $status -eq 137 ) ]]; then
  exit 0
fi

echo "standalone TUI did not remain healthy for the smoke window (status=$status)" >&2
exit 1
