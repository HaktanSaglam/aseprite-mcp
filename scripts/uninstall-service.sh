#!/usr/bin/env bash
# Stops the bridge LaunchAgent and removes it from login items.
set -euo pipefail

LABEL="com.aseprite-mcp.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed $LABEL"
