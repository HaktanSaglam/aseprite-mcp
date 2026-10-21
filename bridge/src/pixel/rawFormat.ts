import type { PixelFormat } from "../aseprite/protocol.js";
import { createRgbaImage, type RgbaImage } from "./RgbaImage.js";

/** The color-mode details needed to turn RGBA into a sprite's raw bytes and back. */
export interface PixelTarget {
  format: PixelFormat;
  /** rrggbbaa per index; required for indexed sprites. */
  palette?: string[];
  transparentIndex?: number;
}

type Rgba = [number, number, number, number];

function parsePaletteEntry(hex: string): Rgba {
  const v = hex.replace(/^#/, "");
  const n = (i: number) => Number.parseInt(v.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), v.length >= 8 ? n(6) : 255];
}

/**
 * Raw image bytes (Aseprite's image.bytes as hex) → RGBA. Indexed pixels are looked up
 * in the palette; the transparent index becomes alpha 0.
 */
export function decodeRaw(
  data: string,
  width: number,
  height: number,
  target: PixelTarget,
): RgbaImage {
  const bytes = Buffer.from(data, "hex");
  const image = createRgbaImage(width, height);
  const out = image.data;
  const count = width * height;

  switch (target.format) {
    case "rgba":
      if (bytes.length !== count * 4) throw sizeError(bytes.length, count * 4);
      out.set(bytes);
      break;
    case "gray":
      if (bytes.length !== count * 2) throw sizeError(bytes.length, count * 2);
      for (let i = 0; i < count; i++) {
        const v = bytes[i * 2];
        out[i * 4] = v;
        out[i * 4 + 1] = v;
        out[i * 4 + 2] = v;
        out[i * 4 + 3] = bytes[i * 2 + 1];
      }
      break;
    case "indexed": {
      if (bytes.length !== count) throw sizeError(bytes.length, count);
      const palette = (target.palette ?? []).map(parsePaletteEntry);
      for (let i = 0; i < count; i++) {
        const index = bytes[i];
        if (index === target.transparentIndex || index >= palette.length) continue;
        out.set(palette[index], i * 4);
      }
      break;
    }
  }
  return image;
}

function sizeError(actual: number, expected: number): Error {
  return new Error(`Aseprite sent ${actual} pixel bytes, expected ${expected}`);
}

/** RGBA → raw bytes (hex) in the sprite's color mode. */
export function encodeRaw(image: RgbaImage, target: PixelTarget): string {
  const src = image.data;
  const count = image.width * image.height;

  switch (target.format) {
    case "rgba":
      return Buffer.from(src.buffer, src.byteOffset, count * 4).toString("hex");
    case "gray": {
      const out = Buffer.alloc(count * 2);
      for (let i = 0; i < count; i++) {
        const o = i * 4;
        out[i * 2] = Math.round(0.299 * src[o] + 0.587 * src[o + 1] + 0.114 * src[o + 2]);
        out[i * 2 + 1] = src[o + 3];
      }
      return out.toString("hex");
    }
    case "indexed": {
      const nearest = nearestIndexFinder(target);
      const transparent = target.transparentIndex ?? 0;
      const out = Buffer.alloc(count);
      for (let i = 0; i < count; i++) {
        const o = i * 4;
        // Indexed pixels are either fully opaque or the transparent index.
        out[i] = src[o + 3] < 128 ? transparent : nearest(src[o], src[o + 1], src[o + 2]);
      }
      return out.toString("hex");
    }
  }
}

/** Closest palette entry by squared RGB distance, memoized per color. */
function nearestIndexFinder(target: PixelTarget): (r: number, g: number, b: number) => number {
  const palette = (target.palette ?? []).map(parsePaletteEntry);
  if (palette.length === 0) throw new Error("Indexed sprite has an empty palette");
  const cache = new Map<number, number>();
  return (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let best = 0;
    let bestDist = Infinity;
    palette.forEach(([pr, pg, pb], i) => {
      if (i === target.transparentIndex) return;
      const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    cache.set(key, best);
    return best;
  };
}
