#!/bin/sh

set -eu

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

reusable_node_version() {
  case "$1" in
    v*.*.*) ;;
    *) return 1 ;;
  esac
  rest="${1#v}"
  major="${rest%%.*}"
  rest="${rest#*.}"
  minor="${rest%%.*}"
  patch="${rest#*.}"
  case "$major$minor$patch" in
    *[!0-9]*) return 1 ;;
  esac
  case "$patch" in
    *.*) return 1 ;;
  esac
  [ -n "$major" ] && [ -n "$minor" ] && [ -n "$patch" ] || return 1
  if [ "$major" -eq 24 ]; then
    [ "$minor" -gt 22 ] && return 0
    [ "$minor" -eq 22 ] && [ "$patch" -ge 1 ] && return 0
    return 1
  fi
  if [ "$major" -eq 26 ]; then
    [ "$minor" -gt 12 ] && return 0
    [ "$minor" -eq 12 ] && [ "$patch" -ge 1 ] && return 0
    return 1
  fi
  return 1
}

node_reject_message() {
  rest="${1#v}"
  major="${rest%%.*}"
  case "$major" in
    24) printf 'Installed Node.js %s is older than the patched 24.22.1; using a verified temporary runtime.\n' "$1" ;;
    26) printf 'Installed Node.js %s is older than the patched 26.12.1; using a verified temporary runtime.\n' "$1" ;;
    25) printf 'Installed Node.js %s is an end-of-life release with no security patch; using a verified temporary runtime.\n' "$1" ;;
    *) printf 'Installed Node.js %s is not a patched runtime Relmio can reuse; using a verified temporary runtime.\n' "$1" ;;
  esac
}

platform_name="$(uname -s)" \
  || fail "Could not identify the operating system."
git_bash_windows=0
case "$platform_name" in
  MINGW* | MSYS* | CYGWIN*) git_bash_windows=1 ;;
esac

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

installed_node_version=""
if command -v node >/dev/null 2>&1; then
  installed_node_version="$(node --version 2>/dev/null || true)"
fi

case "$installed_node_version" in
  v[0-9]*.[0-9]*.[0-9]*)
    if [ "$git_bash_windows" -eq 0 ] \
      && reusable_node_version "$installed_node_version" \
      && command -v npx >/dev/null 2>&1; then
      say "Using installed Node.js ${installed_node_version} runtime."
      RELMIO_FOREGROUND_WIZARD=1 \
        npx --yes --ignore-scripts relmio@latest < "$terminal_input"
      exit $?
    fi
    if [ "$git_bash_windows" -eq 0 ] && ! reusable_node_version "$installed_node_version"; then
      say "$(node_reject_message "$installed_node_version")"
    fi
    ;;
esac

command -v curl >/dev/null 2>&1 \
  || fail "curl is required to download the portable runtime."
command -v tar >/dev/null 2>&1 \
  || fail "tar is required to unpack the portable runtime."
command -v awk >/dev/null 2>&1 \
  || fail "awk is required to select the portable runtime."

case "$platform_name" in
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
    winpty_binary="$(command -v winpty)" \
      || fail "winpty is required when running from Git Bash."
    command -v cygpath >/dev/null 2>&1 \
      || fail "cygpath is required when running from Git Bash."
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
manifest_url="$node_dist_url/latest-v24.x/SHASUMS256.txt"

say "[1/4] Installing a temporary Node.js 24 runtime. Please wait; this does not install Node.js system-wide."
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
  node-v24.*"$archive_suffix") ;;
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
  v24.*) ;;
  *)
    fail "The Node.js manifest returned an unexpected version."
    ;;
esac
case "${node_version#v}" in
  *[!0-9.]* | '')
    fail "The Node.js manifest returned an invalid version."
    ;;
esac
reusable_node_version "$node_version" \
  || fail "The Node.js manifest version is older than the patched 24.22.1."

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
say "[4/4] Extracting the verified temporary Node.js 24 runtime. Please wait..."
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
if [ "$git_bash_windows" -eq 1 ]; then
  node_path_preload="$temporary_directory/relmio-path.cjs"
  printf '%s\n' \
    '"use strict";' \
    'const { delimiter, dirname } = require("node:path");' \
    'const pathKey = Object.keys(process.env).find((name) => name.toLowerCase() === "path");' \
    'const inheritedPath = pathKey ? process.env[pathKey] : "";' \
    'process.env.PATH = `${dirname(process.execPath)}${delimiter}${inheritedPath}`;' \
    > "$node_path_preload" \
    || fail "Could not prepare the temporary Node.js runtime environment for Git Bash."
  portable_path="$node_directory${PATH:+:$PATH}"
  windows_path="$(cygpath --windows --path "$portable_path")" \
    || fail "Could not prepare the temporary Node.js runtime path for Git Bash."
  RELMIO_FOREGROUND_WIZARD=1 \
    MSYS2_ENV_CONV_EXCL="PATH${MSYS2_ENV_CONV_EXCL:+;$MSYS2_ENV_CONV_EXCL}" \
    PATH="$windows_path" \
    "$winpty_binary" "$node_binary" --require "$node_path_preload" "$npx_cli" --yes --ignore-scripts relmio@latest < "$terminal_input"
else
  RELMIO_FOREGROUND_WIZARD=1 \
    PATH="$node_directory${PATH:+:$PATH}" \
    "$node_binary" "$npx_cli" --yes --ignore-scripts relmio@latest < "$terminal_input"
fi
