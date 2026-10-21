# Connecting MCP clients

The bridge is a regular [MCP](https://modelcontextprotocol.io) server. Any MCP client that
speaks **Streamable HTTP** can draw in Aseprite through it:

| | |
|---|---|
| Endpoint | `http://127.0.0.1:7800/mcp` |
| Transport | Streamable HTTP (stateless), no authentication |
| Reachable from | this computer only (it listens on `127.0.0.1`) |

Two things must be true before any client can use the tools:

1. **The bridge is running**: either the background service from `scripts/install.sh --service`
   (`install.ps1 -Service` on Windows), or `aseprite-mcp` / `node bridge/bin/aseprite-mcp.js`
   in a terminal you keep open.
2. **Aseprite is open** with the Aseprite MCP extension installed and its connection allowed
   (see [Troubleshooting](TROUBLESHOOTING.md#aseprite-shows-a-security-dialog-on-first-start)).

`aseprite-mcp doctor` checks both.

## Get the config for your client

The CLI prints the exact snippet for each client, with the right port:

```bash
aseprite-mcp print-config              # lists the clients
aseprite-mcp print-config cursor       # prints the snippet; hints go to stderr
```

From a git checkout (without a global install) use `node bridge/bin/aseprite-mcp.js print-config cursor`.

| Client | `print-config` id | Where it goes |
|---|---|---|
| [Claude Code](#claude-code) | `claude-code` | one terminal command |
| [Claude Desktop](#claude-desktop) | `claude-desktop` | `claude_desktop_config.json` (via `mcp-remote`) |
| [OpenAI Codex](#openai-codex-cli-and-ide-extension) | `codex` | `~/.codex/config.toml` or `codex mcp add` |
| [Cursor](#cursor) | `cursor` | `~/.cursor/mcp.json` or `.cursor/mcp.json` |
| [VS Code (Copilot)](#vs-code-github-copilot) | `vscode` | `.vscode/mcp.json` or `code --add-mcp` |
| [Gemini CLI](#gemini-cli) | `gemini-cli` | `~/.gemini/settings.json` or `gemini mcp add` |
| [Windsurf](#windsurf) | `windsurf` | `~/.codeium/windsurf/mcp_config.json` |
| [Zed](#zed) | `zed` | Zed `settings.json` |
| [Anything else](#other-clients) | `generic` | the common `mcpServers` format |

If you changed the port (`ASEPRITE_MCP_PORT`), pass it along: `aseprite-mcp print-config cursor --port 7900`.
The snippets below use the default port 7800.

---

## Claude Code

```bash
claude mcp add --transport http --scope user aseprite http://127.0.0.1:7800/mcp
```

`--scope user` makes the server available in every project. The installers run this for you
when they find the `claude` command.

**Check:** `claude mcp get aseprite` shows `Status: ✔ Connected` while the bridge runs.
Inside a Claude Code session, `/mcp` lists `aseprite` with its tools.

## Claude Desktop

Claude Desktop starts only local (stdio) servers from its config file, so the
[`mcp-remote`](https://github.com/geelen/mcp-remote) helper relays between stdio and the bridge's
HTTP endpoint. It needs Node.js (`npx`) on your PATH.

1. In Claude Desktop open **Settings > Developer > Edit Config**. This opens
   `claude_desktop_config.json`:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
2. Add `aseprite` inside `mcpServers` (keep any servers that are already there):

   ```json
   {
     "mcpServers": {
       "aseprite": {
         "command": "npx",
         "args": ["-y", "mcp-remote", "http://127.0.0.1:7800/mcp"]
       }
     }
   }
   ```

3. Quit Claude Desktop completely and open it again.

**Check:** the tools menu in a new chat lists the `aseprite` tools.

## OpenAI Codex (CLI and IDE extension)

Either run

```bash
codex mcp add aseprite --url http://127.0.0.1:7800/mcp
```

or add this table to `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`):

```toml
[mcp_servers.aseprite]
url = "http://127.0.0.1:7800/mcp"
```

The CLI and the IDE extension share this file.

**Check:** `codex mcp list` shows `aseprite`; in a Codex session, `/mcp` lists its tools.

## Cursor

Add to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "aseprite": {
      "url": "http://127.0.0.1:7800/mcp"
    }
  }
}
```

**Check:** Cursor's MCP settings list `aseprite` as enabled with its tools.

## VS Code (GitHub Copilot)

VS Code uses the key `servers` (not `mcpServers`). Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "aseprite": {
      "type": "http",
      "url": "http://127.0.0.1:7800/mcp"
    }
  }
}
```

Or add it to your user profile, so it works in every workspace:

```bash
code --add-mcp '{"name":"aseprite","type":"http","url":"http://127.0.0.1:7800/mcp"}'
```

**Check:** in Copilot Chat switch to **Agent** mode and open the tools picker: the `aseprite`
tools are listed.

## Gemini CLI

```bash
gemini mcp add --scope user --transport http aseprite http://127.0.0.1:7800/mcp
```

or add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "aseprite": {
      "httpUrl": "http://127.0.0.1:7800/mcp"
    }
  }
}
```

`httpUrl` selects Streamable HTTP; the similar-looking `url` field means the older SSE transport
and does not work with the bridge.

**Check:** `/mcp` in a Gemini CLI session lists `aseprite` as connected.

## Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`
(Windows: `%USERPROFILE%\.codeium\windsurf\mcp_config.json`), then press **Refresh** in
Windsurf's MCP panel:

```json
{
  "mcpServers": {
    "aseprite": {
      "serverUrl": "http://127.0.0.1:7800/mcp"
    }
  }
}
```

Windsurf ignores a plain `url` field here; it must be `serverUrl`.

## Zed

Add to Zed's `settings.json` (command palette: `zed: open settings`):

```json
{
  "context_servers": {
    "aseprite": {
      "url": "http://127.0.0.1:7800/mcp"
    }
  }
}
```

## Other clients

Most MCP clients understand this shape; some call the URL field `serverUrl` or `httpUrl`:

```json
{
  "mcpServers": {
    "aseprite": {
      "type": "http",
      "url": "http://127.0.0.1:7800/mcp"
    }
  }
}
```

A client that only supports stdio servers can use the same `mcp-remote` command as
[Claude Desktop](#claude-desktop). Use `127.0.0.1` or `localhost` in the URL: the bridge rejects
other host names as a protection against DNS rebinding.

---

## A first prompt to try

> Create a new 32x32 sprite of a treasure chest using the pico8 palette with a dark outline,
> then show me a preview.

The model reads the tool descriptions, creates the sprite, draws it (usually with `draw_script`)
and checks the result with `view_sprite`. Every edit is a single Ctrl+Z / Cmd+Z step in Aseprite.

## The in-Aseprite assistant and AI providers

The assistant window inside Aseprite (**Edit > FX > Aseprite MCP > AI Assistant...**) does not
need any of the clients above: the bridge runs the model for you through a *provider*.

- **Claude Code** (default) uses your own Claude subscription through the `claude` CLI. Install
  [Claude Code](https://claude.com/claude-code) and log in once with `claude auth login`.
- **Experimental:** Codex CLI, Gemini CLI, OpenAI-compatible APIs (including local servers) and
  the Anthropic API. They are configured in `~/.aseprite-mcp/config.json` (another location can
  be set with `ASEPRITE_MCP_CONFIG`); the details are in
  [bridge/src/llm/README.md](../bridge/src/llm/README.md).

Pick the provider, model and effort in the assistant window. A provider whose CLI or API key is
missing is shown as unavailable together with what to do.
