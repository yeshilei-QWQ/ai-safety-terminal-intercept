#!/bin/sh
# ASTI autostart runner for Linux / macOS.
# Invoked by the systemd user unit or the launchd agent (see scripts/autostart/).
# Can also be run manually:  ./scripts/asti-run.sh
# Logs to ~/.asti/asti.log
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(dirname -- "$SCRIPT_DIR")
LOG_DIR="${HOME}/.asti"
LOG="${LOG_DIR}/asti.log"

mkdir -p "$LOG_DIR"

NODE_BIN=$(command -v node 2>/dev/null || true)
if [ -z "$NODE_BIN" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] asti: node not found in PATH" >> "$LOG"
  exit 127
fi

cd "$REPO_DIR"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] asti starting (node=$NODE_BIN)" >> "$LOG"
# exec so the service manager supervises the real process directly
exec "$NODE_BIN" src/cli/index.ts run --port 8787 >> "$LOG" 2>&1
