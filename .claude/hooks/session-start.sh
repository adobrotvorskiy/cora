#!/bin/bash
# Cloud sessions (Claude Code on the web): the image ships Node 22, the project needs Node >= 24
# (package.json engines; several tests are cancelled on 22). Install the latest Node 24 once,
# put it first on PATH for the session and install npm dependencies.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

NODE_DIR=/opt/node24
if ! "$NODE_DIR/bin/node" --version 2>/dev/null | grep -q '^v24\.'; then
  version=$(curl -fsSL https://nodejs.org/dist/index.json \
    | python3 -c 'import json,sys; print(next(x["version"] for x in json.load(sys.stdin) if x["version"].startswith("v24.")))')
  tmp=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/$version/node-$version-linux-x64.tar.xz" -o "$tmp/node.tar.xz"
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xJf "$tmp/node.tar.xz" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
fi

export PATH="$NODE_DIR/bin:$PATH"
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$NODE_DIR/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

cd "$CLAUDE_PROJECT_DIR"
npm install --no-audit --no-fund
