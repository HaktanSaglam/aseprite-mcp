import {
  formatHex,
  isOpaque,
  packRgb,
  parseHex,
  rgbToOklab,
  type Lab,
  type Rgb,
} from "./color.js";
import { createRgbaImage, type RgbaImage } from "./RgbaImage.js";

export const DITHER_MODES = ["none", "ordered", "floyd"] as const;
export type DitherMode = (typeof DITHER_MODES)[number];

/** Image-coordinate predicate: should this pixel take part? */
export type PixelInclude = (x: number, y: number) => boolean;

// Quantizing and mapping both snap alpha: pixel art has no partial transparency, and
// indexed sprites cannot store it anyway. alpha < 128 → fully transparent, else opaque.

/** Returns a copy where every pixel is fully transparent (0,0,0,0) or fully opaque. */
export function binarizeAlpha(image: RgbaImage): RgbaImage {
  const out = createRgbaImage(image.width, image.height);
  const src = image.data;
  for (let o = 0; o < src.length; o += 4) {
    if (!isOpaque(src[o + 3])) continue;
    out.data[o] = src[o];
    out.data[o + 1] = src[o + 1];
    out.data[o + 2] = src[o + 2];
    out.data[o + 3] = 255;
  }
  return out;
}

// --- Palette extraction --------------------------------------------------------------

interface ColorEntry {
  rgb: Rgb;
  lab: Lab;
  count: number;
}

// Above this many distinct colors (photos, AI renders) colors are pre-merged into 15-bit
// buckets: k-means cost grows with entries × palette size, and the eye can't tell the difference.
const MAX_ENTRIES = 16384;
const KMEANS_ITERATIONS = 6;

