import type { Rect } from "../../aseprite/protocol.js";
import { compose, type PixelFilter } from "../composite.js";
import { cloneImage, createRgbaImage, type RgbaImage } from "../RgbaImage.js";

export const TRANSFORM_OPS = ["flip_h", "flip_v", "rotate_90", "rotate_180", "rotate_270", "shift"] as const;
export type TransformOp = (typeof TRANSFORM_OPS)[number];

export interface TransformOptions {
  /** shift only: pixels to move right (negative: left). */
  dx?: number;
  /** shift only: pixels to move down (negative: up). */
  dy?: number;
  /** shift only: pixels leaving one side come back on the other (seamless tiles, scrolling). */
  wrap?: boolean;
}

type Mapper = (x: number, y: number) => [number, number];

/**
 * Where each pixel of a w×h area goes. Rotations are clockwise about the area's center;
 * on non-square areas the rotated content is centered and whatever sticks out is clipped,
 * because the canvas keeps its size (use edit_sprite rotate to turn the whole sprite).
 */
function mapper(op: TransformOp, w: number, h: number, options: TransformOptions): Mapper {
  const ox = Math.floor((w - h) / 2);
  const oy = Math.floor((h - w) / 2);
  const dx = Math.trunc(options.dx ?? 0);
  const dy = Math.trunc(options.dy ?? 0);
  const mod = (v: number, n: number) => ((v % n) + n) % n;
  switch (op) {
    case "flip_h":
      return (x, y) => [w - 1 - x, y];
    case "flip_v":
      return (x, y) => [x, h - 1 - y];
    case "rotate_90":
      return (x, y) => [ox + (h - 1 - y), oy + x];
    case "rotate_180":
      return (x, y) => [w - 1 - x, h - 1 - y];
    case "rotate_270":
      // When w - h is odd the turned art can't sit exactly centered; rounding the x offset
      // the other way (-oy == ceil((w - h) / 2)) makes this the exact inverse of rotate_90.
      return (x, y) => [-oy + y, oy + (w - 1 - x)];
    case "shift":
      return options.wrap ? (x, y) => [mod(x + dx, w), mod(y + dy, h)] : (x, y) => [x + dx, y + dy];
  }
}

/**
 * Flips, rotates or shifts the pixels inside `region` (default: the whole image).
 * Pixels outside the region are untouched; area uncovered by the move becomes transparent.
 */
export function transformImage(
  image: RgbaImage,
  op: TransformOp,
  options: TransformOptions = {},
  region: Rect = { x: 0, y: 0, width: image.width, height: image.height },
): RgbaImage {
  const x0 = Math.max(0, region.x);
  const y0 = Math.max(0, region.y);
  const x1 = Math.min(image.width, region.x + region.width);
  const y1 = Math.min(image.height, region.y + region.height);
  const w = x1 - x0;
  const h = y1 - y0;
  const out = cloneImage(image);
  if (w <= 0 || h <= 0) return out;

  for (let y = y0; y < y1; y++) out.data.fill(0, (y * image.width + x0) * 4, (y * image.width + x1) * 4);
  const move = mapper(op, w, h, options);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [tx, ty] = move(x, y);
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
      const src = ((y0 + y) * image.width + x0 + x) * 4;
      const dst = ((y0 + ty) * image.width + x0 + tx) * 4;
      out.data.set(image.data.subarray(src, src + 4), dst);
    }
  }
  return out;
}

/**
 * Moves only the selected pixels: they are lifted out (leaving a transparent hole),
 * transformed and dropped over what lies at their new place. Unselected pixels stay
 * put, and moved pixels may land outside the old selection outline (a flipped sword is
 * not cut to the shape it had before). Flips and turns pivot on the selection's bounds;
 * a shift moves freely across the canvas, except that wrap wraps inside the bounds (tiles).
 */
export function transformSelection(
  image: RgbaImage,
  op: TransformOp,
  options: TransformOptions,
  bounds: Rect,
  selected: PixelFilter,
): RgbaImage {
  const lifted = createRgbaImage(image.width, image.height);
  const rest = cloneImage(image);
  const x0 = Math.max(0, bounds.x);
  const y0 = Math.max(0, bounds.y);
  const x1 = Math.min(image.width, bounds.x + bounds.width);
  const y1 = Math.min(image.height, bounds.y + bounds.height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!selected(x, y)) continue;
      const o = (y * image.width + x) * 4;
      lifted.data.set(image.data.subarray(o, o + 4), o);
      rest.data.fill(0, o, o + 4);
    }
  }
  const area = op === "shift" && !options.wrap ? { x: 0, y: 0, width: image.width, height: image.height } : bounds;
  return compose(rest, transformImage(lifted, op, options, area), "over");
}
