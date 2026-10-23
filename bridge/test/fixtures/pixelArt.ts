import { parseHex } from "../../src/pixel/color.js";
import { createRgbaImage, type RgbaImage } from "../../src/pixel/RgbaImage.js";

/** Deterministic PRNG (mulberry32), so generated test art is the same on every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rows of legend characters; "." is transparent. */
export function gridImage(rows: string[], legend: Record<string, string>): RgbaImage {
  const image = createRgbaImage(rows[0].length, rows.length);
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === ".") return;
      const hex = legend[ch];
      if (hex === undefined) throw new Error(`No legend entry for "${ch}"`);
      image.data.set(parseHex(hex), (y * image.width + x) * 4);
    }),
  );
  return image;
}

export function upscale(image: RgbaImage, scale: number): RgbaImage {
  const out = createRgbaImage(image.width * scale, image.height * scale);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const src = (Math.floor(y / scale) * image.width + Math.floor(x / scale)) * 4;
      out.data.set(image.data.subarray(src, src + 4), (y * out.width + x) * 4);
    }
  }
  return out;
}

/** The part of `image` at (x, y) of the given size; outside pixels are transparent. */
export function crop(image: RgbaImage, x: number, y: number, width: number, height: number): RgbaImage {
  const out = createRgbaImage(width, height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const sx = x + col;
      const sy = y + row;
      if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) continue;
      const src = (sy * image.width + sx) * 4;
      out.data.set(image.data.subarray(src, src + 4), (row * width + col) * 4);
    }
  }
  return out;
}

/** Copies `image` onto a transparent canvas at (x, y). */
export function placeOn(image: RgbaImage, width: number, height: number, x: number, y: number): RgbaImage {
  return crop(image, -x, -y, width, height);
}

/** A sweetie-16 subset: distinct colors a pixel artist would really use. */
export const ART_PALETTE = ["#1a1c2c", "#5d275d", "#b13e53", "#ef7d57", "#ffcd75", "#a7f070", "#38b764", "#257179", "#3b5dc9", "#41a6f6", "#f4f4f4"];

/**
 * Pixel art made of overlapping rectangles of 1-5 pixels: features of every size, so the
 * art has no accidental grid of its own, and every color covers many pixels.
 */
export function randomArt(width: number, height: number, seed: number, options: { background?: string; colors?: number } = {}): RgbaImage {
  const random = rng(seed);
  const palette = ART_PALETTE.slice(0, options.colors ?? 8).map(parseHex);
  const image = createRgbaImage(width, height);
  if (options.background) {
    const bg = parseHex(options.background);
    for (let o = 0; o < image.data.length; o += 4) image.data.set(bg, o);
  }
  const rects = Math.round((width * height) / 6);
  for (let i = 0; i < rects; i++) {
    const w = Math.min(width, 1 + Math.floor(random() * 5));
    const h = Math.min(height, 1 + Math.floor(random() * 5));
    const x0 = Math.floor(random() * (width - w + 1));
    const y0 = Math.floor(random() * (height - h + 1));
    const color = palette[Math.floor(random() * palette.length)];
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) image.data.set(color, (y * width + x) * 4);
  }
  return image;
}

/**
 * Noise on every visible pixel: Gaussian errors per channel (sigma), plus rare large
 * outliers like the ringing next to edges in a JPEG.
 */
export function addNoise(image: RgbaImage, seed: number, sigma = 1.5, outliers = 0.02): RgbaImage {
  const random = rng(seed);
  const gaussian = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  return perturb(image, random, () => gaussian() * sigma, outliers);
}

/**
 * What JPEG does to flat areas: most channels stay exact, the rest are off by 1-3, and
 * a few pixels near edges ring by 10-25.
 */
export function addJpegNoise(image: RgbaImage, seed: number): RgbaImage {
  const random = rng(seed);
  return perturb(image, random, () => (random() < 0.6 ? 0 : (random() < 0.5 ? -1 : 1) * (1 + Math.floor(random() * 3))), 0.03);
}

function perturb(image: RgbaImage, random: () => number, error: () => number, outliers: number): RgbaImage {
  const out = { width: image.width, height: image.height, data: new Uint8Array(image.data) };
  for (let o = 0; o < out.data.length; o += 4) {
    if (out.data[o + 3] === 0) continue;
    for (let c = 0; c < 3; c++) {
      const e = random() < outliers ? (random() < 0.5 ? -1 : 1) * (10 + random() * 15) : error();
      out.data[o + c] = Math.max(0, Math.min(255, Math.round(out.data[o + c] + e)));
    }
  }
  return out;
}

export function sameImage(a: RgbaImage, b: RgbaImage): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let o = 0; o < a.data.length; o += 4) {
    if (a.data[o + 3] === 0 && b.data[o + 3] === 0) continue;
    for (let c = 0; c < 4; c++) if (a.data[o + c] !== b.data[o + c]) return false;
  }
  return true;
}

/** Number of pixels that differ (fully transparent pixels are equal whatever their RGB). */
export function differingPixels(a: RgbaImage, b: RgbaImage): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`size ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  let n = 0;
  for (let o = 0; o < a.data.length; o += 4) {
    if (a.data[o + 3] === 0 && b.data[o + 3] === 0) continue;
    if ([0, 1, 2, 3].some((c) => a.data[o + c] !== b.data[o + c])) n++;
  }
  return n;
}
