import { isOpaque, labDistance, oklabCache, rgbToOklab, toleranceToDistance, type Lab, type Rgba } from "../color.js";
import { cloneImage, type RgbaImage } from "../RgbaImage.js";

export interface ColorSwap {
  from: Rgba;
  to: Rgba;
}

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
  const result = replaceColors(image, [{ from, to }], tolerance);
  return { image: result.image, replaced: result.replaced[0] };
}

/**
 * Several swaps in one pass, all matched against the original pixels, so they never
 * chain: red→blue plus blue→red trades the two colors (a palette swap). With tolerance a
 * pixel near several `from` colors takes the swap of the nearest one. `replaced[i]`
 * counts the pixels swap i changed.
 */
export function replaceColors(
  image: RgbaImage,
  swaps: readonly ColorSwap[],
  tolerance = 0,
): { image: RgbaImage; replaced: number[] } {
  const out = cloneImage(image);
  const data = image.data;
  const maxDistance = toleranceToDistance(tolerance);
  const lab = oklabCache();
  const prepared = swaps.map(({ from, to }) => ({ opaque: isOpaque(from[3]), lab: rgbToOklab(from[0], from[1], from[2]), to }));
  const replaced = swaps.map(() => 0);

  for (let o = 0; o < data.length; o += 4) {
    const opaque = isOpaque(data[o + 3]);
    const pixelLab: Lab | undefined = opaque ? lab(data[o], data[o + 1], data[o + 2]) : undefined;
    let chosen = -1;
    let chosenDistance = Number.POSITIVE_INFINITY;
    prepared.forEach((swap, i) => {
      if (swap.opaque !== opaque) return;
      const distance = pixelLab ? labDistance(pixelLab, swap.lab) : 0;
      if (distance <= maxDistance && distance < chosenDistance) {
        chosen = i;
        chosenDistance = distance;
      }
    });
    if (chosen < 0) continue;
    const to = prepared[chosen].to;
    if (data[o] === to[0] && data[o + 1] === to[1] && data[o + 2] === to[2] && data[o + 3] === to[3]) continue;
    out.data.set(to, o);
    replaced[chosen]++;
  }
  return { image: out, replaced };
}
