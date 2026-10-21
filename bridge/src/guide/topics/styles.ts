import type { GuideTopic } from "../GuideTopic.js";

export const styles: GuideTopic = {
  id: "styles",
  title: "Styles",
  summary: "What 8bit/NES, gameboy, pico8, 16bit/SNES, 1bit and HD pixel art mean concretely: sizes, colors, outlines, AA.",
  body: `
# Styles

When the user names a style, follow its constraints exactly; they ARE the look. When editing
existing art, its style wins over any preset.

| style | typical sprite | colors | outline | AA / dither | palette preset |
|---|---|---|---|---|---|
| 8bit / NES | 16x16, 16x24, 16x32 (built from 8x8) | 3 + transparent per sprite, ~54 total | black or none; shape by color blocks | none / backgrounds only | nes |
| Game Boy | 16x16 (8x16 blocks) | 4 shades total (3 + transparent for sprites) | darkest shade | none / checker dither for midtones | gameboy |
| PICO-8 | 8x8, 16x16 | fixed 16 | black or dark blue (#1d2b53) | none | pico8 |
| 16bit / SNES | 16x32, 32x32, 32x48 | 15 + transparent per sprite, 256 on screen | colored / sel-out | light manual AA, little dither | endesga32, db32, sweetie16 |
| 1bit | any | 2 | by contrast (negative space) | dither patterns for gray | 1bit |
| HD / modern | 32x48 to 64x64+ | 32-64 | sel-out or none | AA allowed, many tones | endesga64, aap64, resurrect64 |

## 8bit / NES
- Characters are chunky: big heads, 2-heads tall at 16px, few details.
- 3 colors per sprite: dark (often black outline), mid, light (skin/highlight). Extra colors
  come from overlaying a second sprite. Flat shading: one shadow tone, no gradients.
- Backgrounds: 16x16 metatiles from 8x8 tiles, 4 colors per area, strong pattern repetition.
- Screen 256x240; scenes have black skies often; no transparency effects.

## Game Boy (DMG)
- Exactly 4 values: #0f380f (darkest), #306230, #8bac0f, #9bbc0f (lightest). Shapes rely on
  value only; use the lightest as the background, the darkest for outlines and eyes.
- 50% checker dither between two adjacent values for gradients/large shading areas.
- Screen 160x144: tiles 8x8, characters 16x16.

## PICO-8
- 128x128 screen; sprites 8x8 (or 16x16 for big ones); 16 fixed colors (pico8 preset).
- Bold, saturated, simple shapes; 1-2 shading tones; black outlines optional.

## 16bit / SNES / GBA
- 32px-ish characters with 3-4 tone hue-shifted ramps per material, colored or selective
  outlines, small highlights, some manual AA on curves, 6-8 frame walk cycles.
- Backgrounds with parallax layers, gradients via bands (HDMA-style) and some dithering.

## 1bit
- Two colors only (black/white or a tinted pair). Form by silhouette, line and dither
  density: 0% -> 25% (sparse) -> 50% checker -> 75% -> 100%; dither(x, y, w, h, c, amount)
  or gradient(..., "dither") with [dark, light].
- Lots of negative space; outlines only where shapes would merge.

## HD / modern indie
- Higher resolution (64px+ characters, 480x270 scenes), large palettes, sel-out outlines or
  none, AA on curves, sub-pixel animation and many frames (8-12 walk, 12+ attack).
- Still pixel art: no blur, no gradients without bands, every cluster deliberate.

## Mapping chat options to settings
- style "auto": choose by size (16px -> 8bit/pico8 feel, 32px -> 16bit, 64px+ -> HD).
- palette "current": keep the sprite's palette; a preset id: set it first (set_palette with
  preset) and only use its colors; "auto": build ramps with ramp() and keep the count low.
`.trim(),
};
