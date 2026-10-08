# Aseprite MCP — Claude Pixel Bridge

Let Claude draw pixel art directly inside [Aseprite](https://www.aseprite.org/) through the
[Model Context Protocol](https://modelcontextprotocol.io). Works with your own Claude
subscription via Claude Code, or with any MCP client.

```
Aseprite (Lua extension) ◄─ WebSocket ─► bridge (Node) ◄─ MCP over HTTP ─► Claude
```

- **aseprite-extension/**: Lua extension. Connects to the bridge and runs pixel operations.
- **bridge/**: TypeScript server. Exposes MCP tools and forwards them to Aseprite.

## Requirements

- Aseprite 1.3+
- Node.js 20+
- An MCP client, e.g. [Claude Code](https://claude.com/claude-code)

## Setup

```bash
# 1. Build and start the bridge (keep it running)
cd bridge
npm install
npm run build
npm start

# 2. Package the Aseprite extension, then double-click the result to install it
./scripts/package-extension.sh   # → dist/claude-pixel-bridge.aseprite-extension

# 3. Register the MCP server with Claude Code
claude mcp add --transport http --scope user aseprite http://127.0.0.1:7800/mcp
```

## Chat inside Aseprite

Open **Edit > FX > Claude AI > Claude Chat...** (assign a shortcut via Edit > Keyboard Shortcuts).
The window shows the bridge status, streams Claude's progress, and keeps the conversation
so follow-ups like "make it darker" work.

- **Use selection as context**: Claude edits only inside your current selection.
- **Redraw selection** / **Review & fix**: one-click prompt templates.
- **Stop** cancels the run; every drawing step is undoable with Cmd/Ctrl+Z.

The chat runs the Claude Code CLI headless (`claude -p`) with your own login and only the
Aseprite tools enabled. If it reports an expired login, run `claude auth login`.

## Tools

| Tool | What it does |
|---|---|
| `get_sprite_info` | Size, color mode, frames, layers, selection |
| `create_sprite` | New empty sprite |
| `get_palette` | Current palette colors |
| `read_pixels` | Read a region as a palette grid |
| `write_pixels` | Draw a palette grid (one undo step, optional selection mask) |
| `view_sprite` | Upscaled PNG preview so Claude can see the result |

### Pixel grid format

```json
{
  "palette": { "o": "#1a1c2c", "r": "#b13e53" },
  "rows": [".oo.", "orro", ".oo."]
}
```

One character per pixel, `.` is transparent. Compact in tokens and exact per pixel.

## Configuration

| Env var | Default |
|---|---|
| `ASEPRITE_MCP_PORT` | `7800` (MCP HTTP) |
| `ASEPRITE_WS_PORT` | `7801` (Aseprite WebSocket) |
| `ASEPRITE_REQUEST_TIMEOUT_MS` | `30000` |
| `CLAUDE_PATH` | `claude` (Claude Code CLI used by the chat) |
| `ASEPRITE_CLAUDE_WORKDIR` | `<tmp>/aseprite-mcp-claude` (empty cwd for chat runs) |

Both servers bind to `127.0.0.1` only.

## Roadmap

- [x] Phase 1: bridge, extension, core MCP tools
- [x] Phase 2: in-Aseprite chat window (runs `claude -p` headless)
- [ ] Phase 3: inpaint selection, batch variations, animation, 4/8 directions
- [ ] Phase 4: style references, history

## License

MIT
