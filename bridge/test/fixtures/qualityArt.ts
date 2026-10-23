import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { parseHex } from "../../src/pixel/color.js";
import { removeBackground } from "../../src/pixel/effects/background.js";
import { outline } from "../../src/pixel/effects/outline.js";
import { normalizePixelArt } from "../../src/pixel/normalize.js";
import { createRgbaImage, type RgbaImage } from "../../src/pixel/RgbaImage.js";

/** Test art for the quality score: well-made sprites and the classic ways to spoil them. */

export const OUTLINE = "#1a1c2c";
// Dark to light, hue-shifted like a pixel artist's ramp (sweetie-16 blues).
export const RAMP = ["#29366f", "#3b5dc9", "#41a6f6", "#73eff7"];

/** The README gallery images, shrunk back to their real 1x size. */
export function galleryArt(name: "knight" | "items" | "cabin"): RgbaImage {
  const png = PNG.sync.read(readFileSync(new URL(`../../../docs/images/${name}.png`, import.meta.url)));
  const image = { width: png.width, height: png.height, data: new Uint8Array(png.data) };
  return normalizePixelArt([image], { cleanup: false }).images[0];
}

/** A gallery image with its solid backdrop removed, as a sprite on transparency. */
export function gallerySprite(name: "knight" | "items"): RgbaImage {
  return removeBackground(galleryArt(name), { mode: "edges", tolerance: 0 }).image;
}

type Shade = (x: number, y: number, inside: (x: number, y: number) => boolean) => number;

function ball(size: number, radius: number, shade: Shade, ramp = RAMP): RgbaImage {
  const image = createRgbaImage(size, size);
  const c = (size - 1) / 2;
  const inside = (x: number, y: number) => (x - c) ** 2 + (y - c) ** 2 <= radius * radius;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inside(x, y)) continue;
      const level = Math.max(0, Math.min(ramp.length - 1, shade(x, y, inside)));
      image.data.set(parseHex(ramp[level]), (y * size + x) * 4);
    }
  }
  return image;
}

/** Lit from the top-left: lightness follows the surface normal, highlight off-center. */
export function litBall(size = 32, radius = 11, ramp = RAMP): RgbaImage {
  const c = (size - 1) / 2;
  const light = [-0.55, -0.6, 0.58];
  const art = ball(
    size,
    radius,
    (x, y) => {
      const nx = (x - c) / radius;
      const ny = (y - c) / radius;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const lit = nx * light[0] + ny * light[1] + nz * light[2];
      return Math.floor((lit + 0.35) * 2.6);
    },
    ramp,
  );
  return outline(art, { placement: "outside", connectivity: 4, color: parseHex(OUTLINE) }).image;
}

/** Darkens evenly toward every edge: the textbook pillow shading. */
export function pillowBall(size = 32, radius = 11): RgbaImage {
  const c = (size - 1) / 2;
  const art = ball(size, radius, (x, y) => {
    const fromEdge = radius - Math.sqrt((x - c) ** 2 + (y - c) ** 2);
    return Math.floor(fromEdge / 2.2);
  });
  return outline(art, { placement: "outside", connectivity: 4, color: parseHex(OUTLINE) }).image;
}

/** The lit ball with an 8-connected outline: doubled corners all around. */
export function doubledBall(): RgbaImage {
  const c = 15.5;
  const art = ball(32, 11, (x, y) => (x + y < 2 * c ? 3 : 1));
  return outline(art, { placement: "outside", connectivity: 8, color: parseHex(OUTLINE) }).image;
}

/** Copies `image` with `pixels` [x, y, color | null] changed (null erases). */
export function withPixels(image: RgbaImage, pixels: [number, number, string | null][]): RgbaImage {
  const out = { width: image.width, height: image.height, data: new Uint8Array(image.data) };
  for (const [x, y, color] of pixels) out.data.set(color === null ? [0, 0, 0, 0] : parseHex(color), (y * image.width + x) * 4);
  return out;
}

/** Outline pixels on the ball's left side replaced by the fill next to them. */
export function gappyBall(): RgbaImage {
  const art = litBall();
  const gaps: [number, number, string | null][] = [];
  for (let y = 11; y <= 20; y++) {
    // The leftmost drawn pixel of the row is the outline; recolor it with its right neighbour.
    const row = art.data.subarray(y * 32 * 4, (y + 1) * 32 * 4);
    let x = 0;
    while (x < 32 && row[x * 4 + 3] === 0) x++;
    const next = x + 1;
    const hex = `#${[0, 1, 2].map((c) => row[next * 4 + c].toString(16).padStart(2, "0")).join("")}`;
    gaps.push([x, y, hex]);
  }
  return withPixels(art, gaps);
}

/** Semi-transparent ring around the ball: anti-aliased against a background that isn't there. */
export function softBall(): RgbaImage {
  const art = litBall();
  const out = { width: art.width, height: art.height, data: new Uint8Array(art.data) };
  for (let y = 1; y < 31; y++) {
    for (let x = 1; x < 31; x++) {
      const o = (y * 32 + x) * 4;
      if (art.data[o + 3] !== 0) continue;
      const touches = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => art.data[((y + dy) * 32 + x + dx) * 4 + 3] === 255);
      if (touches) out.data.set([26, 28, 44, 96], o);
    }
  }
  return out;
}

/** A light, opaque fringe around the outline: art cut out of a white background. */
export function fringedBall(): RgbaImage {
  return outline(litBall(), { placement: "outside", connectivity: 4, color: parseHex("#c8c8d0") }).image;
}

/** Every fill pixel slightly off its color: what a blurry resize or an AI render leaves. */
export function noisyBall(): RgbaImage {
  const art = litBall();
  const out = { width: art.width, height: art.height, data: new Uint8Array(art.data) };
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let o = 0; o < out.data.length; o += 4) {
    if (out.data[o + 3] === 0 || out.data[o] === 0x1a) continue;
    for (let c = 0; c < 3; c++) out.data[o + c] = Math.max(0, Math.min(255, out.data[o + c] + Math.round((random() - 0.5) * 12)));
  }
  return out;
}

/** A lit ball in four nearly equal pale tones. */
export function paleBall(): RgbaImage {
  return litBall(32, 11, ["#c8d0e0", "#d2d9e6", "#dbe1ec", "#e4e9f1"]);
}

/** Diagonal shade stripes of equal width, all stepping in lockstep. */
export function bandedTile(): RgbaImage {
  const size = 24;
  const image = createRgbaImage(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = x >= 2 && y >= 2 && x < size - 2 && y < size - 2;
      if (!inside) continue;
      const band = Math.floor((x + y) / 2) % (RAMP.length * 2);
      const level = band < RAMP.length ? band : RAMP.length * 2 - 1 - band;
      image.data.set(parseHex(RAMP[level]), (y * size + x) * 4);
    }
  }
  return outline(image, { placement: "inside", connectivity: 4, color: parseHex(OUTLINE) }).image;
}
