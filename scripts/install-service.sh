#!/usr/bin/env bash
# Runs the bridge in the background as a per-user service: it starts at login, restarts
# if it crashes and no longer depends on a terminal window staying open. No sudo needed.
#   macOS: launchd LaunchAgent  ~/Library/LaunchAgents/com.aseprite-mcp.bridge.plist
#   Linux: systemd user unit    ~/.config/systemd/user/aseprite-mcp-bridge.service
# Re-running it replaces an older install. ASEPRITE_* variables and CLAUDE_PATH set while
# running it (e.g. ASEPRITE_MCP_PORT=7900) are copied into the service environment.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTRY="$ROOT/bridge/dist/index.js"
MCP_PORT="${ASEPRITE_MCP_PORT:-7800}"

fail() { echo "error: $*" >&2; exit 1; }

NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || fail "node not found on PATH. Install Node.js 20+ first (https://nodejs.org)."
if ! command -v claude >/dev/null 2>&1; then
  echo "note: 'claude' is not on PATH; the in-Aseprite chat needs Claude Code or another provider." >&2
fi

# install.sh has just built the bridge and sets this to skip a second build.
if [[ "${ASEPRITE_MCP_SKIP_BUILD:-}" != "1" ]]; then
  echo "Building bridge..."
  (cd "$ROOT/bridge" && npm run build >/dev/null)
fi
[[ -f "$ENTRY" ]] || fail "$ENTRY is missing. Run 'npm ci && npm run build' in $ROOT/bridge first."

# Names of the settings to copy into the service. API keys are deliberately not copied:
# they belong in ~/.aseprite-mcp/config.json, not in a plist or unit file.
passthrough_vars() {
  local name
  for name in $(compgen -e); do
    if [[ "$name" == ASEPRITE_* && "$name" != ASEPRITE_MCP_SKIP_BUILD ]] || [[ "$name" == CLAUDE_PATH ]]; then
      echo "$name"
    fi
  done
}

port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -Hltn "sport = :$1" 2>/dev/null | grep -q .
  else
    return 1
  fi
}

# Called after the old service is stopped: whatever still holds the port is something else
# (typically a bridge started by hand in a terminal), and the service would crash-loop.
warn_if_port_busy() {
  local _
  for _ in 1 2 3 4 5; do
    port_in_use "$MCP_PORT" || return 0
    sleep 1
  done
  echo "warning: port $MCP_PORT is already in use. Stop the other bridge (Ctrl+C in its terminal)" >&2
  echo "         or choose another port: ASEPRITE_MCP_PORT=7900 $0" >&2
}

# ---------------------------------------------------------------- macOS (launchd)

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

install_launchd() {
  local label="com.aseprite-mcp.bridge"
  local plist="$HOME/Library/LaunchAgents/$label.plist"
  local log="$HOME/Library/Logs/aseprite-mcp-bridge.log"
  local domain
  domain="gui/$(id -u)"

  local env_xml name
  # launchd starts agents with a minimal PATH; reuse this shell's PATH so `claude` is found.
  env_xml="    <key>PATH</key><string>$(xml_escape "$PATH")</string>"
  for name in $(passthrough_vars); do
    env_xml+=$'\n'"    <key>$name</key><string>$(xml_escape "${!name}")</string>"
  done

  mkdir -p "$(dirname "$plist")" "$(dirname "$log")"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE")</string>
    <string>$(xml_escape "$ENTRY")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$ROOT/bridge")</string>
  <key>EnvironmentVariables</key>
  <dict>
$env_xml
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml_escape "$log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$log")</string>
</dict>
</plist>
EOF
  plutil -lint "$plist" >/dev/null || fail "generated $plist is not a valid property list"

  launchctl bootout "$domain/$label" 2>/dev/null || true
  warn_if_port_busy
  # bootout returns before launchd has fully dropped the job; bootstrap fails with
  # "Input/output error" until it has, so retry briefly instead of failing the install.
  local attempt
  for attempt in 1 2 3 4 5; do
    if launchctl bootstrap "$domain" "$plist" 2>/dev/null; then break; fi
    [[ $attempt -eq 5 ]] && fail "launchctl bootstrap failed. Try: launchctl bootstrap $domain \"$plist\""
    sleep 1
  done

  sleep 1
  if launchctl print "$domain/$label" 2>/dev/null | grep -q "state = running"; then
    echo "Bridge service is running ($label)."
  else
    echo "warning: the service was installed but is not running yet; check the log below." >&2
  fi
  echo "  logs:      tail -f \"$log\""
  echo "  restart:   launchctl kickstart -k $domain/$label   (after rebuilding)"
  echo "  uninstall: \"$ROOT/scripts/uninstall-service.sh\""
}

# ---------------------------------------------------------------- Linux (systemd --user)

# Unit files expand %-specifiers everywhere and $VARS in ExecStart; quoted words use C escapes.
systemd_quote() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//%/%%}"
  printf '"%s"' "$s"
}
systemd_exec_quote() { local s="$1"; systemd_quote "${s//\$/\$\$}"; }

install_systemd() {
  local unit_name="aseprite-mcp-bridge.service"
  local unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  local unit="$unit_dir/$unit_name"

  command -v systemctl >/dev/null 2>&1 || fail "systemctl not found. Start the bridge by hand instead: node \"$ROOT/bridge/bin/aseprite-mcp.js\""
  systemctl --user show-environment >/dev/null 2>&1 ||
    fail "no systemd user session (common in WSL and containers). Start the bridge by hand instead: node \"$ROOT/bridge/bin/aseprite-mcp.js\""

  local env_lines name workdir
  env_lines="Environment=$(systemd_quote "PATH=$PATH")"
  for name in $(passthrough_vars); do
    env_lines+=$'\n'"Environment=$(systemd_quote "$name=${!name}")"
  done
  workdir="$ROOT/bridge"

  mkdir -p "$unit_dir"
  cat >"$unit" <<EOF
[Unit]
Description=Aseprite MCP bridge
Documentation=https://github.com/HaktanSaglam/aseprite-mcp

[Service]
Type=simple
ExecStart=$(systemd_exec_quote "$NODE") $(systemd_exec_quote "$ENTRY")
WorkingDirectory=${workdir//%/%%}
$env_lines
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

  systemctl --user stop "$unit_name" 2>/dev/null || true
  warn_if_port_busy
  systemctl --user daemon-reload
  systemctl --user enable --now "$unit_name" >/dev/null
  # enable --now does not restart an already running unit; restart picks up the new build.
  systemctl --user restart "$unit_name"

  sleep 1
  if systemctl --user is-active --quiet "$unit_name"; then
    echo "Bridge service is running ($unit_name)."
  else
    echo "warning: the service was installed but is not running; check the log below." >&2
  fi
  echo "  logs:      journalctl --user -u aseprite-mcp-bridge -f"
  echo "  restart:   systemctl --user restart aseprite-mcp-bridge   (after rebuilding)"
  echo "  uninstall: \"$ROOT/scripts/uninstall-service.sh\""
}

case "$(uname -s)" in
  Darwin) install_launchd ;;
  Linux) install_systemd ;;
  *) fail "unsupported system $(uname -s). On Windows use scripts\\install-service.ps1." ;;
esac
