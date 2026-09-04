#!/bin/sh

set -eu

minimum_node_major=22
node_dist_url="https://nodejs.org/download/release"
temporary_directory=""
terminal_input="/dev/tty"

say() {
  printf 'Relmio installer: %s\n' "$1"
}

fail() {
  printf 'Relmio installer: %s\n' "$1" >&2
  exit 1
}

if ! ( : < "$terminal_input" ) 2>/dev/null; then
  fail "An interactive terminal is required to start Relmio. Run this command from a local terminal."
fi

download() {
  curl -fsSL \
    --proto '=https' \
    --proto-redir '=https' \
    --connect-timeout 15 \
    --max-time 600 \
    --retry 2 \
    --retry-delay 1 \
    "$1" -o "$2"
}

cleanup() {
  if [ -n "$temporary_directory" ] && [ -d "$temporary_directory" ]; then
    rm -rf -- "$temporary_directory"
  fi
}

installed_node_major=""
if command -v node >/dev/null 2>&1; then
  installed_node_major="$(
    node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true
  )"
fi

case "$installed_node_major" in
  '' | *[!0-9]*) ;;
  *)
    if [ "$installed_node_major" -ge "$minimum_node_major" ] \
      && command -v npx >/dev/null 2>&1; then
      say "Using installed Node.js ${installed_node_major} runtime."
      RELMIO_FOREGROUND_WIZARD=1 \
        npx --yes --ignore-scripts relmio@latest < "$terminal_input"
      exit $?
    fi
    ;;
esac

command -v curl >/dev/null 2>&1 \
  || fail "curl is required to download the portable runtime."
command -v tar >/dev/null 2>&1 \
  || fail "tar is required to unpack the portable runtime."
command -v awk >/dev/null 2>&1 \
  || fail "awk is required to select the portable runtime."

case "$(uname -s)" in
  Darwin)
    node_platform="darwin"
    archive_extension="tar.gz"
    ;;
  Linux)
    node_platform="linux"
    archive_extension="tar.gz"
    ;;
  MINGW* | MSYS* | CYGWIN*)
    node_platform="win"
    archive_extension="zip"
    command -v unzip >/dev/null 2>&1 \
      || fail "unzip is required when running from Git Bash."
    ;;
  *)
    fail "Unsupported operating system. Use macOS, Linux, WSL, or Git Bash."
    ;;
esac

case "$(uname -m)" in
  arm64 | aarch64)
    node_architecture="arm64"
    ;;
  x86_64 | amd64)
    node_architecture="x64"
    ;;
  *)
    fail "Unsupported CPU architecture. Relmio supports arm64 and x64."
    ;;
esac

umask 077
temporary_directory="$(
  mktemp -d "${TMPDIR:-/tmp}/relmio.XXXXXX"
)" || fail "Could not create a temporary directory."
trap cleanup EXIT HUP INT TERM

manifest_path="$temporary_directory/SHASUMS256.txt"
manifest_url="$node_dist_url/latest-v22.x/SHASUMS256.txt"

say "[1/4] Installing a temporary Node.js 22 runtime. Please wait; this does not install Node.js system-wide."
say "[2/4] Downloading the official Node.js checksum manifest and runtime. Please wait..."
download "$manifest_url" "$manifest_path" \
  || fail "Could not download the official Node.js checksum manifest."

archive_suffix="-${node_platform}-${node_architecture}.${archive_extension}"
archive_name="$(
  awk -v suffix="$archive_suffix" '
    substr($2, length($2) - length(suffix) + 1) == suffix {
      print $2
      exit
    }
  ' "$manifest_path"
)"

case "$archive_name" in
  node-v22.*"$archive_suffix") ;;
  *)
    fail "The Node.js manifest did not contain a supported runtime."
    ;;
esac
case "$archive_name" in
  *[!A-Za-z0-9._-]*)
    fail "The Node.js manifest returned an invalid filename."
    ;;
esac

expected_checksum="$(
  awk -v filename="$archive_name" '$2 == filename { print $1; exit }' \
    "$manifest_path"
)"
case "$expected_checksum" in
  *[!0-9A-Fa-f]* | '')
    fail "The Node.js manifest returned an invalid checksum."
    ;;
esac
[ "${#expected_checksum}" -eq 64 ] \
  || fail "The Node.js manifest returned an invalid checksum."

version_and_platform="${archive_name#node-}"
node_version="${version_and_platform%%-*}"
case "$node_version" in
  v22.*) ;;
  *)
    fail "The Node.js manifest returned an unexpected version."
    ;;
esac
case "${node_version#v}" in
  *[!0-9.]* | '')
    fail "The Node.js manifest returned an invalid version."
    ;;
esac

archive_path="$temporary_directory/$archive_name"
archive_url="$node_dist_url/$node_version/$archive_name"
download "$archive_url" "$archive_path" \
  || fail "Could not download the official Node.js runtime."

say "[3/4] Verifying the Node.js SHA-256 checksum. Please wait..."
if command -v sha256sum >/dev/null 2>&1; then
  actual_checksum="$(sha256sum "$archive_path" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual_checksum="$(shasum -a 256 "$archive_path" | awk '{ print $1 }')"
else
  fail "sha256sum or shasum is required to verify the Node.js download."
fi

[ "$actual_checksum" = "$expected_checksum" ] \
  || fail "Node.js download checksum did not match; nothing was executed."
say "Verified Node.js download."
say "[4/4] Extracting the verified temporary Node.js 22 runtime. Please wait..."
if [ "$archive_extension" = "zip" ]; then
  unzip -q "$archive_path" -d "$temporary_directory"
  archive_root="${archive_name%.zip}"
  node_binary="$temporary_directory/$archive_root/node.exe"
  npx_cli="$temporary_directory/$archive_root/node_modules/npm/bin/npx-cli.js"
else
  tar -xzf "$archive_path" -C "$temporary_directory"
  archive_root="${archive_name%.tar.gz}"
  node_binary="$temporary_directory/$archive_root/bin/node"
  npx_cli="$temporary_directory/$archive_root/lib/node_modules/npm/bin/npx-cli.js"
fi

[ -x "$node_binary" ] \
  || fail "The verified Node.js archive did not contain its runtime."
[ -f "$npx_cli" ] \
  || fail "The verified Node.js archive did not contain npm."

say "Starting the newest Relmio wizard."
node_directory="${node_binary%/*}"
RELMIO_FOREGROUND_WIZARD=1 \
  PATH="$node_directory${PATH:+:$PATH}" \
  "$node_binary" "$npx_cli" --yes --ignore-scripts relmio@latest < "$terminal_input"
