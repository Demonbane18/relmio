#!/bin/sh
# Weekly re-approval for the relmio-claude companion. Run on the VPS as root, in a terminal: sh renew.sh
# Asks the four companion review questions, re-checks Claude login, extends approval by just under 7 days,
# and restarts only relmio-claude. A missing terminal, decline, or EOF writes nothing.
set -eu
if [ ! -t 0 ] || [ ! -t 1 ]; then
  echo "renew.sh needs an interactive terminal. Nothing was written." >&2
  exit 1
fi
cd "$(dirname "$0")"

renew_py() {
  python3 - "$1" <<'PY'
import datetime, errno, json, os, stat, sys

path = "launch.json"
mode = sys.argv[1]
if not hasattr(os, "O_NOFOLLOW"):
    sys.exit("This host cannot open launch.json without following links.")

def refuse(message):
    sys.exit(message)

def read_launch():
    try:
        info = os.lstat(path)
    except OSError as error:
        refuse(f"Refusing launch.json ({error.strerror}).")
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        refuse("launch.json must be a regular file, not a link.")
    if info.st_size > 16 * 1024:
        refuse("launch.json is too large.")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        current = os.fstat(fd)
        if (not stat.S_ISREG(current.st_mode) or current.st_nlink != 1 or
            current.st_size != info.st_size or current.st_ino != info.st_ino):
            refuse("launch.json must be a regular file, not a link.")
        raw = os.read(fd, current.st_size)
        if len(raw) != current.st_size:
            refuse("launch.json changed while reading.")
    finally:
        os.close(fd)
    try:
        config = json.loads(raw.decode("utf-8"))
    except Exception:
        refuse("launch.json is not valid JSON.")
    if not isinstance(config, dict) or not isinstance(config.get("qualification"), dict):
        refuse("launch.json has no qualification to renew.")
    return config

config = read_launch()
if mode == "summarize":
    models = config.get("models")
    shown = ", ".join(models) if isinstance(models, list) else "unknown"
    print("Claude Code", config.get("version", "unknown"))
    print("SHA256:", config.get("executableSha256", "unknown"))
    print("Models:", shown)
    raise SystemExit(0)
if mode != "write":
    refuse("renew.sh internal mode is invalid.")

now = datetime.datetime.now(datetime.timezone.utc)
def fmt(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"
config["qualification"]["reviewedAt"] = fmt(now - datetime.timedelta(seconds=1))
config["qualification"]["expiresAt"] = fmt(now + datetime.timedelta(days=7, hours=-1))
payload = (json.dumps(config, indent=2) + "\n").encode()

tmp = path + ".next"
flags = os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_WRONLY
try:
    out = os.open(tmp, flags, 0o600)
except OSError as error:
    if error.errno in (errno.EEXIST, errno.ELOOP):
        refuse("Refusing existing launch.json.next.")
    raise
try:
    info = os.fstat(out)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (info.st_mode & 0o077) != 0:
        raise OSError("replacement failed its private-file check")
    view = payload
    while view:
        wrote = os.write(out, view)
        if wrote == 0:
            raise OSError("short write")
        view = view[wrote:]
    os.fchown(out, 10001, 10001)
    os.fsync(out)
except Exception as error:
    os.close(out)
    os.unlink(tmp)
    if isinstance(error, OSError):
        refuse(f"Could not publish the new launch file ({error.strerror}). Run renew.sh as root.")
    raise
os.close(out)
os.replace(tmp, path)
print("Approved until", config["qualification"]["expiresAt"])
PY
}

renew_py summarize

confirm() {
  printf '%s [y/N] ' "$1"
  read -r answer || { echo "Not renewed." >&2; exit 1; }
  answer=$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')
  case "$answer" in
    y|yes) ;;
    *) echo "Not renewed." >&2; exit 1 ;;
  esac
}
confirm "Is this the official Claude Code binary for this platform, with the SHA256 above matching the official manifest?"
confirm "Have you reviewed the effective Claude Code policy for the companion on this Docker host (managed settings, policy helpers, managed MCP servers and hooks) and found nothing that runs commands, adds tools or changes sign-in or models?"
confirm "Is the companion signed in to your own plan, with these models and extra usage turned off, and does auth status show loggedIn true and authMethod claude.ai?"
confirm "Will you keep that policy, login and billing unchanged while this approval lasts and run sh renew.sh again after any change?"

status=$(docker exec -w /data/account/empty relmio-claude env -i HOME=/home/claude USER=claude LOGNAME=claude \
  CLAUDE_CONFIG_DIR=/data/account/config PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR=/tmp \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 /opt/claude/2.1.317/claude auth status --json 2>/dev/null || true)
printf '%s' "$status" | python3 -c '
import json, sys
try: j = json.load(sys.stdin)
except Exception: j = {}
if j.get("loggedIn") is not True or j.get("authMethod") != "claude.ai":
    sys.exit("Companion Claude login missing. Run: sh login.sh")
print("Claude login:", j.get("authMethod"), "plan", j.get("subscriptionType", "unknown"))'
renew_py write
docker compose restart relmio-claude
