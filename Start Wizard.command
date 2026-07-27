#!/bin/sh

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required."
  echo "Install it from https://nodejs.org/ and double-click this file again."
  printf "Press Return to close..."
  read -r _
  exit 1
fi

if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  echo "Your Node.js version is too old. Version 22 or newer is required."
  echo "Update it from https://nodejs.org/ and double-click this file again."
  printf "Press Return to close..."
  read -r _
  exit 1
fi

if [ ! -d node_modules/ssh2 ]; then
  echo "Preparing the local setup wizard..."
  if ! npm ci --ignore-scripts; then
    echo "The wizard could not install its local dependency."
    printf "Press Return to close..."
    read -r _
    exit 1
  fi
fi

npm start
status=$?

if [ "$status" -ne 0 ] && [ "$status" -ne 130 ]; then
  echo "The local wizard stopped with an error."
  printf "Press Return to close..."
  read -r _
fi

exit "$status"
