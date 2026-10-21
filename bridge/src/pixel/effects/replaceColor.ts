import { isOpaque, labDistance, oklabCache, rgbToOklab, toleranceToDistance, type Rgba } from "../color.js";
import { cloneImage, type RgbaImage } from "../RgbaImage.js";

/**
 * Swaps one color for another everywhere. `tolerance` (0..100) also catches near
 * shades; they all become exactly `to`, keeping pixel art flat. A transparent `from`
 * fills every see-through pixel, a transparent `to` erases.
 */
export function replaceColor(
  image: RgbaImage,
  from: Rgba,
  to: Rgba,
  tolerance = 0,
): { image: RgbaImage; replaced: number } {
  const out = cloneImage(image);
  const data = image.data;
  const fromOpaque = isOpaque(from[3]);
  const fromLab = rgbToOklab(from[0], from[1], from[2]);
  const maxDistance = toleranceToDistance(tolerance);
  const lab = oklabCache();
  let replaced = 0;

  for (let o = 0; o < data.length; o += 4) {
    const opaque = isOpaque(data[o + 3]);
    if (opaque !== fromOpaque) continue;
    if (opaque && labDistance(lab(data[o], data[o + 1], data[o + 2]), fromLab) > maxDistance) continue;
    if (data[o] === to[0] && data[o + 1] === to[1] && data[o + 2] === to[2] && data[o + 3] === to[3]) continue;
    out.data.set(to, o);
    replaced++;
  }
  return { image: out, replaced };
}
