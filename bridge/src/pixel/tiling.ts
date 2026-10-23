import { labDistance, oklabCache } from "./color.js";
import { createRgbaImage, type RgbaImage } from "./RgbaImage.js";

/** The image repeated `columns` x `rows` times, edge to edge, as a tiled floor or wall shows it. */
export function tileImage(image: RgbaImage, columns = 3, rows = 3): RgbaImage {
  const { width, height } = image;
  const out = createRgbaImage(width * columns, height * rows);
  for (let y = 0; y < out.height; y++) {
    const src = image.data.subarray((y % height) * width * 4, ((y % height) + 1) * width * 4);
    for (let c = 0; c < columns; c++) out.data.set(src, (y * out.width + c * width) * 4);
  }
  return out;
}

export interface SeamAxis {
  /** Mean color jump across the wrap-around seam (right edge next to left edge, or bottom next to top). */
  seam: number;
  /** Mean color jump between neighbouring columns (or rows) inside the tile: what the seam should look like. */
  interior: number;
}

export interface SeamReport {
  /** Left and right edges meeting when tiles sit side by side. */
  horizontal: SeamAxis;
  /** Top and bottom edges meeting when tiles stack. */
  vertical: SeamAxis;
}

/**
 * How visible the seams of a repeating tile are. A seamless tile's opposite edges
 * continue each other like any two neighbouring columns inside it, so the seam jump is
 * compared with the tile's own interior jumps. Colors are compared in OKLab (0..1);
 * visible against transparent counts as 1.
 */
export function seamReport(image: RgbaImage): SeamReport {
  const { width, height, data } = image;
  const lab = oklabCache();
  const diff = (p: number, q: number) => {
    const a = data[p + 3] >= 128;
    const b = data[q + 3] >= 128;
    if (!a || !b) return a === b ? 0 : 1;
    return labDistance(lab(data[p], data[p + 1], data[p + 2]), lab(data[q], data[q + 1], data[q + 2]));
  };
  const at = (x: number, y: number) => (y * width + x) * 4;
  const mean = (total: number, count: number) => (count > 0 ? total / count : 0);

  let seamX = 0;
  let insideX = 0;
  for (let y = 0; y < height; y++) {
    seamX += diff(at(width - 1, y), at(0, y));
    for (let x = 1; x < width; x++) insideX += diff(at(x - 1, y), at(x, y));
  }
  let seamY = 0;
  let insideY = 0;
  for (let x = 0; x < width; x++) {
    seamY += diff(at(x, height - 1), at(x, 0));
    for (let y = 1; y < height; y++) insideY += diff(at(x, y - 1), at(x, y));
  }
  return {
    horizontal: { seam: mean(seamX, height), interior: mean(insideX, (width - 1) * height) },
    vertical: { seam: mean(seamY, width), interior: mean(insideY, width * (height - 1)) },
  };
}

// A seam is visible when it jumps clearly more than the tile's own neighbours do...
const SEAM_RATIO = 2;
// ...and more than this, so flat tiles with a faint seam still pass.
const SEAM_FLOOR = 0.05;

export function seamVisible(axis: SeamAxis): boolean {
  return axis.seam > Math.max(SEAM_FLOOR, axis.interior * SEAM_RATIO);
}
