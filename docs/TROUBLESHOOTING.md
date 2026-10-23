# Troubleshooting

**Start here:** run the doctor. It checks Node.js, the build, the bridge, the connection to
Aseprite, the installed extension, the Claude CLI and your config file, and prints a fix for
every problem it finds.

```bash
aseprite-mcp doctor                      # after a global install
node bridge/bin/aseprite-mcp.js doctor   # from the repository folder
```

A healthy setup with Aseprite open looks like this:

```
  OK    Node.js 22.12.0
  OK    Bridge is built
  OK    Bridge 1.0.0 is running at http://127.0.0.1:7800/mcp
  OK    Aseprite is connected
  OK    Aseprite MCP extension 1.0.0 is installed
  OK    Claude Code CLI found (2.1.0 (Claude Code))
  OK    No provider config file (~/.aseprite-mcp/config.json); using defaults
```

How the pieces fit together, so the messages below make sense:

```
Aseprite + extension  ──WebSocket 127.0.0.1:7801──►  bridge  ◄──HTTP 127.0.0.1:7800/mcp──  MCP client / assistant
```

The extension *connects to* the bridge, so the bridge has to be running for anything to work.

---

## Aseprite shows a Security dialog on first start

Aseprite asks before a script opens a network connection:

> The following script: …/extensions/aseprite-mcp/… wants to open a WebSocket connection to this
> URL: ws://127.0.0.1:7801

1. Tick **Don't show this specific alert again for this script**.
2. Click **Allow to Open Connections**.

The connection only goes to your own computer (`127.0.0.1`). Ticking the box stores the answer,
so the dialog does not come back on the next start.

**You know it worked when** the assistant window shows the bridge as connected and
`aseprite-mcp doctor` reports `Aseprite is connected`.

If you clicked **Stop Script** by mistake: restart Aseprite and allow it this time, or use
**Edit > FX > Aseprite MCP > Reconnect Bridge**.

## Aseprite asks "wants to write to this file"

