import { parseColor } from "./PixelGridCodec.js";

/** 0-255 per channel, straight alpha. */
export type Rgba = [number, number, number, number];
export type Rgb = [number, number, number];
/** OKLab: L in 0..1 (black..white), a/b roughly -0.4..0.4. */
export type Lab = [number, number, number];
/** OKLCH: L 0..1, chroma >= 0, hue in degrees 0..360. */
export type Lch = [number, number, number];

/**
 * Pixel art treats alpha as on/off. Everything that needs "is this pixel drawn?"
 * (outlines, orphans, quantizing) uses this one threshold so the tools agree.
 */
export const OPAQUE_THRESHOLD = 128;

export function isOpaque(alpha: number): boolean {
  return alpha >= OPAQUE_THRESHOLD;
}

/** Accepts #rgb, #rrggbb, #rrggbbaa (with or without '#') and "transparent". */
export function parseHex(value: string): Rgba {
  return parseColor(value);
}

/** "#rrggbb", or "#rrggbbaa" when the color is not fully opaque. */
export function formatHex(r: number, g: number, b: number, a = 255): string {
  const hex = (n: number) => clampByte(n).toString(16).padStart(2, "0");
  return a >= 255 ? `#${hex(r)}${hex(g)}${hex(b)}` : `#${hex(r)}${hex(g)}${hex(b)}${hex(a)}`;
}

export function clampByte(n: number): number {
  return n <= 0 ? 0 : n >= 255 ? 255 : Math.round(n);
}

/** 24-bit key for maps and caches. */
export function packRgb(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

export function unpackRgb(key: number): Rgb {
  return [(key >> 16) & 255, (key >> 8) & 255, key & 255];
}

// --- HSL / HSV (h in degrees 0..360, s/l/v in 0..1) -------------------------------

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  return [hueOf(rn, gn, bn, max, d), Math.min(1, s), l];
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  return chromaToRgb(h, c, l - c / 2);
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const d = max - Math.min(rn, gn, bn);
  if (d === 0) return [0, 0, max];
  return [hueOf(rn, gn, bn, max, d), d / max, max];
}

export function hsvToRgb(h: number, s: number, v: number): Rgb {
  const c = v * s;
  return chromaToRgb(h, c, v - c);
}

function hueOf(r: number, g: number, b: number, max: number, d: number): number {
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return normalizeHue(h * 60);
}

function chromaToRgb(h: number, c: number, m: number): Rgb {
  const hp = normalizeHue(h) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [clampByte((rgb[0] + m) * 255), clampByte((rgb[1] + m) * 255), clampByte((rgb[2] + m) * 255)];
}

export function normalizeHue(h: number): number {
  const n = h % 360;
  return n < 0 ? n + 360 : n;
}

// --- OKLab (Björn Ottosson): perceptually uniform, so distances match what eyes see ---

const LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return v * 255;
}

export function rgbToOklab(r: number, g: number, b: number): Lab {
  const lr = LINEAR[r];
  const lg = LINEAR[g];
  const lb = LINEAR[b];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Linear sRGB, unclamped: values outside 0..1 mean the color is out of gamut. */
function oklabToLinear(L: number, a: number, b: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Clamps to the sRGB gamut and rounds to bytes. */
export function oklabToRgb(L: number, a: number, b: number): Rgb {
  const lin = oklabToLinear(L, a, b);
  return [
    clampByte(linearToSrgb(Math.max(0, lin[0]))),
    clampByte(linearToSrgb(Math.max(0, lin[1]))),
    clampByte(linearToSrgb(Math.max(0, lin[2]))),
  ];
}

export function oklabInGamut(L: number, a: number, b: number): boolean {
  const eps = 1e-4;
  return oklabToLinear(L, a, b).every((c) => c >= -eps && c <= 1 + eps);
}

export function oklabToOklch([L, a, b]: Lab): Lch {
  const C = Math.hypot(a, b);
  return [L, C, C < 1e-9 ? 0 : normalizeHue((Math.atan2(b, a) * 180) / Math.PI)];
}

export function oklchToOklab([L, C, h]: Lch): Lab {
  const rad = (h * Math.PI) / 180;
  return [L, C * Math.cos(rad), C * Math.sin(rad)];
}

/**
 * OKLCH → sRGB, lowering chroma until the color fits. Keeps lightness and hue, which is
 * what matters for a shade (plain clamping would shift the hue of saturated colors).
 */
export function oklchToRgb(lch: Lch): Rgb {
  const [L, C, h] = lch;
  const lightness = Math.min(1, Math.max(0, L));
  if (oklabInGamut(...oklchToOklab([lightness, C, h]))) return oklabToRgb(...oklchToOklab([lightness, C, h]));
  let lo = 0;
  let hi = C;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (oklabInGamut(...oklchToOklab([lightness, mid, h]))) lo = mid;
    else hi = mid;
  }
  return oklabToRgb(...oklchToOklab([lightness, lo, h]));
}

/** Euclidean distance in OKLab: ~0.02 is barely visible, black↔white is 1. */
export function labDistance(p: Lab, q: Lab): number {
  return Math.sqrt((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2);
}

export function colorDistance(p: Rgb | Rgba, q: Rgb | Rgba): number {
  return labDistance(rgbToOklab(p[0], p[1], p[2]), rgbToOklab(q[0], q[1], q[2]));
}

/**
 * User-facing tolerance 0..100 → OKLab distance. The curve is steeper at the top so
 * low values give fine control: 0 exact, 10 ≈ noise/compression (0.03),
 * 25 ≈ neighbouring shades (0.125), 50 ≈ broad (0.35), 100 matches everything.
 */
export function toleranceToDistance(tolerance: number): number {
  if (tolerance <= 0) return 0;
  if (tolerance >= 100) return Number.POSITIVE_INFINITY;
  return (tolerance / 100) ** 1.5;
}

/** Memoized RGB → OKLab; images reuse few colors, so this skips most cube roots. */
export function oklabCache(): (r: number, g: number, b: number) => Lab {
  const cache = new Map<number, Lab>();
  return (r, g, b) => {
    const key = packRgb(r, g, b);
    let lab = cache.get(key);
    if (!lab) {
      lab = rgbToOklab(r, g, b);
      cache.set(key, lab);
    }
    return lab;
  };
}

// Shadows lean toward blue-violet: the classic pixel-art "hue shift" instead of plain black mixing.
const SHADOW_HUE = 275;

/**
 * A darker, hue-shifted shade of a color, as a pixel artist would pick for an outline or
 * shadow. `amount` 0..1: how much lightness to remove. Near-grays stay neutral so
 * monochrome art doesn't gain a tint.
 */
export function darkerShade(rgb: Rgb | Rgba, amount = 0.6): Rgb {
  const [L, C, h] = oklabToOklch(rgbToOklab(rgb[0], rgb[1], rgb[2]));
  const lightness = L * (1 - amount);
  if (C < 0.03) return oklchToRgb([lightness, C, h]);
  const toward = ((SHADOW_HUE - h + 540) % 360) - 180;
  const shift = Math.sign(toward) * Math.min(Math.abs(toward), 25 * amount);
  return oklchToRgb([lightness, C * (1 - 0.25 * amount), normalizeHue(h + shift)]);
}
