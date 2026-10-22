import type { PixelFormat } from "../aseprite/protocol.js";
import { isOpaque, packRgb, rgbToOklab, type Lab, type Rgba } from "./color.js";
import { createRgbaImage, type RgbaImage } from "./RgbaImage.js";

/** The color-mode details needed to turn RGBA into a sprite's raw bytes and back. */
export interface PixelTarget {
  format: PixelFormat;
  /** rrggbbaa per index; required for indexed sprites. */
  palette?: string[];
  transparentIndex?: number;
  /**
   * The pixels belong to an indexed Background layer. Aseprite only treats the transparent
   * index as see-through on transparent layers; on the Background it is an ordinary,
   * opaque palette color that can be read and painted like any other.
   */
  isBackground?: boolean;
}

/** How decoded pixels are stored in the sprite they were read from. */
export interface PixelSource {
  target: PixelTarget;
  /** Indexed sprites: every pixel's palette index as read. */
  indexes?: Uint8Array;
}

function parsePaletteEntry(hex: string): Rgba {
  const v = hex.replace(/^#/, "");
  const n = (i: number) => Number.parseInt(v.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), v.length >= 8 ? n(6) : 255];
}

/** RGBA packed into one number; every fully transparent pixel is 0, whatever its RGB. */
function visibleKey(r: number, g: number, b: number, a: number): number {
  return a === 0 ? 0 : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

/**
 * What each index (0-255) shows, as visibleKey. Indexes past the palette and the
 * transparent index (except on a Background) show nothing.
 */
function indexColors(target: PixelTarget): Uint32Array {
  const table = new Uint32Array(256);
  (target.palette ?? []).slice(0, 256).forEach((hex, i) => {
    if (i === target.transparentIndex && !target.isBackground) return;
    const [r, g, b, a] = parsePaletteEntry(hex);
    // A Background layer has no transparency at all.
    table[i] = visibleKey(r, g, b, target.isBackground ? 255 : a);
  });
  return table;
}

/** Raw image bytes (Aseprite's image.bytes as hex) → RGBA; see decodeBytes. */
export function decodeRaw(data: string, width: number, height: number, target: PixelTarget): RgbaImage {
  return decodeBytes(Buffer.from(data, "hex"), width, height, target);
}

/**
 * Raw image bytes → RGBA. Indexed pixels are looked up in the palette; the transparent
 * index (on a transparent layer) and indexes the palette doesn't have become alpha 0.
 * The result remembers its source, so unchanged pixels can be written back exactly.
 */
export function decodeBytes(bytes: Uint8Array, width: number, height: number, target: PixelTarget): RgbaImage {
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
      const colors = indexColors(target);
      for (let i = 0; i < count; i++) {
        const c = colors[bytes[i]];
        if (c === 0) continue;
        out[i * 4] = c >>> 24;
        out[i * 4 + 1] = (c >>> 16) & 255;
        out[i * 4 + 2] = (c >>> 8) & 255;
        out[i * 4 + 3] = c & 255;
      }
      image.source = { target, indexes: Uint8Array.from(bytes) };
      return image;
    }
  }
  image.source = { target };
  return image;
}

function sizeError(actual: number, expected: number): Error {
  return new Error(`Aseprite sent ${actual} pixel bytes, expected ${expected}`);
}

/** RGBA → raw bytes (hex) in the sprite's color mode; see encodeBytes. */
export function encodeRaw(image: RgbaImage, target: PixelTarget): string {
  return encodeBytes(image, target).toString("hex");
}

/**
 * RGBA → raw bytes in the sprite's color mode. Indexed: a pixel that still shows the
 * color of the index it was read with keeps that index, so duplicate palette colors
 * (palette swaps), translucent entries and unknown indexes survive an edit elsewhere;
 * every other pixel takes the perceptually nearest paintable palette color.
 */
