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

# Copy base agent templates into mounted pi-agent dir (won't overwrite user customizations)
if [ -d /opt/ghostbox/agents ]; then
  mkdir -p /root/.pi/agent/agents
  for f in /opt/ghostbox/agents/*.md; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    if [ ! -f "/root/.pi/agent/agents/$base" ]; then
      cp "$f" "/root/.pi/agent/agents/$base"
    fi
  done
fi

exec node /ghost-server.js
