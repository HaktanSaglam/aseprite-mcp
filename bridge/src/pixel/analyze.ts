import type { Rect } from "../aseprite/protocol.js";
import { formatHex, labDistance, rgbToOklab, type Lab } from "./color.js";
import { dominantBorderColors } from "./effects/background.js";
import { findNoise, findOrphans } from "./effects/cleanup.js";
import type { RgbaImage } from "./RgbaImage.js";

export interface ImageAnalysis {
  width: number;
  height: number;
  /** Pixels with any alpha. */
  visiblePixels: number;
  /** Pixels with 0 < alpha < 255. */
  partialAlphaPixels: number;
  /** Bounding box of visible pixels; null when nothing is drawn. */
  bounds: Rect | null;
  uniqueColors: number;
  topColors: { color: string; count: number }[];
  /** Opaque pixels with no opaque 8-neighbour. */
  orphanPixels: number;
  /** Lone pixels in a slightly different shade than the color around them. */
  noisePixels: number;
  /** Color pairs too similar to tell apart; usually accidental. */
  nearDuplicateColors: [string, string][];
  /** The canvas border is mostly this opaque color: probably a background. */
  borderColor?: { color: string; share: number };
  suggestions: string[];
}

const TOP_COLORS = 8;
// Pixel art palettes rarely exceed this; beyond it the art usually came from a filter or an AI render.
const MAX_PIXEL_ART_COLORS = 32;
const NEAR_DUPLICATE_DISTANCE = 0.03;
// Comparing every pair is quadratic; past this the color count itself is the problem to report.
const MAX_COLORS_FOR_PAIRS = 256;
const MAX_PAIRS_REPORTED = 5;
const BACKGROUND_BORDER_SHARE = 0.6;

export function analyzeImage(image: RgbaImage): ImageAnalysis {
  const { width, height, data } = image;
  const counts = new Map<number, number>();
  let visible = 0;
  let partial = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const a = data[o + 3];
      if (a === 0) continue;
      visible++;
      if (a < 255) partial++;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      // Unsigned 32-bit key: rgba packed, so partial-alpha variants count as distinct colors.
      const key = ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | a) >>> 0;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const colors = [...counts].sort((p, q) => q[1] - p[1] || p[0] - q[0]);
  const hexOf = (key: number) => formatHex(key >>> 24, (key >>> 16) & 255, (key >>> 8) & 255, key & 255);
  const border = dominantBorderColors(image, 0)[0];

  const analysis: ImageAnalysis = {
    width,
    height,
    visiblePixels: visible,
    partialAlphaPixels: partial,
    bounds: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    uniqueColors: colors.length,
    topColors: colors.slice(0, TOP_COLORS).map(([key, count]) => ({ color: hexOf(key), count })),
    orphanPixels: findOrphans(image, 1).length,
    noisePixels: findNoise(image, "similar").length,
    nearDuplicateColors: nearDuplicates(colors.map(([key]) => key), hexOf),
    borderColor: border && border.share >= BACKGROUND_BORDER_SHARE
      ? { color: formatHex(...border.color), share: Math.round(border.share * 100) / 100 }
      : undefined,
    suggestions: [],
  };
  analysis.suggestions = suggest(analysis);
  return analysis;
}

function nearDuplicates(keys: number[], hexOf: (key: number) => string): [string, string][] {
  if (keys.length > MAX_COLORS_FOR_PAIRS) return [];
  const labs: Lab[] = keys.map((k) => rgbToOklab(k >>> 24, (k >>> 16) & 255, (k >>> 8) & 255));
  const pairs: { pair: [string, string]; distance: number }[] = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const distance = labDistance(labs[i], labs[j]);
      if (distance < NEAR_DUPLICATE_DISTANCE) pairs.push({ pair: [hexOf(keys[i]), hexOf(keys[j])], distance });
    }
  }
  return pairs
    .sort((p, q) => p.distance - q.distance)
    .slice(0, MAX_PAIRS_REPORTED)
    .map((p) => p.pair);
}

/** Short, actionable hints that name the tool which fixes each problem. */
function suggest(a: ImageAnalysis): string[] {
  if (a.visiblePixels === 0) return ["Nothing is drawn here: this layer/frame is empty."];
  const tips: string[] = [];
  if (a.uniqueColors > MAX_PIXEL_ART_COLORS) {
    tips.push(
      `${a.uniqueColors} colors is a lot for pixel art (usually 4-32): reduce_colors (e.g. 16) ` +
        "or apply_palette with a preset.",
    );
  }
  if (a.nearDuplicateColors.length > 0) {
    const [p, q] = a.nearDuplicateColors[0];
    tips.push(
      `Nearly identical colors (e.g. ${p} vs ${q}) add noise without detail: ` +
        "merge them with replace_color or reduce_colors.",
    );
  }
  if (a.orphanPixels > 0) tips.push(`${a.orphanPixels} isolated single pixels: cleanup_pixels removes them.`);
  if (a.noisePixels > 0) {
    tips.push(
      `${a.noisePixels} stray pixels in a slightly different shade than their surroundings: ` +
        "cleanup_pixels recolors them.",
    );
  }
  if (a.partialAlphaPixels > 0) {
    tips.push(
      `${a.partialAlphaPixels} semi-transparent pixels: pixel art uses only fully opaque or fully transparent pixels ` +
        "(reduce_colors or apply_palette snap alpha; remove_background clears soft background edges).",
    );
  }
  if (a.borderColor) {
    tips.push(
      `The canvas edges are ${Math.round(a.borderColor.share * 100)}% ${a.borderColor.color}: if that is a background ` +
        'the sprite should not have, remove_background (mode "edges") makes it transparent.',
    );
  }
  return tips.length > 0 ? tips : ["No obvious pixel-art problems found."];
}
