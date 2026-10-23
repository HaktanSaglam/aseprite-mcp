import {
  formatHex,
  isOpaque,
  labDistance,
  oklabCache,
  packRgb,
  rgbToOklab,
  toleranceToDistance,
  type Lab,
  type Rgb,
  type Rgba,
} from "../color.js";
import { cloneImage, type RgbaImage } from "../RgbaImage.js";
import { NEIGHBOURS_4 } from "./neighbours.js";

export type BackgroundMode = "edges" | "color";

export interface RemoveBackgroundOptions {
  /**
   * "edges": flood-fill inward from the canvas border through the dominant border
   * color(s), so same-colored pixels inside the subject survive.
   * "color": remove every pixel near `color`, wherever it is.
   */
  mode?: BackgroundMode;
  color?: Rgba;
  /** 0..100, see toleranceToDistance. */
  tolerance?: number;
}

export interface RemoveBackgroundResult {
  image: RgbaImage;
  removed: number;
  /** The background color(s) that were removed, "#rrggbb". */
  colors: string[];
}

export interface BorderColor {
  color: Rgb;
  /** Share of all border pixels (transparent ones included) this color group covers. */
  share: number;
}

// Secondary background colors (the second tone of a fake-transparency checkerboard,
// ≈50% each) must be at least this fraction of the main one; a subject that merely
// touches the border covers far less and must not be taken for background.
const SECONDARY_RATIO = 0.5;
const MAX_BACKGROUND_COLORS = 4;
// Below this share of the border the "main" color is just one of many (noise, a busy
// scene): there is no background to detect, and guessing would erase real art.
const MIN_PRIMARY_SHARE = 0.15;

function borderIndices(width: number, height: number): number[] {
  const indices: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) indices.push(y * width + x);
    }
  }
  return indices;
}

/**
 * The opaque colors that dominate the canvas border, most common first. Similar colors
 * (within `maxDistance`) are grouped under the most frequent one, so noisy or
 * compressed backgrounds still form a single group. Empty when the border is mostly
 * transparent already: then there is no opaque background to find.
 */
export function dominantBorderColors(image: RgbaImage, maxDistance: number): BorderColor[] {
  const border = borderIndices(image.width, image.height);
  if (border.length === 0) return [];
  const counts = new Map<number, number>();
  let transparent = 0;
  for (const i of border) {
    const o = i * 4;
    if (!isOpaque(image.data[o + 3])) {
      transparent++;
      continue;
    }
    const key = packRgb(image.data[o], image.data[o + 1], image.data[o + 2]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const groups: { color: Rgb; lab: Lab; count: number }[] = [];
  const sorted = [...counts].sort((p, q) => q[1] - p[1] || p[0] - q[0]);
  for (const [key, count] of sorted) {
    const color: Rgb = [(key >> 16) & 255, (key >> 8) & 255, key & 255];
    const lab = rgbToOklab(...color);
    const group = groups.find((g) => labDistance(g.lab, lab) <= maxDistance);
    if (group) group.count += count;
    else groups.push({ color, lab, count });
  }
  groups.sort((p, q) => q.count - p.count);
  if (groups.length === 0 || groups[0].count < border.length * MIN_PRIMARY_SHARE) return [];
  const background = groups
    .filter((g) => g.count >= groups[0].count * SECONDARY_RATIO)
    .slice(0, MAX_BACKGROUND_COLORS);
  if (background.reduce((sum, g) => sum + g.count, 0) <= transparent) return [];
  return background.map((g) => ({ color: g.color, share: g.count / border.length }));
}

export function removeBackground(
  image: RgbaImage,
  options: RemoveBackgroundOptions = {},
): RemoveBackgroundResult {
  const mode = options.mode ?? "edges";
  const maxDistance = toleranceToDistance(options.tolerance ?? 10);
  let targets: Rgb[];
  if (mode === "color") {
    if (!options.color) throw new Error('mode "color" needs a color (e.g. "#ffffff"); mode "edges" finds it automatically');
    if (!isOpaque(options.color[3])) throw new Error("The background color must be opaque");
    targets = [[options.color[0], options.color[1], options.color[2]]];
  } else {
    targets = dominantBorderColors(image, maxDistance).map((g) => g.color);
  }
  const colors = targets.map((c) => formatHex(...c));
  if (targets.length === 0) return { image: cloneImage(image), removed: 0, colors };

  const { width, height, data } = image;
  const targetLabs = targets.map((c) => rgbToOklab(...c));
  const lab = oklabCache();
  const matches = (i: number) => {
    const o = i * 4;
    if (data[o + 3] === 0) return false;
    const p = lab(data[o], data[o + 1], data[o + 2]);
    return targetLabs.some((t) => labDistance(p, t) <= maxDistance);
  };

  const out = cloneImage(image);
  let removed = 0;
  const clear = (i: number) => {
    out.data.fill(0, i * 4, i * 4 + 4);
    removed++;
  };

  if (mode === "color") {
    for (let i = 0; i < width * height; i++) if (matches(i)) clear(i);
    return { image: out, removed, colors };
  }

  // Already see-through pixels are passable too, so background pockets that only
  // connect to the border through erased areas are still reached.
  const visited = new Uint8Array(width * height);
  const passable = (i: number) => !isOpaque(data[i * 4 + 3]) || matches(i);
  const stack: number[] = [];
  for (const i of borderIndices(width, height)) {
    if (!visited[i] && passable(i)) {
      visited[i] = 1;
      stack.push(i);
    }
  }
  while (stack.length > 0) {
    const i = stack.pop()!;
    if (matches(i)) clear(i);
    const x = i % width;
    const y = (i - x) / width;
    for (const [dx, dy] of NEIGHBOURS_4) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = ny * width + nx;
      if (visited[n] || !passable(n)) continue;
      visited[n] = 1;
      stack.push(n);
    }
  }
  return { image: out, removed, colors };
}
