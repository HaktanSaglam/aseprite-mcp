# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-10-23

First public release. Aseprite MCP lets Claude, or any MCP client, draw, edit and animate pixel
art directly inside Aseprite, with every change a single undo step.

### Added

- **Fast pixel protocol.** Aseprite and the bridge exchange raw image bytes, so a whole layer or
  animation travels in one message, and multi-frame edits land as one undo step. All pixel
  algorithms (compositing, selection masks, effects, color conversion) run in the typed and
  unit-tested bridge; the Lua extension stays thin.
- **30+ MCP tools**, each with a model-oriented description:
  - sprites and documents: `get_sprite_info`, `create_sprite`, `list_sprites`, `select_sprite`,
    `edit_sprite` (resize, canvas, crop, color mode, rotate, flip), `undo`, `redo`,
    `save_sprite`, `export_sprite` (PNG, GIF, sprite sheets, frames)
  - pixels and drawing: `read_pixels`, `write_pixels`, `view_sprite`, `draw_script`
  - structure: `manage_layers`, `manage_frames`, `manage_tags`, `get_selection`, `set_selection`
  - color: `get_palette`, `set_palette`, `get_palette_preset`, `apply_palette` (with dithering),
    `reduce_colors`, `replace_color`, `adjust_colors`, and 11 palette presets: PICO-8, Sweetie 16,
    ENDESGA 32 and 64, DawnBringer 16 and 32, AAP-64, Resurrect 64, Game Boy, NES and 1-bit
  - effects: `add_outline`, `remove_background`, `cleanup_pixels`, `transform_layer`,
    `drop_shadow`, `normalize_pixel_art` (detects upscaled or AI-made "pixel art", snaps it back
    to its real pixel grid and a clean palette)
  - import: `import_image` (a PNG from disk onto its own layer)
  - analysis: `analyze_sprite`, with a 0-100 quality score and up to five concrete issues
    (stray pixels, outline gaps, doubled corners, banding, pillow shading, too many colors, ...),
    each naming the tool that fixes it
  - Pixel-editing tools can target a layer, the current frame, all frames or a list of frames,
    and only the current selection.
- **`draw_script`**: the model writes a short drawing program that runs in a sandbox (QuickJS on
  WebAssembly) and draws thousands of pixels in one call, with pixel-art helpers and animation
  support. It returns a preview so the model can check its work.
- **`pixel_art_guide`**: a built-in pixel-art knowledge base (palettes, shading, outlines,
  animation) the model can consult before drawing.
- **AI Assistant inside Aseprite** (Edit > FX > Aseprite MCP > AI Assistant...) with **Chat**,
  **Generate**, **Animate**, **Tools** and **Settings** tabs:
  - model and effort selection, style, palette, canvas size, view, outline and background options
  - edit only the selected area, review-and-fix pass
  - parallel jobs: variations, batches (one sprite per item) and 4 or 8 facing directions
  - **directions from your own art**: the current sprite becomes frame 1 untouched, the model
    draws the other facings from it, and left-facing frames are mirrored from the right ones
    and then touched up
  - **animate every direction at once**: down first, then the other facings matched to it
    (`walk_down`, `walk_right`, ...), mirrored where possible
  - **in-betweens and continue**: draw frames between two key frames, or keep the first frames
    of an animation and let the model finish it
  - **color rules**: a color limit (4-32), a forced preset palette, or your own `#rrggbb` list,
    enforced after the run in one undo step
  - **style reference**: match another open sprite's palette, outlines and proportions
  - **seamless tiles**: a tile view whose preview repeats the tile 3x3 and checks the seams
  - **Undo AI run** (everything the last run changed, in one click), **Repeat last**, and
    Generate settings remembered per sprite
  - instant, non-AI tools (outline, background removal, color reduction, palette mapping,
    Normalize (unzoom), Import PNG, ...)
- **AI providers**: Claude Code with your own subscription (default), plus experimental Codex
  CLI, Gemini CLI, OpenAI-compatible APIs and the Anthropic API, configured in
  `~/.aseprite-mcp/config.json`.
- **Installation**: one-command installers (`scripts/install.sh`, `scripts/install.ps1`),
  optional background service (launchd on macOS, systemd user unit on Linux, login start on
  Windows), automatic Claude Code registration, and the `aseprite-mcp` CLI with `doctor` and
  `print-config` for Claude Code, Claude Desktop, Codex, Cursor, VS Code, Gemini CLI, Windsurf
  and Zed.
- **Documentation**: client setup, troubleshooting, protocol, contributing and security guides.
- **CI** on Linux, macOS and Windows, and tagged releases that ship the packaged extension and
  the bridge.

### Changed

- Renamed from *Claude Pixel Bridge* (private preview) to **Aseprite MCP**. The extension id is
  now `aseprite-mcp` and its menu lives under Edit > FX > Aseprite MCP; the installers offer to
  remove the old `claude-pixel-bridge` extension.

[Unreleased]: https://github.com/HaktanSaglam/aseprite-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/HaktanSaglam/aseprite-mcp/releases/tag/v1.0.0