export function encodeBytes(image: RgbaImage, target: PixelTarget): Buffer {
  const src = image.data;
  const count = image.width * image.height;

  switch (target.format) {
    case "rgba":
      return Buffer.from(src.buffer, src.byteOffset, count * 4);
    case "gray": {
      const out = Buffer.alloc(count * 2);
      for (let i = 0; i < count; i++) {
        const o = i * 4;
        out[i * 2] = Math.round(0.299 * src[o] + 0.587 * src[o + 1] + 0.114 * src[o + 2]);
        out[i * 2 + 1] = src[o + 3];
      }
      return out;
    }
    case "indexed":
      return encodeIndexed(image, target);
  }
}

function encodeIndexed(image: RgbaImage, writeTarget: PixelTarget): Buffer {
  // Pixels read from a Background layer go back to it, even when the writer's target
  // (built from the palette alone) can't tell which kind of layer it writes to.
  const target =
    writeTarget.isBackground === undefined && image.source?.target.isBackground
      ? { ...writeTarget, isBackground: true }
      : writeTarget;
  const src = image.data;
  const count = image.width * image.height;
  const colors = indexColors(target);
  const read = image.source?.indexes;
  const original = read && read.length === count ? read : undefined;
  const nearest = nearestIndexFinder(target);
  const transparent = target.transparentIndex ?? 0;
  const out = Buffer.alloc(count);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    if (original && colors[original[i]] === visibleKey(src[o], src[o + 1], src[o + 2], src[o + 3])) {
      out[i] = original[i];
    } else {
      // Indexed pixels are either drawn or the transparent index.
      out[i] = isOpaque(src[o + 3]) ? nearest(src[o], src[o + 1], src[o + 2]) : transparent;
    }
  }
  return out;
}

/**
 * Closest paintable palette entry in OKLab (the distance every other color tool uses),
 * memoized per color. Paintable: not the transparent index (unless on a Background) and
 * opaque enough to show; a translucent entry would make an opaque pixel see-through.
 */
function nearestIndexFinder(target: PixelTarget): (r: number, g: number, b: number) => number {
  const palette = (target.palette ?? []).slice(0, 256).map(parsePaletteEntry);
  if (palette.length === 0) throw new Error("Indexed sprite has an empty palette");
  const usable = (i: number) => target.isBackground || i !== target.transparentIndex;
  let candidates = palette.flatMap((c, i) => (usable(i) && (target.isBackground || isOpaque(c[3])) ? [i] : []));
  // A palette of only see-through entries: a faint color beats dropping the pixel.
  if (candidates.length === 0) candidates = palette.flatMap((_, i) => (usable(i) ? [i] : []));
  if (candidates.length === 0) return () => target.transparentIndex ?? 0;

  const labs: Lab[] = candidates.map((i) => rgbToOklab(palette[i][0], palette[i][1], palette[i][2]));
  const cache = new Map<number, number>();
  return (r, g, b) => {
    const key = packRgb(r, g, b);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const [L, A, B] = rgbToOklab(r, g, b);
    let best = candidates[0];
    let bestDist = Infinity;
    for (let k = 0; k < candidates.length; k++) {
      const d = (labs[k][0] - L) ** 2 + (labs[k][1] - A) ** 2 + (labs[k][2] - B) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = candidates[k];
      }
    }
    cache.set(key, best);
    return best;
  };
}

/**
 * The pixels as the sprite will really hold them: indexed sprites snap to the palette,
 * grayscale ones to gray. Tools count and report this, not the colors they asked for.
 * Pixels that keep their color also keep their index (see encodeBytes).
 */
export function storedPixels(image: RgbaImage, target: PixelTarget): RgbaImage {
  if (target.format === "rgba") return image;
  return decodeBytes(encodeBytes(image, target), image.width, image.height, target);
}

/** The color a pixel of `color` ends up as in the sprite (the nearest palette color, gray...). */
export function storedColor(color: Rgba, target: PixelTarget): Rgba {
  const pixel = createRgbaImage(1, 1);
  pixel.data.set(color);
  const d = storedPixels(pixel, target).data;
  return [d[0], d[1], d[2], d[3]];
}
