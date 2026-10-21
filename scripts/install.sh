#!/usr/bin/env bash
# One-command setup for macOS and Linux (Windows: scripts\install.ps1):
#   1. checks Node.js 20+, installs and builds the bridge
#   2. packages the Aseprite extension and hands it to Aseprite to install
#   3. optionally runs the bridge as a background service that starts at login
#   4. optionally registers the MCP server with Claude Code
# Safe to re-run after `git pull`: every step updates what is already there. No sudo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_FILE="$ROOT/dist/aseprite-mcp.aseprite-extension"
CLI="$ROOT/bridge/bin/aseprite-mcp.js"
MCP_URL="http://127.0.0.1:${ASEPRITE_MCP_PORT:-7800}/mcp"
WS_URL="ws://127.0.0.1:${ASEPRITE_WS_PORT:-7801}"

usage() {
  cat <<'EOF'
Usage: scripts/install.sh [options]

  --service       Run the bridge in the background at login (launchd / systemd --user)
  --no-service    Don't install the background service and don't ask
  --claude        Register the MCP server with Claude Code (claude mcp add ...)
  --no-claude     Don't register with Claude Code and don't ask
  --no-open       Only package the extension; don't hand it to Aseprite
  -y, --yes       Answer yes to every question
  -h, --help      Show this help

Without flags the script asks before each optional step when run in a terminal,
and skips them when it is not (CI, pipes).
Environment: ASEPRITE_MCP_PORT (default 7800), ASEPRITE_WS_PORT (default 7801).
EOF
}

SERVICE=""   # "", "yes" or "no"; empty means ask
CLAUDE=""
OPEN_EXT=1
ASSUME_YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --service) SERVICE=yes ;;
    --no-service) SERVICE=no ;;
    --claude) CLAUDE=yes ;;
    --no-claude) CLAUDE=no ;;
    --no-open) OPEN_EXT=0 ;;
    -y | --yes) ASSUME_YES=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "error: unknown option '$1'" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ -t 1 ]]; then BOLD=$'\033[1m' RED=$'\033[31m' RESET=$'\033[0m'; else BOLD="" RED="" RESET=""; fi
step() { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$RESET"; }
fail() { printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# Yes/no question; defaults to yes in a terminal and to no without one.
ask() {
  [[ $ASSUME_YES -eq 1 ]] && return 0
  [[ -t 0 ]] || return 1
  local reply
  read -r -p "$1 [Y/n] " reply
  [[ -z "$reply" || "$reply" =~ ^[Yy] ]]
}

# $1: the flag value ("yes", "no" or "" = ask), $2: the question.
decide() {
  case "$1" in
    yes) return 0 ;;
    no) return 1 ;;
    *) ask "$2" ;;
  esac
}

extensions_dir() {
  # ASEPRITE_USER_FOLDER is Aseprite's own override for its settings folder.
  if [[ -n "${ASEPRITE_USER_FOLDER:-}" ]]; then
    echo "$ASEPRITE_USER_FOLDER/extensions"
    return
  fi
  case "$(uname -s)" in
    Darwin) echo "$HOME/Library/Application Support/Aseprite/extensions" ;;
    *) echo "${XDG_CONFIG_HOME:-$HOME/.config}/aseprite/extensions" ;;
  esac
}

