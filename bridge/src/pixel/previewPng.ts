import { PNG } from "pngjs";
import type { RgbaImage } from "./RgbaImage.js";

const CHECKER_LIGHT = 0xcc;
const CHECKER_DARK = 0x99;

/**
 * Builds a PNG meant for Claude's eyes, not for export: tiny sprites are upscaled
 * (nearest-neighbour, so pixels stay crisp) and transparency sits on a checkerboard,
 * otherwise dark outlines on a transparent background would vanish.
 */
export function renderPreviewPng(image: RgbaImage, scale: number): Buffer {
  const png = new PNG({ width: image.width * scale, height: image.height * scale });
  const checkerSize = Math.max(1, Math.floor(scale / 2));

  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const src = (Math.floor(y / scale) * image.width + Math.floor(x / scale)) * 4;
      const dst = (y * png.width + x) * 4;
      const alpha = image.data[src + 3] / 255;
      const checker =
        (Math.floor(x / checkerSize) + Math.floor(y / checkerSize)) % 2 === 0
          ? CHECKER_LIGHT
          : CHECKER_DARK;
      for (let c = 0; c < 3; c++) {
        png.data[dst + c] = Math.round(image.data[src + c] * alpha + checker * (1 - alpha));
      }
      png.data[dst + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** Integer scale that brings the longest side near `target` px without exceeding it. */
export function previewScale(width: number, height: number, target = 512): number {
  return Math.max(1, Math.floor(target / Math.max(width, height)));
}
