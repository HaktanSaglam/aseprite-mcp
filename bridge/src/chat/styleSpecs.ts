import type { PresetPaletteId, StyleId } from "./chatSchema.js";

export interface StyleSpec {
  label: string;
  /** Concrete, checkable constraints: a model follows numbers far better than adjectives. */
  rules: string[];
  /** Outline rule when the user didn't choose one. */
  outline: string;
  /** How many colors to pick when the palette is "auto". */
  autoColors: string;
  /** Shared palette for parallel batch items when the palette is "auto", so the set matches. */
  setPalette: PresetPaletteId;
  /** Colors the style itself fixes; a matching palette preset then needs no lookup. */
  fixedPalette?: PresetPaletteId;
}

const PICO8_COLORS =
  "#000000 #1d2b53 #7e2553 #008751 #ab5236 #5f574f #c2c3c7 #fff1e8 " +
  "#ff004d #ffa300 #ffec27 #00e436 #29adff #83769c #ff77a8 #ffccaa";

export const STYLE_SPECS: Record<StyleId, StyleSpec> = {
  auto: {
    label: "clean, modern pixel art",
    rules: [
      "Pick the level of detail from the canvas size (see Detail).",
      "Limited palette built from hue-shifted ramps; flat colors only, no gradients or noise.",
      "No anti-aliasing at 32 px and below; at 64 px and above, manual AA only on long curves.",
    ],
    outline: "1px dark outline around the subject; selective outline (a darker shade of the adjacent fill) reads better than pure black",
    autoColors: "8-24",
    setPalette: "endesga32",
  },
  "8bit": {
    label: "8-bit NES style",
    rules: [
      "At most 3 visible colors per sprite part plus transparency (4 including transparent), like NES sprite palettes; a large subject may combine 2-3 such parts.",
      "Chunky, readable shapes; no anti-aliasing, no gradients; at most one shade step per color; dithering only as simple checker patterns.",
      "Black or near-black outline around everything.",
    ],
    outline: "solid 1px black (#000000) or near-black outline",
    autoColors: "8-12 NES-like",
    setPalette: "nes",
  },
  "16bit": {
    label: "16-bit SNES/Genesis style",
    rules: [
      "16-32 colors in total, organised as 3-5 step ramps per material.",
      "Hue-shift every ramp: shadows cooler (toward blue/purple), highlights warmer (toward yellow); never just darker/lighter of one hue.",
      "Clear light source from the top-left with form shading, cast shadows and a little rim light.",
      "Light anti-aliasing on large curves only; dithering sparingly, for texture or soft transitions.",
    ],
    outline: "selective outline (sel-out): a darker shade of each adjacent fill, lighter on the lit side, darkest at the bottom",
    autoColors: "16-32",
    setPalette: "endesga32",
  },
  gameboy: {
    label: "original Game Boy (DMG)",
    rules: [
      "Exactly 4 colors, all greens: #0f380f (darkest), #306230, #8bac0f, #9bbc0f (lightest); transparency allowed. No other color anywhere.",
      "High contrast: darkest for outlines and deep shadows, lightest for highlights; dithering patterns for in-between tones.",
      "No anti-aliasing.",
    ],
    outline: "1px outline in #0f380f",
    autoColors: "exactly 4",
    setPalette: "gameboy",
    fixedPalette: "gameboy",
  },
  pico8: {
    label: "PICO-8 fantasy console",
    rules: [
      `Only the 16 PICO-8 colors: ${PICO8_COLORS}. No others.`,
      "Bold flat colors, 1-2 shade shading, crisp 1px details; keep shapes as simple as an 8x8/16x16 PICO-8 sprite even on a larger canvas.",
    ],
    outline: "1px outline in #000000 or #1d2b53 where it helps readability",
    autoColors: "PICO-8 only",
    setPalette: "pico8",
    fixedPalette: "pico8",
  },
  "1bit": {
    label: "1-bit (two colors)",
    rules: [
      "Exactly 2 colors: #000000 and #ffffff (plus transparency). No grays, no other colors.",
      "Express light, tone and texture with dithering patterns, hatching and line weight; keep silhouettes bold.",
    ],
    outline: "outline in whichever of the two colors contrasts with what is behind it",
    autoColors: "exactly 2",
    setPalette: "1bit",
    fixedPalette: "1bit",
  },
  hd: {
    label: "detailed modern HD pixel art",
    rules: [
      "32-64 colors with long hue-shifted ramps (5-7 steps per material).",
      "Manual anti-aliasing on curves and edges, sub-pixel details, texture from clustered pixels (never noise).",
      "Rim light and bounce light, soft cast shadows, strong contrast on the focal point.",
    ],
    outline: "selective, colored outline (darker than the fill, lighter on the lit side) instead of black",
    autoColors: "32-64",
    setPalette: "endesga64",
  },
};

export const PALETTE_LABELS: Record<PresetPaletteId, string> = {
  pico8: "PICO-8",
  sweetie16: "Sweetie 16",
  endesga32: "ENDESGA 32",
  endesga64: "ENDESGA 64",
  db16: "DawnBringer 16",
  db32: "DawnBringer 32",
  aap64: "AAP-64",
  resurrect64: "Resurrect 64",
  gameboy: "Game Boy (4 greens)",
  nes: "NES",
  "1bit": "1-bit black and white",
};

/** How much detail fits: the most common way models fail is cramming 64 px of detail into 16 px. */
export function detailForSize(width: number, height: number): string {
  const side = Math.max(width, height);
  if (side <= 16) return "Tiny canvas: icon level. Every pixel counts; 2-3 shades per color; suggest details with single pixels.";
  if (side <= 32) return "Small sprite: strong silhouette, 3-4 shade ramps, clean 1px lines, a few deliberate details (eyes, highlights, one accent).";
  if (side <= 64) return "Medium sprite: room for form shading, texture clusters, facial features and material contrast.";
  if (side <= 128) return "Large sprite: detailed rendering, several materials, secondary light, manual AA on curves.";
  return "Very large canvas: a scene or illustration. Build it back to front in layers with draw_script; spend detail where the eye goes.";
}
