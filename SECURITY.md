# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through
GitHub: open the repository's **Security** tab and click **Report a vulnerability**
([direct link](https://github.com/HaktanSaglam/aseprite-mcp/security/advisories/new)).

Include what an attacker can do, the steps to reproduce, and the versions involved
(`aseprite-mcp --version`, Aseprite version, operating system). This is a small project
maintained in spare time: expect an acknowledgement within a week. Once a fix is released, the
advisory is published with credit to you unless you prefer to stay anonymous.

## Supported versions

Security fixes go into the latest release. Please update before reporting.

| Version | Supported |
|---|---|
| 1.x (latest) | yes |
| < 1.0 (Claude Pixel Bridge preview) | no |

## Security model

Aseprite MCP lets an AI model edit the documents open in your Aseprite. It is designed to be
reachable only from your own computer and to give the model nothing beyond Aseprite.

**Local only.** The bridge listens on `127.0.0.1` (MCP over HTTP on port 7800, WebSocket for
Aseprite on port 7801) and never on a network interface. There is no authentication on top of
that: any program running on your computer under your account can use the MCP endpoint, just as
it could control Aseprite in other ways. Do not expose these ports with port forwarding, reverse
proxies or tunnels.

**No access from web pages.**
- The MCP endpoint rejects requests whose `Host` header is not `127.0.0.1:<port>` or
  `localhost:<port>`. This blocks DNS rebinding, where a web site's domain is made to resolve to
  127.0.0.1.
- The WebSocket server rejects connections that carry a browser `Origin` (`http://` or
  `https://`), so a web page cannot pretend to be Aseprite.

**Aseprite's own permission prompts.** Aseprite asks before the extension opens its WebSocket
connection and before a script writes a file (`save_sprite`, `export_sprite`), unless you chose
to give the extension full trust.

**Sandboxed scripts.** `draw_script` runs model-written JavaScript in QuickJS compiled to
WebAssembly, a separate engine without access to Node.js, the file system or the network. Each
run is limited in time (5 s), memory (64 MB) and number of drawing calls.

**The in-Aseprite assistant cannot run commands (default and API providers).** With the default
Claude Code provider the bridge starts `claude -p` with all built-in tools disabled (no shell, no
file editing), only this bridge's Aseprite tools allowed, `--strict-mcp-config` and
`--setting-sources ""` (your other MCP servers, hooks and settings are not loaded), in an empty
working directory. The API providers (OpenAI-compatible, Anthropic, Ollama) only ever see this
bridge's tools.

**Experimental CLI providers are less contained.** Codex runs in its own read-only sandbox: it
cannot write files, but its shell tool can read files on disk, and it also loads the MCP servers
from your own Codex configuration. Gemini CLI runs with its file, shell and web tools excluded,
but tool approval is set to automatic. Use them only with prompts you trust.

**Files.** `save_sprite` and `export_sprite` are the only tools that write files, through
Aseprite, to the path the MCP client asks for; see their tool descriptions for the exact rules.
Everything else changes open documents in memory, and every change is one undo step.

**API keys.** Keys for API-based providers live in `~/.aseprite-mcp/config.json` in plain text.
Keep that file private (`chmod 600 ~/.aseprite-mcp/config.json` on macOS and Linux). The
installers never copy keys into service files; only `ASEPRITE_*` settings and `CLAUDE_PATH` are
copied.

**Untrusted content.** Layer names, tags and pixels of a file you open are shown to the model.
A crafted `.aseprite` file could contain text that tries to steer the model ("prompt
injection"). The worst it can do is use the Aseprite tools on your open documents, which you can
undo; still, be careful with automated runs on files from unknown sources.

## Out of scope

- Attacks that already require running code as your user on your computer.
- Problems in Aseprite, Node.js, the MCP SDK or AI provider CLIs themselves; please report those
  to their projects (a heads-up here is welcome if Aseprite MCP users are affected).
