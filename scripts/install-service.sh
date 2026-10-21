#!/usr/bin/env bash
# Installs the bridge as a macOS LaunchAgent: it starts at login, restarts if it crashes,
# and no longer depends on a terminal window staying open.
set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script is for macOS (launchd)." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.aseprite-mcp.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/aseprite-mcp-bridge.log"
DOMAIN="gui/$(id -u)"

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "node not found on PATH. Install Node.js 20+ first." >&2
  exit 1
fi
if ! command -v claude >/dev/null; then
  echo "warning: 'claude' not found on PATH; the chat window will not work until it is installed." >&2
fi

echo "Building bridge..."
(cd "$ROOT/bridge" && npm run build >/dev/null)

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
# launchd starts agents with a minimal PATH; reuse this shell's PATH so `claude` is found.
cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE")</string>
    <string>$(xml_escape "$ROOT/bridge/dist/index.js")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$ROOT/bridge")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml_escape "$PATH")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml_escape "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOG")</string>
</dict>
</plist>
EOF

# Re-running the script replaces an older install instead of failing.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"

echo "Installed $LABEL"
echo "  logs:      $LOG"
echo "  restart:   launchctl kickstart -k $DOMAIN/$LABEL   (after rebuilding)"
echo "  uninstall: $ROOT/scripts/uninstall-service.sh"