service_installed() {
  case "$(uname -s)" in
    Darwin) [[ -f "$HOME/Library/LaunchAgents/com.aseprite-mcp.bridge.plist" ]] ;;
    Linux) [[ -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/aseprite-mcp-bridge.service" ]] ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------- 1. Node.js + bridge

step "Checking Node.js"
command -v node >/dev/null 2>&1 ||
  fail "Node.js is not installed. Install Node.js 20 or newer (https://nodejs.org, or 'brew install node' on macOS), then run this script again."
command -v npm >/dev/null 2>&1 || fail "npm is not on PATH. Reinstall Node.js from https://nodejs.org (npm ships with it)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || fail "Node.js $(node -v) is too old; version 20 or newer is required."
echo "Node.js $(node -v), npm $(npm -v)"

step "Installing and building the bridge"
(
  cd "$ROOT/bridge"
  npm ci --no-audit --no-fund --loglevel=error
  npm run build --silent
)
echo "Built $ROOT/bridge/dist"

# ---------------------------------------------------------------- 2. Aseprite extension

step "Packaging the Aseprite extension"
bash "$ROOT/scripts/package-extension.sh" "$EXT_FILE"

# The extension was called "claude-pixel-bridge" before 1.0. Both copies would connect
# to the bridge and keep replacing each other's connection.
LEGACY_DIR="$(extensions_dir)/claude-pixel-bridge"
if [[ -d "$LEGACY_DIR" ]]; then
  echo "Found the old 'Claude Pixel Bridge' extension (renamed to Aseprite MCP in 1.0): $LEGACY_DIR"
  if ask "Remove the old extension? (recommended)"; then
    rm -rf "$LEGACY_DIR"
    echo "Removed. Restart Aseprite if it is open."
  else
    echo "Kept. Uninstall it in Aseprite: Edit > Preferences > Extensions > Claude Pixel Bridge > Uninstall."
  fi
fi

EXT_HANDED_OVER=0
if [[ $OPEN_EXT -eq 1 && "$(uname -s)" == Darwin ]]; then
  step "Installing the extension in Aseprite"
  STEAM_APP="$HOME/Library/Application Support/Steam/steamapps/common/Aseprite/Aseprite.app"
  if open -a Aseprite "$EXT_FILE" 2>/dev/null ||
    { [[ -d "$STEAM_APP" ]] && open -a "$STEAM_APP" "$EXT_FILE" 2>/dev/null; }; then
    EXT_HANDED_OVER=1
    echo "Aseprite is opening the extension. In Aseprite click 'Install'"
    echo "(or 'Yes' when it offers to upgrade an existing Aseprite MCP extension)."
  else
    echo "Could not find Aseprite.app; showing the extension file in Finder instead."
    open -R "$EXT_FILE" 2>/dev/null || true
  fi
fi
if [[ $EXT_HANDED_OVER -eq 0 ]]; then
  echo "Install the extension once in Aseprite: Edit > Preferences > Extensions > Add Extension"
  echo "and choose $EXT_FILE"
  echo "(dragging the file onto the Aseprite window works too)."
fi

# ---------------------------------------------------------------- 3. Background service

SERVICE_RUNNING=0
case "$(uname -s)" in
  Darwin | Linux)
    # An existing service keeps running the old build until it is reinstalled.
    if [[ -z "$SERVICE" ]] && service_installed; then SERVICE=yes; fi
    if decide "$SERVICE" "Start the bridge automatically in the background at login?"; then
      step "Installing the background service"
      if ASEPRITE_MCP_SKIP_BUILD=1 bash "$ROOT/scripts/install-service.sh"; then
        SERVICE_RUNNING=1
      else
        echo "The background service could not be installed; start the bridge by hand (see below)." >&2
      fi
    fi
    ;;
esac

# ---------------------------------------------------------------- 4. Claude Code

if command -v claude >/dev/null 2>&1; then
  step "Claude Code"
  if existing="$(claude mcp get aseprite 2>/dev/null)"; then
    if grep -qF "$MCP_URL" <<<"$existing"; then
      echo "Claude Code already knows the 'aseprite' MCP server ($MCP_URL)."
    else
      echo "Claude Code already has an MCP server called 'aseprite' with another URL:"
      while IFS= read -r line; do echo "    $line"; done <<<"$existing"
      echo "To point it at this bridge:"
      echo "    claude mcp remove aseprite -s user"
      echo "    claude mcp add --transport http --scope user aseprite $MCP_URL"
    fi
  elif decide "$CLAUDE" "Register the bridge with Claude Code (claude mcp add, user scope)?"; then
    claude mcp add --transport http --scope user aseprite "$MCP_URL"
    echo "Registered 'aseprite' ($MCP_URL) for all your Claude Code projects."
  else
    echo "Skipped. Register later with: claude mcp add --transport http --scope user aseprite $MCP_URL"
  fi
else
  step "Claude Code"
  echo "The 'claude' CLI was not found. The in-Aseprite chat uses Claude Code by default:"
  echo "install it from https://claude.com/claude-code and run 'claude auth login'."
  echo "Other MCP clients (Cursor, VS Code, Codex, ...): see docs/CLIENTS.md"
fi

# ---------------------------------------------------------------- Summary

step "Done. Next steps"
n=1
if [[ $SERVICE_RUNNING -eq 0 ]]; then
  echo "  $n. Start the bridge and keep the terminal open:"
  echo "       node \"$CLI\""
  n=$((n + 1))
fi
echo "  $n. In Aseprite, when the Security dialog says the script wants to open a WebSocket"
echo "     connection to $WS_URL: tick 'Don't show this specific alert again for this script',"
echo "     then click 'Allow to Open Connections'."
n=$((n + 1))
echo "  $n. Open the assistant: Edit > FX > Aseprite MCP > AI Assistant..."
n=$((n + 1))
echo "  $n. Something not working? Run: node \"$CLI\" doctor"
echo
echo "MCP endpoint for other clients: $MCP_URL  (configs: node \"$CLI\" print-config)"
