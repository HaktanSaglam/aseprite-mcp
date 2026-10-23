import { oklabToOklch, parseHex, rgbToOklab } from "./color.js";

export const PALETTE_PRESET_IDS = [
  "pico8",
  "sweetie16",
  "endesga32",
  "endesga64",
  "db16",
  "db32",
  "aap64",
  "resurrect64",
  "gameboy",
  "nes",
  "1bit",
] as const;
export type PalettePresetId = (typeof PALETTE_PRESET_IDS)[number];

export interface PalettePreset {
  id: PalettePresetId;
  name: string;
  author: string;
  /** "#rrggbb", in the order the author published them. */
  colors: readonly string[];
}

// Colors are verbatim from lospec.com/palette-list/<slug>.json (slug noted per entry),
// so art made with a preset matches what artists know by that name.
const hexList = (spaceSeparated: string): string[] =>
  spaceSeparated.trim().split(/\s+/).map((c) => `#${c}`);

const PRESETS: Record<PalettePresetId, PalettePreset> = {
  // lospec: pico-8
  pico8: {
    id: "pico8",
    name: "PICO-8",
    author: "Lexaloffle Games",
    colors: hexList(`
      000000 1d2b53 7e2553 008751 ab5236 5f574f c2c3c7 fff1e8
      ff004d ffa300 ffec27 00e436 29adff 83769c ff77a8 ffccaa`),
  },
  // lospec: sweetie-16
  sweetie16: {
    id: "sweetie16",
    name: "Sweetie 16",
    author: "GrafxKid",
    colors: hexList(`
      1a1c2c 5d275d b13e53 ef7d57 ffcd75 a7f070 38b764 257179
      29366f 3b5dc9 41a6f6 73eff7 f4f4f4 94b0c2 566c86 333c57`),
  },
  // lospec: endesga-32
  endesga32: {
    id: "endesga32",
    name: "Endesga 32",
    author: "ENDESGA",
    colors: hexList(`
      be4a2f d77643 ead4aa e4a672 b86f50 733e39 3e2731 a22633
      e43b44 f77622 feae34 fee761 63c74d 3e8948 265c42 193c3e
      124e89 0099db 2ce8f5 ffffff c0cbdc 8b9bb4 5a6988 3a4466
      262b44 181425 ff0044 68386c b55088 f6757a e8b796 c28569`),
  },
  // lospec: endesga-64
  endesga64: {
    id: "endesga64",
    name: "Endesga 64",
    author: "ENDESGA",
    colors: hexList(`
      ff0040 131313 1b1b1b 272727 3d3d3d 5d5d5d 858585 b4b4b4
      ffffff c7cfdd 92a1b9 657392 424c6e 2a2f4e 1a1932 0e071b
      1c121c 391f21 5d2c28 8a4836 bf6f4a e69c69 f6ca9f f9e6cf
      edab50 e07438 c64524 8e251d ff5000 ed7614 ffa214 ffc825
      ffeb57 d3fc7e 99e65f 5ac54f 33984b 1e6f50 134c4c 0c2e44
      00396d 0069aa 0098dc 00cdf9 0cf1ff 94fdff fdd2ed f389f5
      db3ffd 7a09fa 3003d9 0c0293 03193f 3b1443 622461 93388f
      ca52c9 c85086 f68187 f5555d ea323c c42430 891e2b 571c27`),
  },
  // lospec: dawnbringer-16
  db16: {
    id: "db16",
    name: "DawnBringer 16",
    author: "DawnBringer",
    colors: hexList(`
      140c1c 442434 30346d 4e4a4e 854c30 346524 d04648 757161
      597dce d27d2c 8595a1 6daa2c d2aa99 6dc2ca dad45e deeed6`),
  },
  // lospec: dawnbringer-32
  db32: {
    id: "db32",
    name: "DawnBringer 32",
    author: "DawnBringer",
    colors: hexList(`
      000000 222034 45283c 663931 8f563b df7126 d9a066 eec39a
      fbf236 99e550 6abe30 37946e 4b692f 524b24 323c39 3f3f74
      306082 5b6ee1 639bff 5fcde4 cbdbfc ffffff 9badb7 847e87
      696a6a 595652 76428a ac3232 d95763 d77bba 8f974a 8a6f30`),
  },
  // lospec: aap-64
  aap64: {
    id: "aap64",
    name: "AAP-64",
    author: "Adigun A. Polack",
    colors: hexList(`
      060608 141013 3b1725 73172d b4202a df3e23 fa6a0a f9a31b
      ffd541 fffc40 d6f264 9cdb43 59c135 14a02e 1a7a3e 24523b
      122020 143464 285cc4 249fde 20d6c7 a6fcdb ffffff fef3c0
      fad6b8 f5a097 e86a73 bc4a9b 793a80 403353 242234 221c1a
      322b28 71413b bb7547 dba463 f4d29c dae0ea b3b9d1 8b93af
      6d758d 4a5462 333941 422433 5b3138 8e5252 ba756a e9b5a3
      e3e6ff b9bffb 849be4 588dbe 477d85 23674e 328464 5daf8d
      92dcba cdf7e2 e4d2aa c7b08b a08662 796755 5a4e44 423934`),
  },
  // lospec: resurrect-64
  resurrect64: {
    id: "resurrect64",
    name: "Resurrect 64",
    author: "Kerrie Lake",
    colors: hexList(`
      2e222f 3e3546 625565 966c6c ab947a 694f62 7f708a 9babb2
      c7dcd0 ffffff 6e2727 b33831 ea4f36 f57d4a ae2334 e83b3b
      fb6b1d f79617 f9c22b 7a3045 9e4539 cd683d e6904e fbb954
      4c3e24 676633 a2a947 d5e04b fbff86 165a4c 239063 1ebc73
      91db69 cddf6c 313638 374e4a 547e64 92a984 b2ba90 0b5e65
      0b8a8f 0eaf9b 30e1b9 8ff8e2 323353 484a77 4d65b4 4d9be6
      8fd3ff 45293f 6b3e75 905ea9 a884f3 eaaded 753c54 a24b6f
      cf657f ed8099 831c5d c32454 f04f78 f68181 fca790 fdcbb0`),
  },
  // lospec: nintendo-gameboy-bgb (the 4 DMG greens, dark → light)
  gameboy: {
    id: "gameboy",
    name: "Game Boy (DMG green)",
    author: "Nintendo / bgb",
    colors: hexList("081820 346856 88c070 e0f8d0"),
  },
  // lospec: nintendo-entertainment-system
  nes: {
    id: "nes",
    name: "NES",
    author: "Nintendo",
    colors: hexList(`
      000000 fcfcfc f8f8f8 bcbcbc 7c7c7c a4e4fc 3cbcfc 0078f8
      0000fc b8b8f8 6888fc 0058f8 0000bc d8b8f8 9878f8 6844fc
      4428bc f8b8f8 f878f8 d800cc 940084 f8a4c0 f85898 e40058
      a80020 f0d0b0 f87858 f83800 a81000 fce0a8 fca044 e45c10
      881400 f8d878 f8b800 ac7c00 503000 d8f878 b8f818 00b800
      007800 b8f8b8 58d854 00a800 006800 b8f8d8 58f898 00a844
      005800 00fcfc 00e8d8 008888 004058 f8d8f8 787878`),
  },
  "1bit": {
    id: "1bit",
    name: "1-bit",
    author: "",
    colors: ["#000000", "#ffffff"],
  },
};

