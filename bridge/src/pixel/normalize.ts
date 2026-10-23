import { cleanupPixels } from "./effects/cleanup.js";
import { binarizeAlpha, extractPalette, mapToPalette } from "./quantize.js";
import type { RgbaImage } from "./RgbaImage.js";
import { detectGrid, unzoom } from "./unzoom.js";
import { gridSize, type UpscaleGrid } from "./upscaleGrid.js";

export interface NormalizeOptions {
  /** "auto" (default) detects the upscale factor; a number forces it (1 = only clean up). */
  scale?: number | "auto";
  /** Hard color limit after downscaling; omitted keeps every color. */
  maxColors?: number;
  /** Snap alpha to fully opaque/transparent (default true). */
  binaryAlpha?: boolean;
  /** Remove isolated pixels and single-pixel noise afterwards (default true). */
  cleanup?: boolean;
}

export interface NormalizeResult {
  grid: UpscaleGrid;
  /** One downscaled image per input image, all width x height. */
  images: RgbaImage[];
  width: number;
  height: number;
  /** The source was noisy (JPEG...): colors were merged within the noise. */
  denoised: boolean;
  /** Distinct visible colors right after downscaling, and at the end. */
  colorsBefore: number;
  colorsAfter: number;
  /** Set when maxColors reduced the colors. */
  palette?: string[];
  /** Semi-transparent pixels snapped to on/off. */
  alphaSnapped: number;
  removed: number;
  recolored: number;
}

function countColors(images: readonly RgbaImage[]): number {
  const colors = new Set<number>();
  for (const { data } of images) {
    for (let o = 0; o < data.length; o += 4) {
      if (data[o + 3] === 0) continue;
      colors.add(((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>> 0);
    }
  }
  return colors.size;
}

function countPartialAlpha(images: readonly RgbaImage[]): number {
  let partial = 0;
  for (const { data } of images) {
    for (let o = 3; o < data.length; o += 4) if (data[o] > 0 && data[o] < 255) partial++;
  }
  return partial;
}

/**
 * Turns upscaled or imported "pixel-style" art into real 1x pixel art: detects the upscale
 * grid, keeps each block's dominant color, then optionally snaps alpha, limits colors
 * (one shared palette for all frames, so animations don't flicker) and removes stray
 * pixels. Every step works on the small image, which is both faster and what the artist sees.
 */
export function normalizePixelArt(images: readonly RgbaImage[], options: NormalizeOptions = {}): NormalizeResult {
  const scale = options.scale === undefined || options.scale === "auto" ? undefined : options.scale;
  if (scale !== undefined && (!Number.isInteger(scale) || scale < 1)) throw new Error("scale must be a positive integer");
  if (options.maxColors !== undefined && (!Number.isInteger(options.maxColors) || options.maxColors < 1)) {
    throw new Error("maxColors must be a positive integer");
  }
  const grid = detectGrid(images, scale);
  const { width, height } = gridSize(images[0].width, images[0].height, grid);
  const unzoomed = unzoom(images, grid);
  let small = unzoomed.images;
  const colorsBefore = countColors(small);

  let alphaSnapped = 0;
  const snapAlpha = options.binaryAlpha ?? true;
  if (snapAlpha) {
    alphaSnapped = countPartialAlpha(small);
    small = small.map(binarizeAlpha);
  }

  let palette: string[] | undefined;
  if (options.maxColors !== undefined && countColors(small) > options.maxColors) {
    // mapToPalette snaps alpha too: a color limit has no room for partial alpha.
    if (!snapAlpha) alphaSnapped = countPartialAlpha(small);
    const colors = extractPalette(small, options.maxColors);
    palette = colors;
    if (colors.length > 0) small = small.map((image) => mapToPalette(image, colors, "none"));
  }

  let removed = 0;
  let recolored = 0;
  if (options.cleanup ?? true) {
    small = small.map((image) => {
      const result = cleanupPixels(image, { minNeighbors: 1, noise: "similar" });
      removed += result.removed;
      recolored += result.recolored;
      return result.image;
    });
  }

  return {
    grid,
    images: small,
    width,
    height,
    denoised: unzoomed.denoised,
    colorsBefore,
    colorsAfter: countColors(small),
    palette,
    alphaSnapped,
    removed,
    recolored,
  };
}
