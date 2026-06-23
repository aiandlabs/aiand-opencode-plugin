#!/usr/bin/env bash
#
# demo.sh — run OpenCode with the ai& plugin.
#
# Installs OpenCode if needed (into ~/.opencode/bin) and launches it from this
# directory so the local opencode.json + aiand.ts take effect.
#
# Usage:
#   ./demo.sh                 # interactive: launch the TUI, pick an ai& model
#   ./demo.sh run "say hi"    # non-interactive single turn
#
# Auth (either works):
#   - interactive:  inside the TUI run `/login`, or `opencode auth login` → ai&
#   - non-interactive:  export AIAND_API_KEY=sk-...
#
# Override the gateway base URL without editing anything:
#   export AIAND_BASE_URL=https://api.aiand.com/v1

set -euo pipefail
cd "$(dirname "$0")"

OPENCODE_BIN="$HOME/.opencode/bin/opencode"

if [ ! -x "$OPENCODE_BIN" ]; then
  echo "==> OpenCode not found; installing to ~/.opencode/bin ..."
  curl -fsSL https://opencode.ai/install | bash
fi

echo "==> using $OPENCODE_BIN ($("$OPENCODE_BIN" --version))"
echo "==> base URL: ${AIAND_BASE_URL:-https://api.aiand.com/v1}"
echo

# Stay inside this project dir so the local opencode.json + plugin load.
# OPENCODE_CONFIG pins the config explicitly in case you run from elsewhere.
export OPENCODE_CONFIG="$PWD/opencode.json"

if [ "${1:-}" = "run" ]; then
  shift
  exec "$OPENCODE_BIN" run "$@"
fi

exec "$OPENCODE_BIN" "$@"
