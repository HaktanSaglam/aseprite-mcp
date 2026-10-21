import type { Rect } from "../aseprite/protocol.js";
import type { RgbaImage } from "../pixel/RgbaImage.js";

/** One byte per pixel of `rect` (1 = selected), positioned in canvas coordinates. */
export interface Mask {
  rect: Rect;
  data: Uint8Array;
}

export interface Size {
  width: number;
  height: number;
}

export type Rgba = readonly [number, number, number, number];

/** The part of `r` that lies on the canvas, or null when none of it does. */
export function clipRect(r: Rect, canvas: Size): Rect | null {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(canvas.width, r.x + r.width);
  const y1 = Math.min(canvas.height, r.y + r.height);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * The ellipse inscribed in `box`, clipped to the canvas. Pixel centres are tested
 * against radii of w/2 and h/2 (the same rule as Raster.ellipse), which keeps the
 * shape symmetric and touching all four sides of the box.
 */
export function ellipseMask(box: Rect, canvas: Size): Mask | null {
  const rect = clipRect(box, canvas);
  if (!rect) return null;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const rx = box.width / 2;
  const ry = box.height / 2;
  const data = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) {
    const ny = (rect.y + y + 0.5 - cy) / ry;
    for (let x = 0; x < rect.width; x++) {
      const nx = (rect.x + x + 0.5 - cx) / rx;
      if (nx * nx + ny * ny <= 1) data[y * rect.width + x] = 1;
    }
  }
  return { rect, data };
}

const MAX_RGB_DISTANCE = Math.sqrt(3) * 255;

/**
 * 0 (identical) to 100 (opposite): Euclidean RGB distance and alpha difference, both
 * scaled to 0-100, whichever is larger. Fully transparent pixels count as equal
 * whatever their hidden RGB, because they look the same.
 */
export function colorDistance(data: Uint8Array, offset: number, color: Rgba): number {
  const a = data[offset + 3];
  if (a === 0 && color[3] === 0) return 0;
  const dr = data[offset] - color[0];
  const dg = data[offset + 1] - color[1];
  const db = data[offset + 2] - color[2];
  const rgb = (Math.sqrt(dr * dr + dg * dg + db * db) / MAX_RGB_DISTANCE) * 100;
  const alpha = (Math.abs(a - color[3]) / 255) * 100;
  return Math.max(rgb, alpha);
}

export interface ColorMatchOptions {
  /** 0 = exact match, 100 = everything. */
  tolerance?: number;
  /** Magic wand: only pixels 4-connected to this canvas pixel (which must match). */
  seed?: { x: number; y: number };
}

/**
 * Pixels of `image` (placed at `origin` on the canvas) whose color is within
 * `tolerance` of `color`; the whole image, or only the region around `seed`.
 */
export function colorMask(
  image: RgbaImage,
  origin: { x: number; y: number },
  color: Rgba,
  options: ColorMatchOptions = {},
): Mask {
  const tolerance = options.tolerance ?? 0;
  const { width, height } = image;
  const data = new Uint8Array(width * height);
  const matches = (i: number) => colorDistance(image.data, i * 4, color) <= tolerance;

  if (!options.seed) {
    for (let i = 0; i < data.length; i++) if (matches(i)) data[i] = 1;
    return { rect: { x: origin.x, y: origin.y, width, height }, data };
  }

  const sx = options.seed.x - origin.x;
  const sy = options.seed.y - origin.y;
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) {
    throw new Error(`Seed pixel (${options.seed.x}, ${options.seed.y}) is outside the canvas`);
  }
  // Explicit stack instead of recursion: a 512x512 region would overflow the call stack.
  const visited = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let top = 0;
  const start = sy * width + sx;
  visited[start] = 1;
  stack[top++] = start;
  while (top > 0) {
    const i = stack[--top];
    if (!matches(i)) continue;
    data[i] = 1;
    const x = i % width;
    const push = (n: number) => {
      if (visited[n] === 0) {
        visited[n] = 1;
        stack[top++] = n;
      }
    };
    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (i >= width) push(i - width);
    if (i < width * (height - 1)) push(i + width);
  }
  return { rect: { x: origin.x, y: origin.y, width, height }, data };
}

/** Every pixel that is not fully transparent ("select the drawing"). */
export function opaqueMask(image: RgbaImage, origin: { x: number; y: number }): Mask {
  const data = new Uint8Array(image.width * image.height);
  for (let i = 0; i < data.length; i++) if (image.data[i * 4 + 3] > 0) data[i] = 1;
  return { rect: { x: origin.x, y: origin.y, width: image.width, height: image.height }, data };
}

export function countSelected(data: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < data.length; i++) n += data[i];
  return n;
}

/** Tight canvas bounds of the selected pixels, or undefined for an empty mask. */
export function maskBounds(mask: Mask): Rect | undefined {
  const { width, height } = mask.rect;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask.data[y * width + x] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return undefined;
  return { x: mask.rect.x + minX, y: mask.rect.y + minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Converts a mask into non-overlapping [x, y, w, h] canvas rects for set_selection:
 * one per horizontal run, merged with the run directly above when it spans exactly
 * the same columns. Ellipses and blobs then cost tens of rects instead of hundreds.
 */
export function maskToRects(mask: Mask): number[][] {
  const { x: ox, y: oy, width, height } = mask.rect;
  const rects: number[][] = [];
  // Runs of the previous row that can still grow downwards, keyed by their columns.
  let open = new Map<number, number[]>();
  for (let y = 0; y < height; y++) {
    const next = new Map<number, number[]>();
    let x = 0;
    while (x < width) {
      if (mask.data[y * width + x] === 0) {
        x++;
        continue;
      }
      const start = x;
      while (x < width && mask.data[y * width + x] === 1) x++;
      const key = start * (width + 1) + x;
      const above = open.get(key);
      if (above) {
        above[3]++;
        next.set(key, above);
      } else {
        const rect = [ox + start, oy + y, x - start, 1];
        rects.push(rect);
        next.set(key, rect);
      }
    }
    open = next;
  }
  return rects;
}

/** Rows of '#' (selected) and '.' so a model can read the shape like a pixel grid. */
export function maskToRows(mask: Mask): string[] {
  const rows: string[] = [];
  for (let y = 0; y < mask.rect.height; y++) {
    let row = "";
    for (let x = 0; x < mask.rect.width; x++) row += mask.data[y * mask.rect.width + x] ? "#" : ".";
    rows.push(row);
  }
  return rows;
}
