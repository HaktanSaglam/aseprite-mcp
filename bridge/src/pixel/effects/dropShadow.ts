import type { Rgba } from "../color.js";
import { cloneImage, type RgbaImage } from "../RgbaImage.js";
import { opaqueMask } from "./neighbours.js";

export interface DropShadowOptions {
  /** Shadow offset in pixels (default 1 right, 1 down). */
  dx?: number;
  dy?: number;
  color: Rgba;
}

/**
 * Casts the opaque silhouette offset by (dx, dy) in `color`. Only see-through pixels
 * receive shadow, so the shadow sits behind the art and never covers it.
 */
export function dropShadow(image: RgbaImage, options: DropShadowOptions): { image: RgbaImage; changed: number } {
  const { width, height } = image;
  const dx = Math.trunc(options.dx ?? 1);
  const dy = Math.trunc(options.dy ?? 1);
  const mask = opaqueMask(image);
  const out = cloneImage(image);
  let changed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i]) continue;
      const sx = x - dx;
      const sy = y - dy;
      if (sx < 0 || sy < 0 || sx >= width || sy >= height || !mask[sy * width + sx]) continue;
      out.data.set(options.color, i * 4);
      changed++;
    }
  }
  return { image: out, changed };
}