export function isPalettePresetId(value: string): value is PalettePresetId {
  return (PALETTE_PRESET_IDS as readonly string[]).includes(value);
}

export function getPalettePreset(id: string): PalettePreset {
  if (!isPalettePresetId(id)) {
    throw new Error(`Unknown palette preset "${id}". Use one of: ${PALETTE_PRESET_IDS.join(", ")}`);
  }
  return PRESETS[id];
}

export function listPalettePresets(): PalettePreset[] {
  return PALETTE_PRESET_IDS.map((id) => PRESETS[id]);
}

export interface ColorRamp {
  /** Hue family ("red", "green", ..., or "neutral" for grays). */
  hue: string;
  /** Dark → light: pick neighbours for shading, the darkest for outlines. */
  colors: string[];
}

// OKLCH hue angles where each family starts; red wraps around 0°.
const HUE_FAMILIES: [number, string][] = [
  [0, "red"],
  [45, "orange"],
  [85, "yellow"],
  [125, "green"],
  [175, "cyan"],
  [235, "blue"],
  [285, "purple"],
  [320, "pink"],
  [350, "red"],
];

// Below this OKLCH chroma a color reads as gray, whatever its nominal hue.
const NEUTRAL_CHROMA = 0.035;

function hueFamily(hue: number): string {
  let name = "red";
  for (const [start, family] of HUE_FAMILIES) if (hue >= start) name = family;
  return name;
}

/**
 * Groups colors into hue families sorted dark → light. Real ramps in curated palettes
 * also shift hue, so treat these as starting points: a family with one color can borrow
 * the neighbouring family's darks and lights.
 */
export function suggestRamps(colors: readonly string[]): ColorRamp[] {
  const families = new Map<string, { hex: string; lightness: number }[]>();
  for (const hex of colors) {
    const [r, g, b, a] = parseHex(hex);
    if (a === 0) continue;
    const [L, C, h] = oklabToOklch(rgbToOklab(r, g, b));
    const family = C < NEUTRAL_CHROMA ? "neutral" : hueFamily(h);
    const list = families.get(family) ?? [];
    list.push({ hex: hex.toLowerCase(), lightness: L });
    families.set(family, list);
  }
  const order = ["neutral", ...new Set(HUE_FAMILIES.map(([, name]) => name))];
  return order
    .filter((hue) => families.has(hue))
    .map((hue) => ({
      hue,
      colors: families
        .get(hue)!
        .sort((p, q) => p.lightness - q.lightness)
        .map((c) => c.hex),
    }));
}
