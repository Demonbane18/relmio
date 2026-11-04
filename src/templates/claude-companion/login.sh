#!/bin/sh
# One-time Claude login for the relmio-claude companion. Run on the VPS as root: sh login.sh
# Uses the companion's exact environment. Paste the code from the browser at "Paste code here".
set -eu
run() {
  docker exec -it -w /data/account/empty relmio-claude env -i TERM="${TERM:-xterm-256color}" \
    HOME=/home/claude USER=claude LOGNAME=claude CLAUDE_CONFIG_DIR=/data/account/config \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR=/tmp /opt/claude/2.1.317/claude "$@"
}
run auth login
echo
echo "Companion login status:"
run auth status --json | python3 -c 'import json,sys; j=json.load(sys.stdin); print({k: j.get(k) for k in ("loggedIn","authMethod","subscriptionType")})'
