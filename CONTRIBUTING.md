# Contributing to Aseprite MCP

Thanks for helping! Bug reports, new tools, better prompts, client configs and docs are all
welcome. For anything bigger than a small fix, please open an issue first so we can agree on the
approach before you spend time on it.

## Project layout

```
aseprite-extension/        Lua extension that runs inside Aseprite (WebSocket client)
  main.lua                 entry point: menu commands, wiring
  connection.lua           WebSocket client, request dispatch, events
  core/                    shared Lua helpers
  rpc/                     one file per protocol area (sprite, image, selection, layers, ...)
  ui/                      the AI Assistant window
  tests/rpc_test.lua       headless tests for the rpc/ layer
bridge/                    Node.js + TypeScript server (MCP over HTTP, WebSocket server)
  bin/                     `aseprite-mcp` CLI (start, print-config, doctor); plain JS
  src/index.ts             composition root: the only place that picks concrete classes
  src/aseprite/            protocol types and the typed gateway to Aseprite
  src/canvas/              selection masks, multi-frame edits, one-undo-step writes
  src/pixel/               pixel algorithms (compositing, raw formats, previews, ...)
  src/mcp/tools/           MCP tools, one file per area, registered in tools/index.ts
  src/script/              sandboxed draw_script runner (QuickJS / WebAssembly)
  src/chat/, src/llm/      in-Aseprite assistant: chat flow and AI providers
  test/                    vitest tests
  scripts/mcp-call.mjs     call one MCP tool on the running bridge (dev helper)
docs/                      PROTOCOL.md (the contract), CLIENTS.md, TROUBLESHOOTING.md
scripts/                   installers, background service, extension packaging
```

The Lua side is deliberately thin: it moves raw pixels and calls Aseprite APIs. Every pixel
algorithm lives in the bridge, where it is fast, typed and unit-tested.

## Development setup

