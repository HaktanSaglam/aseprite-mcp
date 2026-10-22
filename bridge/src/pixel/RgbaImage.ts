import type { PixelSource } from "./rawFormat.js";

/** Straight (non-premultiplied) RGBA, 4 bytes per pixel, row-major. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
  /**
   * Set on images read from a sprite (decodeRaw): how the pixels are stored there, so
   * an edit can be written back without disturbing the pixels it didn't change.
   */
  source?: PixelSource;
}

export function createRgbaImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

export function cloneImage(image: RgbaImage): RgbaImage {
  return { width: image.width, height: image.height, data: new Uint8Array(image.data) };
}
