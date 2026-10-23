import type { PixelFilter } from "./composite.js";
import { createRgbaImage, type RgbaImage } from "./RgbaImage.js";

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The pixels of `region` as their own image. Pixels outside the image, or rejected by
 * `include` (canvas coordinates, e.g. "is it selected?"), come back transparent.
 */
export function extractRegion(image: RgbaImage, region: Region, include?: PixelFilter): RgbaImage {
  const out = createRgbaImage(region.width, region.height);
  for (let row = 0; row < region.height; row++) {
    const y = region.y + row;
    if (y < 0 || y >= image.height) continue;
    for (let col = 0; col < region.width; col++) {
      const x = region.x + col;
      if (x < 0 || x >= image.width || (include && !include(x, y))) continue;
      const src = (y * image.width + x) * 4;
      out.data.set(image.data.subarray(src, src + 4), (row * region.width + col) * 4);
    }
  }
  return out;
}

/**
 * A copy of `image` where `region` is cleared and `content` sits at its top-left corner;
 * content beyond the region or the image is dropped.
 */
export function replaceRegion(image: RgbaImage, region: Region, content: RgbaImage): RgbaImage {
  const out = { width: image.width, height: image.height, data: new Uint8Array(image.data) };
  for (let row = 0; row < region.height; row++) {
    const y = region.y + row;
    if (y < 0 || y >= image.height) continue;
    for (let col = 0; col < region.width; col++) {
      const x = region.x + col;
      if (x < 0 || x >= image.width) continue;
      const o = (y * image.width + x) * 4;
      if (row < content.height && col < content.width) {
        const src = (row * content.width + col) * 4;
        out.data.set(content.data.subarray(src, src + 4), o);
      } else {
        out.data.fill(0, o, o + 4);
      }
    }
  }
  return out;
}