You need Node.js **22.12 or newer** for development (the bridge itself runs on Node 20+, but the
test runner needs 22.12+), Aseprite 1.3+, and optionally the
[Claude Code](https://claude.com/claude-code) CLI for the in-Aseprite assistant.

```bash
cd bridge
npm ci
npm run dev          # tsx watch: restarts the bridge when you save a .ts file
```

Install the extension straight from your checkout (no packaging), then restart Aseprite:

```bash
scripts/dev-install-extension.sh
```

Aseprite remembers the "allow connection" answer per script path. If you already approved an
install under another folder name, set `ASEPRITE_MCP_DEV_NAME=<that name>` to reuse it.

To try a single tool against the running bridge and Aseprite:

```bash
cd bridge
node scripts/mcp-call.mjs --list
node scripts/mcp-call.mjs get_sprite_info '{}'
node scripts/mcp-call.mjs view_sprite '{}' --png /tmp/preview.png
```

## Checks

Run these before opening a pull request; CI runs the same on Linux, macOS and Windows.

```bash
cd bridge
npm run typecheck    # src and tests
npm test             # vitest
```

**Lua tests** run headless in a real Aseprite (`-b` = batch mode, no window). Use absolute paths:

```bash
# macOS (use the Steam path if you bought Aseprite on Steam:
#   ~/Library/Application Support/Steam/steamapps/common/Aseprite/Aseprite.app/Contents/MacOS/aseprite)
/Applications/Aseprite.app/Contents/MacOS/aseprite -b \
  --script-param root="$PWD/aseprite-extension" \
  --script "$PWD/aseprite-extension/tests/rpc_test.lua"
```

```powershell
# Windows
& "C:\Program Files\Aseprite\Aseprite.exe" -b `
  --script-param root="$PWD\aseprite-extension" `
  --script "$PWD\aseprite-extension\tests\rpc_test.lua"
```

Aseprite is not available on CI, so CI only checks Lua syntax (`luac5.4 -p`). Please run the
headless tests locally when you touch Lua. WebSocket code cannot run in batch mode; test it in
the real app.

**Scripts:** `shellcheck scripts/*.sh`. Keep `.ps1` files ASCII-only (Windows PowerShell 5.1 reads
files without a byte order mark in the local code page) and working in both Windows PowerShell
5.1 and PowerShell 7.

## The protocol contract

[docs/PROTOCOL.md](docs/PROTOCOL.md) defines every bridge ↔ Aseprite method, event, chat option
and instant tool. Change it together with both sides in the same pull request:
`bridge/src/aseprite/protocol.ts` and the gateway on the TypeScript side, `aseprite-extension/rpc/`
on the Lua side.

## Common changes

**A new MCP tool**

1. Add it to the matching file in `bridge/src/mcp/tools/` (or a new file exporting a
   `ToolRegistrar`, registered with one line in `tools/index.ts`).
2. The description is a prompt for the model: say what the tool does and *when* to use it, give
   every parameter a `.describe()`, and write errors the model can act on
   ("Layer 'Bg' not found. Layers: Background, AI").
3. Pixel edits go through `CanvasService`, which already handles the common target arguments
   (`layer`, `frames: "current" | "all" | number[]`, `selectionOnly`) and writes all frames as
   one undo step.
4. Put the logic in small pure functions and test them in `bridge/test/<area>.test.ts`.

**A new Aseprite RPC method**

1. Add the handler to `aseprite-extension/rpc/<area>.lua` (snake_case names are exported
   automatically by `rpc/init.lua`). Wrap mutations in `app.transaction` so they are one undo step.
2. Document it in `docs/PROTOCOL.md` and add a case to `tests/rpc_test.lua`.

**A new AI provider**

Implement `ILlmRunner` (`bridge/src/llm/LlmRunner.ts`) and register it in the provider registry.
See [bridge/src/llm/README.md](bridge/src/llm/README.md).

## Code style

- Small, single-purpose modules. Depend on interfaces (`IAsepriteGateway`, `ILlmRunner`,
  `IScriptRunner`) rather than concrete classes; only `src/index.ts` wires concrete classes.
- No premature abstraction: extract a shared helper on the third repetition, not the second.
- Comments explain **why** something is done, not what the code does.
- Strict TypeScript, ESM, relative imports end in `.js`. No new runtime dependency without
  discussing it in an issue first.
- Lua: `json.decode` returns a table-like *userdata* (never test `type(x) == "table"`) and
  numbers arrive as floats. Never open a modal `app.alert` while requests may arrive: it blocks
  Aseprite's Lua thread and every bridge request with it.
- Formatting follows [.editorconfig](.editorconfig): UTF-8, LF, 2 spaces.

## Pull requests

- One topic per pull request; small ones get reviewed fastest.
- Commit messages in the imperative mood: "Add drop_shadow tool", "Fix outline on indexed sprites".
- Add user-visible changes under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
- Screenshots or a short GIF help a lot for UI changes.

## Releasing (maintainers)

1. Set the new version everywhere it appears: `bridge/package.json`,
   `aseprite-extension/package.json`, `VERSION` in `aseprite-extension/main.lua` and the server
   version in `bridge/src/mcp/createMcpServer.ts`.
2. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD`, add a fresh empty
   `## [Unreleased]` above it and update the links at the bottom.
3. Commit, then tag and push: `git tag vx.y.z && git push origin vx.y.z`.

The [release workflow](.github/workflows/release.yml) checks that the versions match the tag,
runs the tests, and publishes a GitHub release with the extension, the bridge package and
checksums. Tags with a dash (`v1.1.0-beta.1`) become pre-releases.

## License of contributions

Aseprite MCP is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE): free
for personal, hobby, research and other noncommercial use, not for selling or other commercial
use. By opening a pull request you agree that your contribution is licensed under the same terms
and that the maintainer may also offer it under other terms, for example a commercial license.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind.
