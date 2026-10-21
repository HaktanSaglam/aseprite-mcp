import { darkerShade, oklabCache, type Rgba } from "../color.js";
import { cloneImage, type RgbaImage } from "../RgbaImage.js";
import { NEIGHBOURS_4, NEIGHBOURS_8, opaqueMask } from "./neighbours.js";

export type OutlinePlacement = "outside" | "inside";

export interface OutlineOptions {
  /** "outside" grows the shape by one pixel; "inside" recolors its edge pixels. */
  placement?: OutlinePlacement;
  /** 4 gives the clean, corner-less outline most pixel art uses; 8 also fills diagonal corners. */
  connectivity?: 4 | 8;
  /** Fixed color. Omitted → a darker, hue-shifted shade of the adjacent art. */
  color?: Rgba;
}

// How much lightness the automatic outline removes: dark enough to read as a line.
const AUTO_DARKEN = 0.6;

/**
 * 1px outline around everything opaque. Neighbours beyond the canvas are ignored, so
 * art cut off by the canvas edge is not boxed in. Returns the number of pixels painted.
 */
export function outline(image: RgbaImage, options: OutlineOptions = {}): { image: RgbaImage; changed: number } {
  const { width, height, data } = image;
  const placement = options.placement ?? "outside";
  const neighbours = options.connectivity === 8 ? NEIGHBOURS_8 : NEIGHBOURS_4;
  const mask = opaqueMask(image);
  const lab = oklabCache();
  const out = cloneImage(image);
  const shadeCache = new Map<number, Rgba>();
  let changed = 0;

  const autoColor = (o: number): Rgba => {
    const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
    let shade = shadeCache.get(key);
    if (!shade) {
      shade = [...darkerShade([data[o], data[o + 1], data[o + 2]], AUTO_DARKEN), 255];
      shadeCache.set(key, shade);
    }
    return shade;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const wantOpaque = placement === "inside" ? 1 : 0;
      if (mask[i] !== wantOpaque) continue;

      // outside: darkest opaque neighbour decides the shade; inside: any see-through neighbour.
      let source = -1;
      let darkest = Number.POSITIVE_INFINITY;
      let touches = false;
      for (const [dx, dy] of neighbours) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if (placement === "inside") {
          if (!mask[n]) {
            touches = true;
            break;
          }
        } else if (mask[n]) {
          touches = true;
          const L = lab(data[n * 4], data[n * 4 + 1], data[n * 4 + 2])[0];
          if (L < darkest) {
            darkest = L;
            source = n;
          }
        }
      }
      if (!touches) continue;

      const color = options.color ?? autoColor(placement === "inside" ? i * 4 : source * 4);
      out.data.set(color, i * 4);
      changed++;
    }
  }
  return { image: out, changed };
}
