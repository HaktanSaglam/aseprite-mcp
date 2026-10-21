#!/usr/bin/env bash
# Development helper: copies aseprite-extension/ straight into Aseprite's extensions folder
# (no packaging), so a restart of Aseprite picks up local changes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

case "$(uname)" in
  Darwin) EXT_DIR="$HOME/Library/Application Support/Aseprite/extensions" ;;
  Linux) EXT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/aseprite/extensions" ;;
  *) EXT_DIR="$APPDATA/Aseprite/extensions" ;;
esac

# Aseprite remembers "allow WebSocket" per script path, so a dev copy can be installed
# under the folder name you already approved (ASEPRITE_MCP_DEV_NAME).
NAME="${ASEPRITE_MCP_DEV_NAME:-aseprite-mcp}"
TARGET="$EXT_DIR/$NAME"
# Two copies of the extension would both connect to the bridge.
for other in aseprite-mcp claude-pixel-bridge; do
  [[ "$other" != "$NAME" ]] && rm -rf "${EXT_DIR:?}/$other"
done
mkdir -p "$TARGET"
# Keep Aseprite's own files (__pref.lua holds the user's settings).
find "$TARGET" -mindepth 1 -maxdepth 1 ! -name "__*" -exec rm -rf {} +
rsync -a --exclude tests --exclude ".*" "$ROOT/aseprite-extension/" "$TARGET/"
echo "Installed to $TARGET — restart Aseprite to load it."
