#!/bin/bash
set -euo pipefail

install_dependencies() {
  local manifest_path="$1"
  local install_dir="$2"
  local label="$3"

  if [ ! -f "$manifest_path" ]; then
    return
  fi

  echo "[entrypoint] Installing ${label} dependencies..."
  if ! (
    cd "$install_dir"
    npm install --production 2>&1 | tail -5
  ); then
    echo "[entrypoint] Failed to install ${label} dependencies - continuing"
  fi
}

install_dependencies /vault/package.json /vault "vault"
install_dependencies /vault/.pi/extensions/package.json /vault/.pi/extensions "extension"

exec node /ghost-server.js
