import type { GuideTopic } from "../GuideTopic.js";

export const colorPalettes: GuideTopic = {
  id: "color_palettes",
  title: "Color and palettes",
  summary: "Choosing a palette (preset ids), color limits per style, contrast and value checks, material ramps in hex.",
  body: `
# Color and palettes

## Choosing a palette
- Editing existing art: get_palette first and reuse those colors; match the art's style.
- New art: either a preset (set_palette with preset, or get_palette_preset to read the
  colors and build ramps from them) or your own ramps from ramp(). Presets keep a set
  coherent and are what pixel artists actually use:
  - pico8 (16): PICO-8 fantasy console, saturated, chunky.
  - sweetie16 (16): soft, friendly, great default for small games.
  - db16 (16) / db32 (32): DawnBringer, earthy and versatile.
  - endesga32 (32) / endesga64 (64): vivid, modern indie look, built-in hue-shifted ramps.
  - aap64 (64), resurrect64 (64): large balanced palettes for detailed scenes.
  - nes (~54 usable): NES hardware colors. gameboy (4 greens). 1bit (2 colors).
- apply_palette maps finished art onto a palette (with optional dithering);
  reduce_colors lowers the count of an existing image.

## How many colors
- 16x16 sprite: 4-8 colors. 32x32 character: 8-16. 64x64: 16-24. Full scene: 24-64.
- Per material 3-5 tones; per style see the styles topic (NES 3+transparent per sprite,
  Game Boy 4 total, SNES 15+transparent per sprite).
- Two colors closer than ~8% in value and hue are one color: merge them.

## Contrast and value
- Value structure first: the character must separate from the background by value, not
  only by hue (dark character on light ground or the reverse, or a dark outline).
- Check values: imagine (or produce, on a copy) the grayscale version. The silhouette and
  the main planes must still read. luminance differences between adjacent ramp steps
  10-20%; between a figure and its background 30%+.
- Saturation is a spotlight: the focal point gets the most saturated color; backgrounds
  and large areas are desaturated. Never fill large areas with fully saturated primaries.

## Harmony
- Build ramps that share their ends: shadows of all materials drift toward the same
  blue-violet, highlights toward the same warm yellow; ramp() does this, so ramps made with
  it already harmonize.
- Analogous base hues plus one complementary accent (teal world + orange hero).
- Light color tints everything: warm light -> cool shadows; cool light -> warm shadows.

## Avoid
- Gray or black shadows (desaturated, lifeless): use hue-shifted darker colors.
- Pure white highlights everywhere; #000 outlines on soft styles; dozens of nearly equal
  colors from gradients or blurred sources.

## Ready-made ramps (dark -> light)
- Skin light: #6b3a3a #a8604f #e0956c #f2c09a #fbe3c7
- Skin dark: #2e1a1e #5a3028 #8a5236 #b8794d #d9a273
- Hair brown: #2a1a1f #4f2b26 #7a4430 #a8683f #cf955a
- Blonde: #6b4a2a #a8783a #d9aa4e #f0d27a #fff0b8
- Grass: #1f3a2e #2f6440 #4f9a4a #8ac65a #c8e88a
- Foliage dark: #142a2a #1f4a3a #2f6e44 #4f9a4a
- Stone: #2a2834 #4a4858 #6e6f80 #9a9eac #c8ccd4
- Wood: #2e1c1a #5a3424 #8a5432 #b47a48 #d8a86a
- Steel: #1f2638 #3e4a62 #6a7a92 #a8b8c8 #e8eef4
- Gold: #4a2a1a #8a5424 #d0902e #f0c050 #fff0a0
- Water: #14244a #1e4a8a #2e7ac8 #5ab0e8 #a8e0f8
- Fire: #4a1424 #a02c2c #e0602e #f8a83a #fff07a
- Purple magic: #1e1430 #45245e #7a3a96 #b05ac8 #e8a0f0
Use them directly, or call ramp(base, n) on the middle color to get a matching ramp.
`.trim(),
};
