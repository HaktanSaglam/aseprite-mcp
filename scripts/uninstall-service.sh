#!/usr/bin/env bash
# Stops the background bridge service installed by install-service.sh and removes it from
# login items. Safe to run when nothing is installed.
set -euo pipefail

case "$(uname -s)" in
  Darwin)
    LABEL="com.aseprite-mcp.bridge"
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    if [[ ! -f "$PLIST" ]]; then
      echo "Nothing to remove: $LABEL is not installed."
      exit 0
    fi
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed $LABEL (the log stays at ~/Library/Logs/aseprite-mcp-bridge.log)."
    ;;
  Linux)
    UNIT_NAME="aseprite-mcp-bridge.service"
    UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT_NAME"
    if [[ ! -f "$UNIT" ]]; then
      echo "Nothing to remove: $UNIT_NAME is not installed."
      exit 0
    fi
    systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
    rm -f "$UNIT"
    systemctl --user daemon-reload 2>/dev/null || true
    echo "Removed $UNIT_NAME."
    ;;
  *)
    echo "error: unsupported system $(uname -s). On Windows use scripts\\uninstall-service.ps1." >&2
    exit 1
    ;;
esac
