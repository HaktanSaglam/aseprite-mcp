<div align="center">

# Aseprite MCP

**An AI pixel-art assistant that draws, edits and animates directly inside [Aseprite](https://www.aseprite.org/).**

Chat with it in a window inside Aseprite, or connect any [MCP](https://modelcontextprotocol.io) client
(Claude Code, Codex, Cursor, VS Code, Gemini CLI, …) to the same toolset.

[![CI](https://github.com/HaktanSaglam/aseprite-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/HaktanSaglam/aseprite-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Aseprite 1.3+](https://img.shields.io/badge/Aseprite-1.3%2B-7d929e)
![Node 20+](https://img.shields.io/badge/node-20%2B-339933)

<img src="docs/images/hero.png" alt="The Aseprite MCP assistant next to a sprite it drew" width="860">

</div>

## Made with it

All drawn inside Aseprite by Claude through this extension, on editable layers and frames
(no image model, no post-processing):

<p align="center">
  <img src="docs/images/cabin.png" alt="A cozy log cabin in a pine forest at dusk, 128x80" width="512">
</p>
<p align="center">
  <img src="docs/images/knight.png" alt="A 32x32 knight" width="200">
  <img src="docs/images/slime-idle.gif" alt="A 32x32 slime with a 4-frame idle animation" width="200">
</p>
<p align="center">
  <img src="docs/images/items.png" alt="Six 16x16 RPG items drawn in parallel as a matching set" width="720">
</p>

*Cabin: one Generate request (128×80, 16-bit style). Knight and slime: Generate, then Animate →
Idle. Items: one Batch request, six sprites drawn in parallel from the same palette.*

## Why

AI image generators paint blurry "pixel-style" pictures. Pixel art needs exact pixels, small
palettes, clean outlines and real layers and frames you can keep editing. Aseprite MCP gives a
language model hands inside Aseprite instead: it reads your canvas, draws on its own layer, builds
animation frames and tags, and every change is one Ctrl+Z away.

## Features

- **Text → sprite** in a chosen size, style (NES, SNES, Game Boy, PICO-8, 1-bit, HD) and palette.
- **Edit what you select**: redraw or inpaint a selection so it blends into the art around it.
- **Animate**: idle, walk, run, jump, attack, hurt, death or custom, with frame timings and tags.
- **Many at once**: 2–4 variations or a whole batch ("sword; shield; potion") drawn in parallel,
  each in its own tab; a character in 4 or 8 directions.
- **Directions from your art**: turn the sprite you drew into 4 or 8 facings. Your frame stays
  exactly as it is, the model draws the other sides from it, and left sides are mirrored from
  the right ones.
- **Animate every direction**: one click animates the down view, then matches the other facings
  to it (`walk_down`, `walk_right`, …). Or draw **in-betweens** between two key frames, or
  **continue** an animation from the frames you keep.
- **Color rules**: limit the colors (4–32), force a preset palette, or paste your own
  `#rrggbb` list; a **style reference** makes new art match another open sprite.
- **Clean up imported art**: *Import PNG* and *Normalize (unzoom)* turn upscaled or AI-generated
  "pixel art" back into real pixels on a clean grid and palette.
- **Seamless tiles**: the tile view checks the art repeated 3×3 and fixes the seams.
- **Review & fix**: the model looks at its work, scores it (`analyze_sprite` gives 0–100 and the
  concrete problems) and cleans up stray pixels, broken outlines and muddy colors.
- **Undo AI run**: everything the last run changed on your sprite, back in one click.
- **Instant tools, no AI needed**: remove background, outline, reduce colors, apply a palette,
  hue/saturation/lightness, cleanup, drop shadow, flip/rotate/shift.
- **Pick power vs. speed**: model (Fable, Opus, Sonnet, Haiku, or another provider) and effort
  (Fast, Balanced, Smart, Max) right in the chat tab.
- **Bring your own AI**: runs on your Claude subscription through Claude Code by default;
  OpenAI-compatible APIs (OpenAI, OpenRouter, Ollama, LM Studio), the Anthropic API, Codex CLI and
  Gemini CLI are supported experimentally.
- **Fast**: pixels travel as raw image bytes (a 256×256 canvas round-trips in milliseconds), the
  model gets the canvas state and a preview up front, and big structures are drawn by small sandboxed
  scripts instead of pixel lists.
- **Safe by design**: everything listens on `127.0.0.1` only, scripts run in a QuickJS sandbox,
  every AI edit is a single undo step.

## How it works

```mermaid
flowchart LR
  subgraph Aseprite
    UI[Assistant window] --- EXT[Lua extension]
  end
  EXT <-- WebSocket :7801 --> BRIDGE[Bridge · Node.js]
  BRIDGE -- MCP over HTTP :7800 --> CLIENTS[Claude Code · Codex · Cursor · VS Code · …]
  BRIDGE -- runs --> AI[Claude Code CLI · OpenAI-compatible · Anthropic API · Codex · Gemini]
  AI -- MCP tools --> BRIDGE
```

- **aseprite-extension/** — a thin Lua extension: moves raw pixels and calls Aseprite's API, and
  hosts the assistant window.
- **bridge/** — a TypeScript server: the MCP tools, all pixel algorithms (compositing, selection
  masks, effects, palettes), the chat orchestration and the AI providers.
- **docs/PROTOCOL.md** — the contract between the two.

## Quick start

Requirements: [Aseprite](https://www.aseprite.org/) 1.3 or newer, [Node.js](https://nodejs.org/) 20
or newer, and for the built-in chat the [Claude Code CLI](https://claude.com/claude-code) logged in
with your account (`claude auth login`).

```bash
git clone https://github.com/HaktanSaglam/aseprite-mcp.git
cd aseprite-mcp
./scripts/install.sh
```

On Windows: `powershell -ExecutionPolicy Bypass -File scripts\install.ps1`.

The installer builds the bridge, packages the extension and hands it to Aseprite, and offers to
register the MCP server with Claude Code and to run the bridge in the background at login
(`--service`). Without the service, start the bridge yourself and keep it running:

```bash
cd bridge && npm start
```

In Aseprite open **Edit › FX › Aseprite MCP › AI Assistant…** (also: *Generate Sprite…*, *Pixel
Tools…*, *Reconnect Bridge*). The first time, Aseprite asks whether the extension may open a
connection: tick **Don't show this specific alert again for this script** and click **Allow to
Open Connections**. The dot at the top of the window turns green once the bridge is connected.
The first PNG or GIF export asks the same way for write access: check the path and click
**Allow Write Access**.

Something not working? `node bridge/bin/aseprite-mcp.js doctor` checks every piece and says what to
fix.

## Using the assistant

| Tab | What it does |
|---|---|
| **Chat** | Talk to the model. Pick model and effort, use your selection as the area to change, one-click *Redraw selection*, *Review & fix*, *Variations*, *Repeat last* and *Undo AI run*. |
| **Generate** | Text → sprite with size, style, palette, color limit, view (front, side, ¾, top-down, isometric, seamless tile), target (new sprite / new layer / active layer), outline, variations, batches and 4/8 directions — from your prompt or from the current sprite, optionally matching a reference sprite. |
| **Animate** | Turn the current sprite into an animation: preset, frame count, frame duration, loop; new, in-betweens or continue; all directions at once. |
| **Tools** | Instant edits without AI on the active layer, all frames or just the selection, including *Normalize (unzoom)* and *Import PNG*. |
| **Settings** | AI provider, model, effort, auto-review, bridge port. |

Every AI edit lands on its own layer by default and is a single undo step.

## Use it from other AI tools

The bridge is a standard MCP server at `http://127.0.0.1:7800/mcp` (Streamable HTTP):

```bash
claude mcp add --transport http --scope user aseprite http://127.0.0.1:7800/mcp
```

See [docs/CLIENTS.md](docs/CLIENTS.md) for Codex, Cursor, VS Code, Claude Desktop, Gemini CLI and
others, or run `node bridge/bin/aseprite-mcp.js print-config <client>`.

## Tools

| Area | Tools |
|---|---|
| Sprite | `get_sprite_info` `create_sprite` `list_sprites` `select_sprite` `edit_sprite` `undo` `redo` `save_sprite` `export_sprite` |
| Pixels & drawing | `read_pixels` `write_pixels` `view_sprite` `draw_script` `pixel_art_guide` |
| Structure | `manage_layers` `manage_frames` `manage_tags` `get_selection` `set_selection` |
| Color | `get_palette` `set_palette` `get_palette_preset` `apply_palette` `reduce_colors` `replace_color` `adjust_colors` |
| Effects | `add_outline` `remove_background` `cleanup_pixels` `transform_layer` `drop_shadow` `normalize_pixel_art` `analyze_sprite` |
| Import | `import_image` |

### Pixel grids

`read_pixels` and `write_pixels` use a compact palette grid, one character per pixel:

```json
{ "palette": { "o": "#1a1c2c", "r": "#b13e53" }, "rows": [".oo.", "orro", ".oo."] }
```

### Drawing scripts

`draw_script` runs a short JavaScript program in a sandbox with pixel-exact primitives (lines,
shapes, polygons, flood fill, dithering), pixel-art helpers (hue-shifted color ramps, banded sphere
shading, outlines, mirroring, a tiny pixel font) and an animation mode that runs the script once
per frame.

## AI providers

The in-Aseprite assistant is built and tested around **Claude Code**: it runs `claude -p` with
your own Claude subscription, keeps a warm process per conversation for fast follow-ups, and sees
a preview of your canvas with every request. Other back-ends work through the same tools but are
less tested.

| Provider | How it connects | Status |
|---|---|---|
| Claude Code | `claude -p` with your Claude subscription | default, recommended |
| OpenAI-compatible | API key / base URL (OpenAI, OpenRouter, Ollama, LM Studio, …) | experimental |
| Anthropic API | `ANTHROPIC_API_KEY` | experimental |
| Codex CLI | `codex exec` with your ChatGPT login | experimental |
| Gemini CLI | `gemini` with your Google login | experimental |

Configure them in `~/.aseprite-mcp/config.json` — see [bridge/src/llm/README.md](bridge/src/llm/README.md).

## Configuration

| Env var | Default | |
|---|---|---|
| `ASEPRITE_MCP_PORT` | `7800` | MCP HTTP port |
| `ASEPRITE_WS_PORT` | `7801` | Aseprite WebSocket port |
| `ASEPRITE_REQUEST_TIMEOUT_MS` | `30000` | per Aseprite call |
| `ASEPRITE_MAX_PARALLEL` | `4` | parallel model runs (variations, batches) |
| `ASEPRITE_MCP_CONFIG` | `~/.aseprite-mcp/config.json` | provider settings |
| `CLAUDE_PATH` | `claude` | Claude Code CLI |
| `ASEPRITE_CLAUDE_WORKDIR` | `~/.aseprite-mcp/work/claude` | empty folder the CLI runs in |

## Troubleshooting

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Development

```bash
cd bridge
npm ci
npm run typecheck && npm test
npm run dev                     # bridge with auto-reload
../scripts/dev-install-extension.sh   # copy the extension into Aseprite, then restart Aseprite
```

Lua tests run headless in Aseprite:

```bash
aseprite -b --script-param root="$PWD/aseprite-extension" --script aseprite-extension/tests/rpc_test.lua
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Haktan Saglam
