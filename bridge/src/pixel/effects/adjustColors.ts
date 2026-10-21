import { clampByte, hslToRgb, packRgb, rgbToHsl, type Rgb } from "../color.js";
import { cloneImage, type RgbaImage } from "../RgbaImage.js";

export interface ColorAdjustments {
  /** Degrees, -180..180. */
  hue?: number;
  /** -100..100: -100 removes all saturation, +100 saturates fully. */
  saturation?: number;
  /** -100..100: -100 is black, +100 is white (HSL lightness). */
  lightness?: number;
  /** -100..100: adds/removes the same amount to every channel. */
  brightness?: number;
  /** -100..100: pushes channels away from / toward mid gray. */
  contrast?: number;
  invert?: boolean;
  grayscale?: boolean;
}

export function hasAdjustments(adj: ColorAdjustments): boolean {
  return Boolean(
    adj.hue || adj.saturation || adj.lightness || adj.brightness || adj.contrast || adj.invert || adj.grayscale,
  );
}

/** Moves v (0..1) toward 0 for negative amounts and toward 1 for positive ones. */
function scaleToward(v: number, amount: number): number {
  const t = Math.max(-100, Math.min(100, amount)) / 100;
  return t < 0 ? v * (1 + t) : v + (1 - v) * t;
}

/**
 * Applies the adjustments in a fixed, predictable order: invert → hue/saturation/
 * lightness (HSL, like Aseprite's Hue/Saturation) → brightness → contrast → grayscale.
 */
export function adjustColor(r: number, g: number, b: number, adj: ColorAdjustments): Rgb {
  let rgb: Rgb = [r, g, b];
  if (adj.invert) rgb = [255 - rgb[0], 255 - rgb[1], 255 - rgb[2]];
  if (adj.hue || adj.saturation || adj.lightness) {
    const [h, s, l] = rgbToHsl(...rgb);
    rgb = hslToRgb(h + (adj.hue ?? 0), scaleToward(s, adj.saturation ?? 0), scaleToward(l, adj.lightness ?? 0));
  }
  if (adj.brightness) {
    const offset = (Math.max(-100, Math.min(100, adj.brightness)) / 100) * 255;
    rgb = [clampByte(rgb[0] + offset), clampByte(rgb[1] + offset), clampByte(rgb[2] + offset)];
  }
  if (adj.contrast) {
    // Classic contrast curve: factor 0 at -100 (flat gray), ~130 at +100 (posterized).
    const c = (Math.max(-100, Math.min(100, adj.contrast)) / 100) * 255;
    const factor = (259 * (c + 255)) / (255 * (259 - c));
    rgb = [
      clampByte(factor * (rgb[0] - 128) + 128),
      clampByte(factor * (rgb[1] - 128) + 128),
      clampByte(factor * (rgb[2] - 128) + 128),
    ];
  }
  if (adj.grayscale) {
    // Rec. 601 luma: the same weights the bridge uses when writing grayscale sprites.
    const v = clampByte(0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]);
    rgb = [v, v, v];
  }
  return rgb;
}

/** Adjusts every visible pixel; alpha is kept. Returns how many pixels changed. */
export function adjustColors(image: RgbaImage, adj: ColorAdjustments): { image: RgbaImage; changed: number } {
  const out = cloneImage(image);
  const data = out.data;
  const cache = new Map<number, Rgb>();
  let changed = 0;
  for (let o = 0; o < data.length; o += 4) {
    if (data[o + 3] === 0) continue;
    const key = packRgb(data[o], data[o + 1], data[o + 2]);
    let rgb = cache.get(key);
    if (!rgb) {
      rgb = adjustColor(data[o], data[o + 1], data[o + 2], adj);
      cache.set(key, rgb);
    }
    if (rgb[0] === data[o] && rgb[1] === data[o + 1] && rgb[2] === data[o + 2]) continue;
    data[o] = rgb[0];
    data[o + 1] = rgb[1];
    data[o + 2] = rgb[2];
    changed++;
  }
  return { image: out, changed };
}
