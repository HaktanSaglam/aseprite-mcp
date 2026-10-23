import { isOpaque } from "../color.js";
import type { RgbaImage } from "../RgbaImage.js";

export const NEIGHBOURS_4: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export const NEIGHBOURS_8: readonly (readonly [number, number])[] = [
  ...NEIGHBOURS_4,
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** 1 per pixel that counts as drawn (alpha >= 128), so neighbour checks stay cheap. */
export function opaqueMask(image: RgbaImage): Uint8Array {
  const mask = new Uint8Array(image.width * image.height);
  for (let i = 0; i < mask.length; i++) mask[i] = isOpaque(image.data[i * 4 + 3]) ? 1 : 0;
  return mask;
}

/** Opaque 8-neighbours of (x, y); pixels beyond the canvas don't count. */
export function countOpaqueNeighbours(mask: Uint8Array, width: number, height: number, x: number, y: number): number {
  let count = 0;
  for (const [dx, dy] of NEIGHBOURS_8) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < width && ny < height && mask[ny * width + nx]) count++;
  }
  return count;
}
