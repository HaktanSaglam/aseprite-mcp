// MCP client configuration snippets for `aseprite-mcp print-config <client>`.
// Formats were checked against each client's documentation in October 2026; keep
// docs/CLIENTS.md in sync when one changes.

const SERVER_NAME = "aseprite";

/** @param {unknown} value */
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * @typedef {object} ClientConfig
 * @property {string} label
 * @property {(url: string) => string} snippet  What goes to stdout (pipeable into a file).
 * @property {(url: string) => string[]} hint   Where to put it; printed to stderr.
 */

/** @type {Record<string, ClientConfig>} */
export const CLIENTS = {
  "claude-code": {
    label: "Claude Code",
    snippet: (url) => `claude mcp add --transport http --scope user ${SERVER_NAME} ${url}\n`,
    hint: () => [
      "Run this command once in a terminal; the server is then available in every project.",
      `Check it with: claude mcp get ${SERVER_NAME}`,
    ],
  },
  "claude-desktop": {
    label: "Claude Desktop",
    // The desktop app only launches local (stdio) servers from its config file, so
    // mcp-remote relays stdio to the HTTP endpoint. It allows plain http for 127.0.0.1.
    snippet: (url) => json({ mcpServers: { [SERVER_NAME]: { command: "npx", args: ["-y", "mcp-remote", url] } } }),
    hint: () => [
      "Merge into claude_desktop_config.json (Claude Desktop > Settings > Developer > Edit Config):",
      "  macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json",
      "  Windows: %APPDATA%\\Claude\\claude_desktop_config.json",
      "Then quit and reopen Claude Desktop. Needs Node.js (npx) on PATH.",
    ],
  },
  codex: {
    label: "OpenAI Codex CLI / IDE extension",
    snippet: (url) => `[mcp_servers.${SERVER_NAME}]\nurl = "${url}"\n`,
    hint: (url) => [
      "Add to ~/.codex/config.toml (Windows: %USERPROFILE%\\.codex\\config.toml),",
      `or run: codex mcp add ${SERVER_NAME} --url ${url}`,
    ],
  },
  cursor: {
    label: "Cursor",
    snippet: (url) => json({ mcpServers: { [SERVER_NAME]: { url } } }),
    hint: () => [
      "Merge into ~/.cursor/mcp.json (all projects) or .cursor/mcp.json (one project).",
    ],
  },
  vscode: {
    label: "VS Code (GitHub Copilot agent mode)",
    snippet: (url) => json({ servers: { [SERVER_NAME]: { type: "http", url } } }),
    hint: (url) => [
      "Merge into .vscode/mcp.json in your workspace (note: the key is \"servers\"),",
      `or add it to your user profile: code --add-mcp '${JSON.stringify({ name: SERVER_NAME, type: "http", url })}'`,
    ],
  },
  "gemini-cli": {
    label: "Gemini CLI",
    // "httpUrl" selects Streamable HTTP; "url" would mean the older SSE transport.
    snippet: (url) => json({ mcpServers: { [SERVER_NAME]: { httpUrl: url } } }),
    hint: (url) => [
      "Merge into ~/.gemini/settings.json,",
      `or run: gemini mcp add --scope user --transport http ${SERVER_NAME} ${url}`,
    ],
  },
  windsurf: {
    label: "Windsurf",
    snippet: (url) => json({ mcpServers: { [SERVER_NAME]: { serverUrl: url } } }),
    hint: () => [
      "Merge into ~/.codeium/windsurf/mcp_config.json (Windows: %USERPROFILE%\\.codeium\\windsurf\\mcp_config.json),",
      "then press Refresh in Windsurf's MCP panel.",
    ],
  },
  zed: {
    label: "Zed",
    snippet: (url) => json({ context_servers: { [SERVER_NAME]: { url } } }),
    hint: () => ["Merge into Zed's settings.json (command palette: \"zed: open settings\")."],
  },
  generic: {
    label: "Other clients (common mcpServers format)",
    snippet: (url) => json({ mcpServers: { [SERVER_NAME]: { type: "http", url } } }),
    hint: () => [
      "Streamable HTTP endpoint, no authentication. Most clients accept this shape;",
      "some call the URL field \"serverUrl\" or \"httpUrl\" (see docs/CLIENTS.md).",
    ],
  },
};

export const CLIENT_IDS = Object.keys(CLIENTS);
