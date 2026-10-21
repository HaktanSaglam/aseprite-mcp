import { colorDistance, type Rgba } from "../color.js";
import { cloneImage, type RgbaImage } from "../RgbaImage.js";
import { NEIGHBOURS_4, countOpaqueNeighbours, opaqueMask } from "./neighbours.js";

/**
 * Which lone pixels count as noise:
 * - "similar": only near-identical shades of the surrounding color (stray shades from
 *   downscaling or careless shading); high-contrast 1px details like eye glints survive.
 * - "all": any pixel enclosed on 4 sides by one other color.
 * - "off": leave them alone.
 */
export type NoiseMode = "off" | "similar" | "all";

export interface CleanupOptions {
  /** Opaque pixels with fewer opaque 8-neighbours are erased. 1 = only fully isolated pixels; 0 disables. */
  minNeighbors?: number;
  noise?: NoiseMode;
}

// OKLab distance under which a lone pixel reads as the same surface, not a detail.
const SIMILAR_NOISE_DISTANCE = 0.1;

/** Pixel indexes of opaque pixels with fewer than `minNeighbors` opaque 8-neighbours. */
export function findOrphans(image: RgbaImage, minNeighbors = 1): number[] {
  if (minNeighbors <= 0) return [];
  const { width, height } = image;
  const mask = opaqueMask(image);
  const orphans: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i] && countOpaqueNeighbours(mask, width, height, x, y) < minNeighbors) orphans.push(i);
    }
  }
  return orphans;
}

/** Lone pixels whose 4 neighbours all share one other opaque color, with that color. */
export function findNoise(image: RgbaImage, mode: NoiseMode = "similar"): { index: number; color: Rgba }[] {
  if (mode === "off") return [];
  const { width, height, data } = image;
  const mask = opaqueMask(image);
  const sameAs = (o: number, ref: number) =>
    data[o] === data[ref] && data[o + 1] === data[ref + 1] && data[o + 2] === data[ref + 2] && data[o + 3] === data[ref + 3];
  const found: { index: number; color: Rgba }[] = [];
  // Canvas-edge pixels lack a full neighbourhood, so they are never judged as noise.
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const ref = (i + 1) * 4;
      const enclosed = NEIGHBOURS_4.every(([dx, dy]) => {
        const n = (y + dy) * width + x + dx;
        return mask[n] === 1 && sameAs(n * 4, ref);
      });
      const own = i * 4;
      if (!enclosed || sameAs(own, ref)) continue;
      const around: Rgba = [data[ref], data[ref + 1], data[ref + 2], data[ref + 3]];
      if (mode === "similar" && colorDistance([data[own], data[own + 1], data[own + 2]], around) > SIMILAR_NOISE_DISTANCE) {
        continue;
      }
      found.push({ index: i, color: around });
    }
  }
  return found;
}

/**
 * Erases orphan pixels and recolors noise pixels. Both are detected on the input image,
 * so one pass never cascades (removing a pixel can't make its neighbour an orphan).
 */
export function cleanupPixels(
  image: RgbaImage,
  options: CleanupOptions = {},
): { image: RgbaImage; removed: number; recolored: number } {
  const out = cloneImage(image);
  const orphans = findOrphans(image, options.minNeighbors ?? 1);
  for (const i of orphans) out.data.fill(0, i * 4, i * 4 + 4);
  const noise = findNoise(image, options.noise ?? "similar");
  for (const { index, color } of noise) out.data.set(color, index * 4);
  return { image: out, removed: orphans.length, recolored: noise.length };
}
