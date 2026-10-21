# Bridge ↔ Aseprite protocol (v2)

The Aseprite extension is a WebSocket **client** (Aseprite's Lua API has no server).
The bridge listens on `ws://127.0.0.1:7801` and both sides exchange JSON text frames.

```
bridge → Aseprite   {"id": 7, "method": "read_image", "params": {...}}
Aseprite → bridge   {"id": 7, "result": {...}}            or {"id": 7, "error": "message"}
either direction    {"event": "chat", ...}                 (no id: fire-and-forget)
```

The Lua side is deliberately thin: it moves pixels and calls Aseprite APIs. Every
pixel algorithm (compositing, selection masks, effects, color conversion) lives in
the bridge, where it is fast, typed and unit-tested.

## Conventions

- `sprite` (optional, every method): the `sprite.id` to act on. Omitted → active sprite.
  Lets parallel jobs keep drawing into their sprite while the user switches tabs.
- Frames are **1-based** (like the Aseprite UI). Omitted → active frame.
- Layers are addressed by name or by group path (`"Group/Layer"`). Omitted → active layer.
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
| `get_sprite_info` | – | `SpriteInfo` |
| `create_sprite` | `width, height, colorMode?("rgb"\|"grayscale"\|"indexed"), frames?, background?` | `SpriteInfo` (new sprite becomes active) |
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
  activeFrame, activeLayer?, selection?: {x, y, width, height},
  paletteSize, transparentIndex
}
```

`layers` lists every layer depth-first, bottom to top within each group (Aseprite order).

### Pixels

| method | params | result |
|---|---|---|
| `read_image` | `x?, y?, width?, height?` (default whole canvas), `frame?, layer?, flattened?, missingOk?` | `{x, y, width, height, format, data, palette?, transparentIndex?}` |
| `write_image` | `x, y, width, height, frame?, layer?, format, data` | `{ok, layer}` |
| `write_images` | `writes: write_image params[]` | `{ok, count}` |

- `read_image` with `flattened: true` renders all visible layers and always returns `rgba`.
  Otherwise it returns the layer's cel in the sprite's color mode (`palette` +
  `transparentIndex` are included for `indexed`). Pixels outside the canvas or the cel are
  transparent. `missingOk: true` returns transparent pixels when the layer doesn't exist.
- `write_image` **replaces** every pixel of the rectangle (transparent included) on the
  layer, creating the layer (on top) when it doesn't exist. `format` must match the
  sprite's color mode. Pixels outside the canvas are ignored. The cel is trimmed to its
  content afterwards. Locked, group and tilemap layers are rejected.
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
| `layer_op` | `op` + params below | `{ok, layer?}` |
| `frame_op` | `op` + params below | `{ok, frames}` |
| `tag_op` | `op` + params below | `{ok}` |
| `get_palette` | – | `{colors: string[], transparentIndex}` |
| `set_palette` | `colors: string[]` (`rrggbb` or `rrggbbaa`) | `{ok, size}` |

`layer_op`:
- `add` `{name, group?, above?, isGroup?}` – new layer on top (or right above `above`, or inside `group`).
- `delete` `{name}`
- `update` `{name, newName?, visible?, opacity?(0-255), blendMode?, editable?}`
- `move` `{name, above?, below?, group?}` – `group: ""` moves it to the top level.
- `duplicate` `{name, newName?}`
- `merge_down` `{name}`
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
