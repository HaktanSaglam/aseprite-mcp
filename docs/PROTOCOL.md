# Bridge ↔ Aseprite protocol (v2)

The Aseprite extension is a WebSocket **client** (Aseprite's Lua API has no server).
The bridge listens on `ws://127.0.0.1:7801` and both sides exchange JSON text frames.

```
bridge → Aseprite   {"id": 7, "method": "read_image", "params": {...}}
Aseprite → bridge   {"id": 7, "result": {...}}            or {"id": 7, "error": "message"}
either direction    {"event": "chat", ...}                 (no id: fire-and-forget)
```

MCP clients reach the bridge over Streamable HTTP (stateless):

- `http://127.0.0.1:7800/mcp` – the tools act on Aseprite's active sprite (external clients).
- `http://127.0.0.1:7800/mcp/sprite/<id>` – the same tools bound to one sprite. The in-Aseprite
  chat runs every model job on such an endpoint, so a job keeps drawing into its sprite while
  the user switches tabs and parallel jobs never collide.

The Lua side is deliberately thin: it moves pixels and calls Aseprite APIs. Every
pixel algorithm (compositing, selection masks, effects, color conversion) lives in
the bridge, where it is fast, typed and unit-tested.

## Conventions

- `sprite` (optional, every method): the `sprite.id` to act on. Omitted → active sprite.
  Lets parallel jobs keep drawing into their sprite while the user switches tabs.
- Frames are **1-based** (like the Aseprite UI). Omitted → active frame.
- Layers are addressed by name or by group path (`"Group/Layer"`). Omitted → active layer;
  when the active layer is a group, its topmost image layer (error if it has none). Results
  that name a layer (`activeLayer`, `layer`) give the full path, so passing it back
  addresses the same layer even when names repeat across groups.
- Colors are lowercase hex strings without `#`: `rrggbbaa`.
- Pixel payloads are **hex strings of raw image bytes** (`image.bytes`), no row padding:
  - `rgba`: 4 bytes per pixel (r, g, b, a)
  - `gray`: 2 bytes per pixel (value, alpha)
  - `indexed`: 1 byte per pixel (palette index)
- Every mutating method runs inside one `app.transaction`, i.e. one Ctrl+Z step.

## Methods

### Sprites

| method | params | result |
|---|---|---|
| `ping` | – | `{pong, version}` |
| `list_sprites` | – | `{sprites: SpriteSummary[]}` |
| `activate_sprite` | `sprite` | `{ok}` |
| `close_sprite` | `sprite`, `onlyIfEmpty?` (keep it if any cel has pixels) | `{closed}` |
| `get_sprite_info` | – | `SpriteInfo` |
| `create_sprite` | `width, height, colorMode?("rgb"\|"grayscale"\|"indexed"), frames?, background?` (`rrggbb`/`rrggbbaa`, validated before the sprite opens), `name?` (tab title) | `SpriteInfo` (new sprite becomes active) |
| `sprite_op` | `op` + op params (below) | `SpriteInfo` |
| `undo` / `redo` | `steps?` (default 1) | `{ok}` |
| `save_sprite` | `path?` (omitted → current filename), `copy?` | `{ok, path}` |
| `export_sprite` | `path, kind("png"\|"gif"\|"sheet"\|"frames"), scale?, frame?, tag?, sheetType?("horizontal"\|"vertical"\|"rows"\|"columns"\|"packed"), columns?, dataPath?` | `{ok, path}` |

`sprite_op` ops:
- `resize` `{width, height, method?("nearest"|"bilinear"|"rotsprite")}` – scales all layers/frames.
- `canvas` `{left?, top?, right?, bottom?}` – grows (positive) or shrinks (negative) the canvas.
- `crop` `{x, y, width, height}`
- `color_mode` `{mode: "rgb"|"grayscale"|"indexed"}`
- `rotate` `{angle: 90|180|270}` – whole sprite.
- `flip` `{direction: "horizontal"|"vertical"}` – whole sprite.

```ts
SpriteSummary = { id, filename, width, height, colorMode, frames: number, isActive }
SpriteInfo = {
  id, filename, width, height, colorMode,
  frames: [{ index, durationMs }],
  layers: [{ name, path, isGroup, isVisible, isEditable, opacity, blendMode, stackIndex, parent? }],
  tags: [{ name, from, to, direction("forward"|"reverse"|"pingpong"|"pingpong_reverse"), repeats }],
  activeFrame, activeLayer?: string /* path, e.g. "Head/Shade" */, selection?: {x, y, width, height},
  paletteSize, transparentIndex
}
```

`layers` lists every layer depth-first, bottom to top within each group (Aseprite order).

### Pixels

| method | params | result |
|---|---|---|
| `read_image` | `x?, y?, width?, height?` (default whole canvas), `frame?, layer?, flattened?, missingOk?` | `{x, y, width, height, format, data, palette?, transparentIndex?}` |
| `write_image` | `x, y, width, height, frame?, layer?, format, data` | `{ok, layer}` (layer path) |
| `write_images` | `writes: write_image params[]` | `{ok, count}` |

- `read_image` with `flattened: true` renders all visible layers and always returns `rgba`.
  Otherwise it returns the layer's cel in the sprite's color mode (`palette` +
  `transparentIndex` are included for `indexed`). Pixels outside the canvas or the cel are
  transparent. `missingOk: true` returns transparent pixels when the layer doesn't exist.
- `write_image` **replaces** every pixel of the rectangle (transparent included) on the
  layer, creating the layer (on top) when it doesn't exist; `"Group/Layer"` creates `Layer`
  inside the existing group `Group` (error naming the group if it doesn't exist). `format`
  must match the sprite's color mode. Incoming pixels outside the canvas are ignored; cel
  pixels already outside the canvas are kept. The cel is trimmed to its content
  afterwards. Locked, group and tilemap layers are rejected.
- A write to a frame whose cel is linked to other frames gives that frame its own cel
  (unlinked); the other linked frames keep the shared image unchanged.
- `write_images` applies several writes (e.g. one per animation frame) as one undo step.

### Selection

| method | params | result |
|---|---|---|
| `read_selection` | `x?, y?, width?, height?` (default: selection bounds) | `{isEmpty, bounds?, x, y, width, height, mask?}` |
| `set_selection` | `op("replace"\|"add"\|"subtract"\|"intersect"\|"all"\|"none"\|"invert"), rects?: [x, y, w, h][]` | `{isEmpty, bounds?}` |

`mask` is a string of `0`/`1` characters, row-major over the requested rectangle.
Shapes (ellipses, color/alpha masks, ...) are computed by the bridge and sent as rects
(one per horizontal run).

### Layers, frames, tags, palette

| method | params | result |
|---|---|---|
| `layer_op` | `op` + params below | `{ok, layer?}` (layer path) |
| `frame_op` | `op` + params below | `{ok, frames}` |
| `tag_op` | `op` + params below | `{ok}` |
| `get_palette` | – | `{colors: string[], transparentIndex}` |
| `set_palette` | `colors: string[]` (`rrggbb` or `rrggbbaa`) | `{ok, size}` |

`layer_op`:
- `add` `{name, group?, above?, isGroup?}` – new layer on top (or right above `above`, or inside `group`).
  A `name` like `"Group/Layer"` means `Layer` inside the existing group `Group`.
- `delete` `{name}`
- `update` `{name, newName?, visible?, opacity?(0-255), blendMode?, editable?}`
- `move` `{name, above?, below?, group?}` – `group: ""` moves it to the top level.
- `duplicate` `{name, newName?}` – copy and rename are one undo step.
- `merge_down` `{name}` – into the layer directly below in the same group; `layer` is that
  layer. Errors when there is no layer below, or when either layer is a group, tilemap or
  reference layer (Aseprite can't merge those).
- `activate` `{name}`

`frame_op`:
- `add` `{after?(default last), count?(1), copy?(false), durationMs?}` – `copy` duplicates the cels of frame `after`.
- `delete` `{from, to?}`
- `duration` `{frames?: number[] (default all), durationMs}`
- `activate` `{frame}`

`tag_op`:
- `add` `{name, from, to, direction?, repeats?, color?}`
- `update` `{name, newName?, from?, to?, direction?, repeats?}`
- `delete` `{name}`

## Events

Aseprite → bridge:

| event | fields |
|---|---|
| `hello` | `asepriteVersion, extensionVersion, protocol` |
| `chat_send` | `text, action?, options?, selection?, sprite?` |
| `chat_cancel` | – |
| `chat_reset` | – |
| `tool_run` | `requestId, tool, params, sprite?` – instant (non-AI) tools from the Tools tab |

Bridge → Aseprite:

| event | fields |
|---|---|
| `chat` | `kind: "text"\|"tool"\|"status"\|"error"\|"busy"\|"done"\|"progress"`, plus `text` / `name` / `busy` / `stats` |
| `tool_result` | `requestId, ok, text` |
| `bridge_info` | `version, providers: [{id, label, models, efforts, available, note?}]` |

## Chat contract (UI ↔ bridge)

### `chat_send`

```ts
{
  event: "chat_send",
  text: string,                      // what the user typed (may be empty for some actions)
  action?: ChatAction,               // default "chat"
  options?: ChatOptions,             // Aseprite may encode an empty table as [] – treated as {}
  selection?: Rect,                  // only when "use selection" is on and something is selected
  sprite?: number,                   // sprite.id of the active sprite when the message was sent
}

type ChatAction =
  | "chat"            // free-form request
  | "generate"        // text → new sprite (Generate tab)
  | "edit_selection"  // redraw/inpaint the selected area
  | "review"          // look at the sprite and fix pixel-art problems
  | "animate"         // turn the current sprite/frame into an animation (Animate tab)
  | "variations"      // N alternative versions in parallel (options.count)
  | "batch"           // one sprite per item in options.items, in parallel
  | "directions";     // the same character facing 4 or 8 directions (options.directions)

interface ChatOptions {
  provider?: string;                 // ProviderInfo.id: claude-code (default), codex, gemini-cli, openai, anthropic, ollama
  model?: string;                    // any id from that provider's ProviderInfo.models; default: its defaultModel
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  style?: StyleId;
  palette?: PaletteId;               // "auto" | "current" | a preset id
  size?: { width: number; height: number };   // canvas size for generate/variations/batch/directions
  target?: "new_sprite" | "new_layer" | "active_layer";
  view?: "front" | "side" | "three_quarter" | "top_down" | "isometric" | "tile";   // tile (v1.1): a seamless, tileable texture
  directions?: 4 | 8;
  count?: number;                    // variations: 2-4 (default 3); without text = variations of the open sprite
  items?: string[];                  // batch: one prompt per item; palette "auto" becomes the style's preset so the set matches
  outline?: boolean;                 // true: the style's 1px outline; false: no outline at all (overrides the style); omitted: the style's default
  background?: "transparent" | "solid";
  animation?: {
    preset: "idle" | "walk" | "run" | "jump" | "attack" | "hurt" | "death" | "custom";
    frames?: number;                 // 2-16; frames/frameMs/loop default per preset (e.g. walk 8 x 100 ms)
    frameMs?: number;                // duration per frame
    loop?: boolean;
    // v1.1
    allDirections?: boolean;         // animate every direction tag ("down", "right", ...) of the sprite; down first, the rest matched to it, left mirrored from right when present
    mode?: "new" | "between" | "continue";  // between: draw `frames` in-betweens between fromFrame and toFrame (both kept); continue: keep frames 1..keepFrames and draw the rest
    fromFrame?: number;
    toFrame?: number;
    keepFrames?: number;
  };
  autoReview?: boolean;              // one extra look-and-fix pass at the end (every action; chat only when the model changed the art)

  // v1.1 additions (all optional; omitted = v1.0 behaviour)
  source?: "prompt" | "current";     // directions/variations: start from frame 1 of `sprite` (the user's art) instead of text
  maxColors?: number;                // 2-64: hard color limit, enforced by the bridge after the run on the layers the run drew
  forcePalette?: boolean;            // snap every pixel the run drew to the chosen palette (preset, "current" or "custom") after the run
  customPalette?: string[];          // palette "custom": 2-256 colors as "#rrggbb"
  reference?: { sprite: number; frame?: number };   // style reference: another open sprite to match (palette, outline, proportions, shading); attached as an image
}

type StyleId = "auto" | "8bit" | "16bit" | "gameboy" | "pico8" | "1bit" | "hd";
type PaletteId = "auto" | "current" | "custom" | "pico8" | "sweetie16" | "endesga32" | "endesga64"
  | "db16" | "db32" | "aap64" | "resurrect64" | "gameboy" | "nes" | "1bit";
```

### `tool_run` → `tool_result`

Instant, non-AI tools from the Tools tab. The bridge calls the MCP tool of the same
name in-process, bound to `sprite`, and answers `{event: "tool_result", requestId, ok, text}`
(`requestId` is echoed as sent, string or number). Colors are `"#rrggbb"` or `"#rrggbbaa"`.
Send `{steps: 1}` rather than an empty table for undo/redo (Aseprite encodes `{}` as `[]`).
A param the tool does not take is an error (`ok: false`, naming the accepted arguments).

Tool runs execute one at a time, in the order they arrive. While an AI request draws into
`sprite` (or has not bound itself to a sprite yet, or runs with no sprite open) the bridge
answers at once with `ok: false` and "The AI is drawing on this sprite. Wait for the AI to
finish or press Stop." A `chat_send` waits for tool runs that arrived before it.

Allowed tools and their arguments (all accept the common target `layer?`,
`frames?: "current" | "all" | number[]`, `selectionOnly?: boolean`):

| tool | arguments |
|---|---|
| `remove_background` | `mode?: "edges" \| "color"`, `color?`, `tolerance?` (0-100) |
| `add_outline` | `color?` (default: darkest neighbour shade), `placement?: "outside" \| "inside"`, `connectivity?: 4 \| 8` |
| `reduce_colors` | `colors` (2-64), `dither?: "none" \| "ordered" \| "floyd"` |
| `apply_palette` | `palette` (PaletteId or `#rrggbb[]`), `dither?`, `setSpritePalette?: boolean` |
| `adjust_colors` | `hue?` (-180..180), `saturation?`, `lightness?`, `brightness?`, `contrast?` (-100..100), `invert?`, `grayscale?` |
| `replace_color` | `from`, `to`, `tolerance?` |
| `cleanup_pixels` | `minNeighbors?` (default 1: removes isolated single pixels), `noise?: "similar" \| "all" \| "off"` (default "similar": only near-identical single-pixel noise, so 1 px highlights survive) |
| `transform_layer` | `op: "flip_h" \| "flip_v" \| "rotate_90" \| "rotate_180" \| "rotate_270" \| "shift"`, `dx?`, `dy?`, `wrap?` (with `selectionOnly` the transform happens inside the selection's bounds) |
| `drop_shadow` | `dx?`, `dy?`, `color?` |
| `undo` / `redo` | `steps?` |

### `bridge_info`

Sent right after `hello` and whenever provider availability changes (the bridge re-checks
every 30 s while Aseprite is connected, e.g. after a key was added to the config file):

```ts
{ event: "bridge_info", version: string, providers: ProviderInfo[], defaultProvider: string }
ProviderInfo = { id, label, models: [{id, label}], efforts: string[], available, note?, supportsImages, defaultModel? }
```

### `chat` updates

`{event: "chat", kind, ...}`:
- `text` `{text}` – assistant text (plain, 1-3 sentences)
- `tool` `{name}` – a tool call started (UI shows a short label)
- `status` `{text}` – neutral progress ("Variation 2/4 done")
- `progress` `{done, total, label?}` – parallel jobs progress
- `error` `{text}`
- `busy` `{busy}` – a run started/finished
- `done` `{stats: {durationMs, turns?, costUsd?}}` – after a successful run

### Development only: `ui_debug`

With `ASEPRITE_MCP_DEV=1` the bridge opens a loopback endpoint (`127.0.0.1:7802`, see
`bridge/src/dev/devServer.ts`) that injects chat events and forwards
`{event: "ui_debug", action: "open"|"tab"|"set"|"click"|"close", tab?, widget?, value?}` to the window,
which answers `{event: "ui_debug_result", action, ok, error?}`. The extension ignores it unless
`devMode = true` is set in its preferences (`__pref.lua`); synthetic input can't drive Aseprite's
UI on every platform, so this is how screenshots and end-to-end tests are automated.

## v1.1 additions (contract for the next release)

- `chat` update `done`: `stats.undoSteps?: number` – how many undo steps the run added to its
  sprite. The window offers "Undo AI run", which sends `tool_run undo {steps: undoSteps}` for that sprite.
- Generate/variations/batch/directions that fail or are stopped before drawing anything close the
  sprite the bridge created for them (`close_sprite {onlyIfEmpty: true}`).
- New Lua method `frame_op` op `copy_cel {from, to, layer?, flip?: "horizontal" | "vertical"}`:
  copies one layer's cel (default: every image layer) from frame `from` to frame `to`, optionally
  mirrored, as one undo step.
- New MCP tools: `import_image {path, layer?, frame?, x?, y?}` (a PNG from disk onto a layer,
  read by the bridge) and `normalize_pixel_art {scale?: "auto" | number, maxColors?, binaryAlpha?,
  cleanup?, ...target}` (detects and removes upscaling, snaps blocks to their dominant color).
  Both are also allowed as `tool_run` instant tools.
- `analyze_sprite` adds `score` (0-100) and `issues` (up to 5, with coordinates and the tool that fixes each).
- `view_sprite {tiled?: boolean}` shows the image repeated 3x3 to check seamless tiles.
- `replace_color {pairs?: [{from, to}]}` swaps several colors in one call (one undo step).
- `write_pixels` returns a preview image like `draw_script` (`preview: false` turns it off).
- `save_sprite` only writes `.aseprite`/`.ase`; `.png`/`.gif` go through `export_sprite`.