`save_sprite` and `export_sprite` write files through Aseprite, and Aseprite asks before a script
writes anywhere. Check the path in the dialog, then click **Allow Write Access** (tick
**Don't show this specific alert again for this script** to stop being asked for that file).

## The assistant says the bridge is offline / disconnected

The bridge is not running, or Aseprite cannot reach it.

1. Run `aseprite-mcp doctor`.
2. If it says **Bridge is not running**, start it:
   - background service (starts at login): run the installer again with `--service`
     (`scripts/install.sh --service`, Windows: `scripts\install.ps1 -Service`), or
   - by hand: `node bridge/bin/aseprite-mcp.js` in a terminal and keep that window open.
3. In Aseprite click **Edit > FX > Aseprite MCP > Reconnect Bridge** (it also retries on its own
   every few seconds).

**You know it worked when** the bridge log prints `[bridge] Aseprite connected`.

## "Port 7800 is used by another program" / `EADDRINUSE`

Something else already listens on the bridge's ports. Often it is a second bridge: one started
in a terminal while the background service also runs. Stop one of them (Ctrl+C in the terminal,
or `scripts/uninstall-service.sh`).

To find the program:

- macOS / Linux: `lsof -nP -iTCP:7800 -sTCP:LISTEN` (and `7801`)
- Windows (PowerShell): `Get-NetTCPConnection -LocalPort 7800 -State Listen | ForEach-Object { Get-Process -Id $_.OwningProcess }`

To use other ports instead:

1. Start the bridge with new ports: `aseprite-mcp --port 7900 --ws-port 7901`, or set
   `ASEPRITE_MCP_PORT=7900` and `ASEPRITE_WS_PORT=7901` and re-run the installer with `--service`
   (it copies these variables into the service).
2. Tell the extension: in the assistant's **Settings** tab set the bridge port to the
   `--ws-port` value, then **Reconnect Bridge**.
3. Update your MCP clients to the new MCP port: `aseprite-mcp print-config <client> --port 7900`.

## "Claude CLI login expired"

The in-Aseprite chat runs the Claude Code CLI with your own login, which can expire.

1. Open a terminal and run `claude auth login`.
2. Finish the login in the browser window that opens.
3. Send the message again in Aseprite. No restart is needed.

**You know it worked when** `claude -p "say hi"` in the terminal answers without an error.

## "Claude Code CLI not found"

The default provider needs the `claude` command.

1. Install Claude Code: <https://claude.com/claude-code>, then run `claude auth login`.
2. If you run the bridge as a background service, re-run the installer with `--service` so the
   service picks up the new PATH.
3. If `claude` lives somewhere unusual, set `CLAUDE_PATH=/full/path/to/claude` before starting
   the bridge (or before re-running the installer).

Other providers (Codex CLI, Gemini CLI, API keys) are configured in `~/.aseprite-mcp/config.json`;
see [CLIENTS.md](CLIENTS.md#the-in-aseprite-assistant-and-ai-providers).

## An MCP client cannot connect

- Use the URL exactly: `http://127.0.0.1:7800/mcp` (`localhost` works too). Other host names,
  including your computer's name or LAN IP, are rejected with `403 Host not allowed`: that check
  protects you from web pages using DNS rebinding.
- The bridge only accepts connections from the same computer. Run the client, the bridge and
  Aseprite on the same machine (on Windows, run the bridge with Windows Node.js, not inside WSL).
- Check the config shape for your client in [CLIENTS.md](CLIENTS.md): VS Code uses `servers`,
  Gemini CLI uses `httpUrl`, Windsurf uses `serverUrl`.
- After editing a client's config file, restart the client.

## Tools time out or Aseprite "does not answer"

Aseprite runs extension code on its UI thread. While a modal dialog is open (Save As,
Preferences, a Security prompt, an alert), every request waits.

1. Look for an open dialog in Aseprite, possibly behind another window, and close it.
2. Try again. Long operations can be given more time with
   `ASEPRITE_REQUEST_TIMEOUT_MS=60000` (default 30000).

## The connection keeps dropping and reconnecting

Two copies of the extension are installed and keep replacing each other's connection. Before
1.0 the extension was called **Claude Pixel Bridge**.

1. In Aseprite open **Edit > Preferences > Extensions**.
2. Select **Claude Pixel Bridge** and click **Uninstall**. Keep **Aseprite MCP**.
3. Restart Aseprite.

The installers offer to remove the old copy automatically.

## Where Aseprite keeps extensions

| System | Extensions folder |
|---|---|
| macOS | `~/Library/Application Support/Aseprite/extensions` |
| Windows | `%APPDATA%\Aseprite\extensions` |
| Linux | `~/.config/aseprite/extensions` |

The Steam version uses the same folders. If you set `ASEPRITE_USER_FOLDER`, Aseprite (and the
doctor) use `$ASEPRITE_USER_FOLDER/extensions` instead. In Aseprite, **Edit > Preferences >
Extensions > Open Folder** opens it.

## Logs

| Where the bridge runs | Log |
|---|---|
| In a terminal | that terminal window |
| macOS background service | `~/Library/Logs/aseprite-mcp-bridge.log` (`tail -f` it) |
| Linux background service | `journalctl --user -u aseprite-mcp-bridge -f` |
| Windows background bridge | `%LOCALAPPDATA%\aseprite-mcp\bridge.log` |

Restart the background bridge after updating:

- macOS: `launchctl kickstart -k gui/$(id -u)/com.aseprite-mcp.bridge`
- Linux: `systemctl --user restart aseprite-mcp-bridge`
- Windows: run the installer again with `-Service`

## Reinstall, update or remove everything

**Update** to a new version:

```bash
git pull
scripts/install.sh            # Windows: powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

The installer rebuilds the bridge, restarts the background service if you have one and hands the
new extension to Aseprite (click **Yes** when Aseprite offers the upgrade).

**Remove** everything:

1. Background bridge: `scripts/uninstall-service.sh` (Windows: `scripts\uninstall-service.ps1`).
2. Extension: Aseprite > **Edit > Preferences > Extensions** > **Aseprite MCP** > **Uninstall**.
3. Claude Code registration: `claude mcp remove aseprite -s user`.
4. Optional settings: delete `~/.aseprite-mcp/`.
5. Delete the repository folder.

## Windows: "running scripts is disabled on this system"

PowerShell blocks downloaded scripts by default. Run the installer with a one-time bypass that
does not change any system setting:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

## Linux: "no systemd user session"

WSL and containers often have no `systemctl --user`. Run the bridge by hand instead
(`node bridge/bin/aseprite-mcp.js`), for example in a terminal multiplexer.

## "Node.js is too old"

The bridge needs Node.js 20 or newer (`node --version`). Install the current LTS from
<https://nodejs.org> (macOS: `brew install node`, Windows: `winget install OpenJS.NodeJS.LTS`),
open a new terminal and run the installer again.

## Still stuck?

[Open an issue](https://github.com/HaktanSaglam/aseprite-mcp/issues/new/choose) with the output of
`aseprite-mcp doctor` and the bridge log.
