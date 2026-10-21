import type { RgbaImage } from "./RgbaImage.js";

export type PaintMode = "over" | "replace";

/** Absolute-canvas predicate: may this pixel change? (e.g. "is it selected?") */
export type PixelFilter = (x: number, y: number) => boolean;

/**
 * Combines new pixels with what is already there.
 * - "over": transparent pixels keep the old ones, partial alpha blends (normal blend).
 * - "replace": the new image wins everywhere, transparent pixels erase.
 * `origin` is where both images sit on the canvas, so `filter` can use canvas coordinates.
 */
export function compose(
  base: RgbaImage,
  top: RgbaImage,
  mode: PaintMode,
  origin: { x: number; y: number } = { x: 0, y: 0 },
  filter?: PixelFilter,
): RgbaImage {
  if (base.width !== top.width || base.height !== top.height) {
    throw new Error("compose: images must have the same size");
  }
  const out = new Uint8Array(base.data);
  const src = top.data;
  for (let y = 0; y < top.height; y++) {
    for (let x = 0; x < top.width; x++) {
      if (filter && !filter(origin.x + x, origin.y + y)) continue;
      const o = (y * top.width + x) * 4;
      const a = src[o + 3];
      if (mode === "replace" || a === 255) {
        out[o] = src[o];
        out[o + 1] = src[o + 1];
        out[o + 2] = src[o + 2];
        out[o + 3] = a;
      } else if (a > 0) {
        blendOver(out, o, src[o], src[o + 1], src[o + 2], a);
      }
    }
  }
  return { width: top.width, height: top.height, data: out };
}

/** Straight-alpha "source over destination", in place at offset o. */
function blendOver(dst: Uint8Array, o: number, r: number, g: number, b: number, a: number): void {
  const sa = a / 255;
  const da = dst[o + 3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) return;
  const mix = (s: number, d: number) => Math.round((s * sa + d * da * (1 - sa)) / outA);
  dst[o] = mix(r, dst[o]);
  dst[o + 1] = mix(g, dst[o + 1]);
  dst[o + 2] = mix(b, dst[o + 2]);
  dst[o + 3] = Math.round(outA * 255);
}

/** Turns a 0/1 mask over `rect` into a canvas-coordinate predicate. */
export function maskFilter(
  rect: { x: number; y: number; width: number; height: number },
  mask: Uint8Array,
): PixelFilter {
  return (x, y) => {
    const lx = x - rect.x;
    const ly = y - rect.y;
    if (lx < 0 || ly < 0 || lx >= rect.width || ly >= rect.height) return false;
    return mask[ly * rect.width + lx] === 1;
  };
}
