#!/bin/sh
# ASTI autostart installer for Linux (systemd user) and macOS (launchd agent).
# Windows users: see README "Windows (Startup folder)" instead.
#
# Usage:  ./scripts/autostart/install.sh            # install
#         ./scripts/autostart/install.sh --uninstall
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(dirname -- "$(dirname -- "$SCRIPT_DIR")")

usage() {
  echo "usage: $0 [--uninstall]" >&2
  exit 2
}

install_linux() {
  UNIT_DIR="${HOME}/.config/systemd/user"
  UNIT="${UNIT_DIR}/asti.service"
  mkdir -p "$UNIT_DIR"
  sed "s#__REPO__#${REPO_DIR}#g" "$SCRIPT_DIR/asti.service" > "$UNIT"
  chmod 644 "$UNIT"
  systemctl --user daemon-reload
  systemctl --user enable --now asti.service
  echo "installed: $UNIT"
  echo "status:    systemctl --user status asti.service"
  echo "log:       ${HOME}/.asti/asti.log"
}

uninstall_linux() {
  systemctl --user disable --now asti.service 2>/dev/null || true
  rm -f "${HOME}/.config/systemd/user/asti.service"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "removed systemd user unit asti.service"
}

install_macos() {
  AGENT_DIR="${HOME}/Library/LaunchAgents"
  AGENT="${AGENT_DIR}/com.asti.proxy.plist"
  mkdir -p "$AGENT_DIR"
  sed "s#__REPO__#${REPO_DIR}#g" "$SCRIPT_DIR/com.asti.proxy.plist" > "$AGENT"
  chmod 644 "$AGENT"
  launchctl unload "$AGENT" 2>/dev/null || true
  launchctl load "$AGENT"
  echo "installed: $AGENT"
  echo "status:    launchctl list | grep com.asti.proxy"
  echo "log:       ${HOME}/.asti/asti.log"
}

uninstall_macos() {
  AGENT="${HOME}/Library/LaunchAgents/com.asti.proxy.plist"
  launchctl unload "$AGENT" 2>/dev/null || true
  rm -f "$AGENT"
  echo "removed launchd agent com.asti.proxy"
}

ACTION="install"
case "${1:-}" in
  "") ;;
  --uninstall) ACTION="uninstall" ;;
  *) usage ;;
esac

case "$(uname -s)" in
  Linux)
    if [ "$ACTION" = "install" ]; then install_linux; else uninstall_linux; fi
    ;;
  Darwin)
    if [ "$ACTION" = "install" ]; then install_macos; else uninstall_macos; fi
    ;;
  *)
    echo "error: unsupported platform '$(uname -s)'. Windows: see README (Startup folder)." >&2
    exit 1
    ;;
esac