function histogram(images: readonly RgbaImage[], include?: PixelInclude): ColorEntry[] {
  const counts = new Map<number, number>();
  for (const image of images) {
    const d = image.data;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const o = (y * image.width + x) * 4;
        if (!isOpaque(d[o + 3]) || (include && !include(x, y))) continue;
        const key = packRgb(d[o], d[o + 1], d[o + 2]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  if (counts.size > MAX_ENTRIES) return bucketed(counts);
  return [...counts].map(([key, count]) => {
    const rgb: Rgb = [(key >> 16) & 255, (key >> 8) & 255, key & 255];
    return { rgb, lab: rgbToOklab(...rgb), count };
  });
}

function bucketed(counts: Map<number, number>): ColorEntry[] {
  const sums = new Map<number, [number, number, number, number]>();
  for (const [key, count] of counts) {
    const r = (key >> 16) & 255;
    const g = (key >> 8) & 255;
    const b = key & 255;
    const bucket = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const s = sums.get(bucket) ?? [0, 0, 0, 0];
    s[0] += r * count;
    s[1] += g * count;
    s[2] += b * count;
    s[3] += count;
    sums.set(bucket, s);
  }
  return [...sums.values()].map(([r, g, b, count]) => {
    const rgb: Rgb = [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
    return { rgb, lab: rgbToOklab(...rgb), count };
  });
}

function sqDist(p: Lab, q: Lab): number {
  return (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
}

function weightedMean(entries: readonly ColorEntry[]): Lab {
  let total = 0;
  const sum: Lab = [0, 0, 0];
  for (const e of entries) {
    total += e.count;
    for (let c = 0; c < 3; c++) sum[c] += e.lab[c] * e.count;
  }
  return [sum[0] / total, sum[1] / total, sum[2] / total];
}

interface Box {
  entries: ColorEntry[];
  error: number;
}

function makeBox(entries: ColorEntry[]): Box {
  const mean = weightedMean(entries);
  let error = 0;
  for (const e of entries) error += e.count * sqDist(e.lab, mean);
  return { entries, error };
}

/** Splits at the weighted median of the axis with the largest spread. */
function splitBox(box: Box): [Box, Box] {
  const mean = weightedMean(box.entries);
  const variance = [0, 0, 0];
  for (const e of box.entries) for (let c = 0; c < 3; c++) variance[c] += e.count * (e.lab[c] - mean[c]) ** 2;
  const axis = variance.indexOf(Math.max(...variance));
  const sorted = [...box.entries].sort((p, q) => p.lab[axis] - q.lab[axis] || p.count - q.count);
  const total = sorted.reduce((sum, e) => sum + e.count, 0);
  let acc = 0;
  let cut = 1;
  for (let i = 0; i < sorted.length - 1; i++) {
    acc += sorted[i].count;
    cut = i + 1;
    if (acc >= total / 2) break;
  }
  return [makeBox(sorted.slice(0, cut)), makeBox(sorted.slice(cut))];
}

function nearestIndex(lab: Lab, centers: readonly Lab[]): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < centers.length; i++) {
    const d = sqDist(lab, centers[i]);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * Picks at most `maxColors` representative colors of the opaque pixels, darkest first.
 * Median cut in OKLab seeds a few k-means rounds; each cluster then snaps to its most
 * central *existing* color, so pixel art keeps the artist's own colors instead of muddy
 * averages. Deterministic: the same pixels always give the same palette. Several images
 * (e.g. animation frames) share one palette so frames don't flicker.
 */
export function extractPalette(
  images: readonly RgbaImage[],
  maxColors: number,
  include?: PixelInclude,
): string[] {
  if (!Number.isInteger(maxColors) || maxColors < 1) throw new Error("maxColors must be a positive integer");
  const entries = histogram(images, include);
  if (entries.length === 0) return [];

  let chosen: ColorEntry[];
  if (entries.length <= maxColors) {
    chosen = entries;
  } else {
    const boxes = [makeBox(entries)];
    while (boxes.length < maxColors) {
      let target = -1;
      for (let i = 0; i < boxes.length; i++) {
        if (boxes[i].entries.length > 1 && (target < 0 || boxes[i].error > boxes[target].error)) target = i;
      }
      if (target < 0) break;
      boxes.splice(target, 1, ...splitBox(boxes[target]));
    }
    chosen = refineAndSnap(entries, boxes.map((b) => weightedMean(b.entries)));
  }
  return chosen
    .sort((p, q) => p.lab[0] - q.lab[0] || p.lab[1] - q.lab[1] || p.lab[2] - q.lab[2])
    .map((e) => formatHex(...e.rgb));
}

function refineAndSnap(entries: readonly ColorEntry[], seeds: Lab[]): ColorEntry[] {
  let centers = seeds;
  let assignment = new Int32Array(entries.length);
  for (let iteration = 0; iteration < KMEANS_ITERATIONS; iteration++) {
    assignment = Int32Array.from(entries, (e) => nearestIndex(e.lab, centers));
    const sums = centers.map(() => [0, 0, 0, 0]);
    entries.forEach((e, i) => {
      const s = sums[assignment[i]];
      s[0] += e.lab[0] * e.count;
      s[1] += e.lab[1] * e.count;
      s[2] += e.lab[2] * e.count;
      s[3] += e.count;
    });
    // An emptied cluster keeps its old center; it simply contributes no color at the end.
    centers = centers.map((center, k) => {
      const s = sums[k];
      return s[3] > 0 ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : center;
    });
  }
  assignment = Int32Array.from(entries, (e) => nearestIndex(e.lab, centers));

  const best = new Map<number, ColorEntry>();
  entries.forEach((e, i) => {
    const k = assignment[i];
    const current = best.get(k);
    if (!current) {
      best.set(k, e);
      return;
    }
    const d = sqDist(e.lab, centers[k]);
    const dc = sqDist(current.lab, centers[k]);
    if (d < dc || (d === dc && e.count > current.count)) best.set(k, e);
  });
  return [...best.values()];
}

// --- Mapping onto a palette ----------------------------------------------------------

// 4x4 Bayer matrix: the regular ordered-dither pattern pixel artists use for gradients.
const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

interface PaletteColor {
  rgb: Rgb;
  lab: Lab;
}

function preparePalette(palette: readonly string[]): PaletteColor[] {
  const colors: PaletteColor[] = [];
  const seen = new Set<number>();
  for (const hex of palette) {
    const [r, g, b, a] = parseHex(hex);
    // Fully transparent entries (an indexed sprite's transparent slot) are not paint colors.
    if (a === 0) continue;
    const key = packRgb(r, g, b);
    if (seen.has(key)) continue;
    seen.add(key);
    colors.push({ rgb: [r, g, b], lab: rgbToOklab(r, g, b) });
  }
  if (colors.length === 0) throw new Error("The palette has no opaque colors to map to");
  return colors;
}

/** The two closest palette colors and how far (0..0.5) the color sits from the first toward the second. */
function nearestPair(lab: Lab, palette: readonly PaletteColor[]): [number, number, number] {
  let i1 = 0;
  let i2 = 0;
  let d1 = Number.POSITIVE_INFINITY;
  let d2 = Number.POSITIVE_INFINITY;
  for (let i = 0; i < palette.length; i++) {
    const d = sqDist(lab, palette[i].lab);
    if (d < d1) {
      i2 = i1;
      d2 = d1;
      i1 = i;
      d1 = d;
    } else if (d < d2) {
      i2 = i;
      d2 = d;
    }
  }
  if (i1 === i2 || d2 === Number.POSITIVE_INFINITY) return [i1, i1, 0];
  const p = palette[i1].lab;
  const q = palette[i2].lab;
  const v = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const len = v[0] ** 2 + v[1] ** 2 + v[2] ** 2;
  if (len === 0) return [i1, i1, 0];
  const t = ((lab[0] - p[0]) * v[0] + (lab[1] - p[1]) * v[1] + (lab[2] - p[2]) * v[2]) / len;
  return [i1, i2, Math.min(1, Math.max(0, t))];
}

/**
 * Redraws every opaque pixel with the nearest palette color (OKLab distance).
 * - "none": flat nearest color.
 * - "ordered": Bayer 4x4 mix of the two nearest colors, the tidy pattern pixel artists
 *   use for gradients; colors that match a palette entry exactly are never dithered.
 * - "floyd": Floyd–Steinberg error diffusion (serpentine) for smooth photo-like
 *   gradients; error never leaks into transparent pixels.
 * Alpha is snapped (see binarizeAlpha).
 */
export function mapToPalette(image: RgbaImage, palette: readonly string[], dither: DitherMode = "none"): RgbaImage {
  const colors = preparePalette(palette);
  if (dither === "floyd") return floydSteinberg(image, colors);

  const out = createRgbaImage(image.width, image.height);
  const src = image.data;
  const cache = new Map<number, [number, number, number]>();
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const o = (y * image.width + x) * 4;
      if (!isOpaque(src[o + 3])) continue;
      const key = packRgb(src[o], src[o + 1], src[o + 2]);
      let pair = cache.get(key);
      if (!pair) {
        pair = nearestPair(rgbToOklab(src[o], src[o + 1], src[o + 2]), colors);
        cache.set(key, pair);
      }
      const [i1, i2, t] = pair;
      const index = dither === "ordered" && t > (BAYER_4[y & 3][x & 3] + 0.5) / 16 ? i2 : i1;
      out.data.set(colors[index].rgb, o);
      out.data[o + 3] = 255;
    }
  }
  return out;
}

function floydSteinberg(image: RgbaImage, colors: readonly PaletteColor[]): RgbaImage {
  const { width, height } = image;
  const src = image.data;
  const out = createRgbaImage(width, height);
  const work = new Float64Array(width * height * 3);
  const opaque = new Uint8Array(width * height);
  const labs = colors.map((c) => c.lab);
  for (let i = 0; i < width * height; i++) {
    if (!isOpaque(src[i * 4 + 3])) continue;
    opaque[i] = 1;
    work.set(rgbToOklab(src[i * 4], src[i * 4 + 1], src[i * 4 + 2]), i * 3);
  }

  const spread = (x: number, y: number, err: Lab, weight: number) => {
    if (x < 0 || x >= width || y >= height) return;
    const i = y * width + x;
    if (!opaque[i]) return;
    for (let c = 0; c < 3; c++) work[i * 3 + c] += err[c] * weight;
  };

  for (let y = 0; y < height; y++) {
    // Serpentine scan: alternating direction avoids the diagonal "worms" of plain FS.
    const dir = y % 2 === 0 ? 1 : -1;
    for (let step = 0; step < width; step++) {
      const x = dir === 1 ? step : width - 1 - step;
      const i = y * width + x;
      if (!opaque[i]) continue;
      // Clamping keeps accumulated error from overshooting into impossible colors.
      const lab: Lab = [
        Math.min(1, Math.max(0, work[i * 3])),
        Math.min(0.5, Math.max(-0.5, work[i * 3 + 1])),
        Math.min(0.5, Math.max(-0.5, work[i * 3 + 2])),
      ];
      const index = nearestIndex(lab, labs);
      const chosen = colors[index];
      out.data.set(chosen.rgb, i * 4);
      out.data[i * 4 + 3] = 255;
      const err: Lab = [lab[0] - chosen.lab[0], lab[1] - chosen.lab[1], lab[2] - chosen.lab[2]];
      spread(x + dir, y, err, 7 / 16);
      spread(x - dir, y + 1, err, 3 / 16);
      spread(x, y + 1, err, 5 / 16);
      spread(x + dir, y + 1, err, 1 / 16);
    }
  }
  return out;
}

/** extractPalette + mapToPalette for a single image. */
export function reduceColors(
  image: RgbaImage,
  maxColors: number,
  dither: DitherMode = "none",
): { image: RgbaImage; palette: string[] } {
  const palette = extractPalette([image], maxColors);
  if (palette.length === 0) return { image: binarizeAlpha(image), palette };
  return { image: mapToPalette(image, palette, dither), palette };
}
