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
# The three fields are formatted by node inside the companion, so the host needs only sh and docker.
run auth status --json | docker exec -i relmio-claude node -e 'process.stdin.setEncoding("utf8");let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{let j;try{j=JSON.parse(s)}catch{console.error("Companion login status could not be read.");process.exit(1)}console.log(JSON.stringify({loggedIn:j?.loggedIn??null,authMethod:j?.authMethod??null,subscriptionType:j?.subscriptionType??null}))})'
