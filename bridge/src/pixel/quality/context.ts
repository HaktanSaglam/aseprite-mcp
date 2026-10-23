import type { Rect } from "../../aseprite/protocol.js";
import { colorDistance, formatHex, isOpaque, oklabCache } from "../color.js";
import { NEIGHBOURS_4 } from "../effects/neighbours.js";
import type { RgbaImage } from "../RgbaImage.js";

export type IssueKind =
  | "stray_pixels"
  | "outline_gaps"
  | "doubled_corners"
  | "banding"
  | "pillow_shading"
  | "low_contrast"
  | "aa_against_transparency"
  | "too_many_colors"
  | "near_duplicate_colors";

/** One problem as analyze_sprite reports it. */
export interface QualityIssue {
  kind: IssueKind;
  message: string;
  /** A pixel showing the problem (the first one found). */
  x?: number;
  y?: number;
  /** The area holding every instance, when there are several. */
  region?: Rect;
  /** The tool that fixes it. */
  fixWith: string;
}

/** A detector's result: the issue plus how many score points it costs. */
export interface Finding extends QualityIssue {
  penalty: number;
}

/** Everything detectors share, computed once per image. */
export interface QualityContext {
  image: RgbaImage;
  width: number;
  height: number;
  /** 1 where alpha >= 128: the pixel counts as drawn. */
  opaque: Uint8Array;
  /** OKLab lightness (0..1) of every drawn pixel. */
  lightness: Float32Array;
  visible: number;
  outline: OutlineInfo;
}

export interface OutlineInfo {
  /** The art has a dark outline: most of its edge is darker than the pixels just inside. */
  present: boolean;
  /** Packed rgba keys of the outline colors (empty without an outline). */
  colors: Set<number>;
  /** Outline pixels found along the edge. */
  edge: number;
  /** Edge pixels that could be compared with the pixels inside them. */
  classified: number;
  /** Edge pixels in a fill color that touch transparency: holes in the outline. */
  gaps: number[];
  /**
   * Lighter pixels outside a dark line (the outline, or a dark line one pixel inside the
   * edge): anti-aliasing toward a background that isn't there.
   */
  halo: number[];
}

// An outline pixel is at least this much darker (OKLab L) than the fill next to it.
const OUTLINE_DARKER = 0.06;
// Share of the classified edge pixels that must be darker for the art to count as outlined.
const OUTLINED_SHARE = 0.7;
// Fewer classified edge pixels than this can't tell whether the art is outlined.
const MIN_EDGE_PIXELS = 8;
// Outline colors: the most common colors of the outline pixels, covering this share.
const OUTLINE_COLOR_SHARE = 0.9;
const MAX_OUTLINE_COLORS = 4;
// Neighbouring shades of one material (OKLab distance): the fill continuing inward.
const SAME_MATERIAL = 0.1;
// How much lighter than the outline (OKLab L) a pixel must be to show the fill through a gap.
const GAP_LIGHTER = 0.1;

/** Pixel i's packed rgba, for comparing and counting colors. */
export function keyAt(data: Uint8Array, i: number): number {
  const o = i * 4;
  return ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>> 0;
}

export function hexOfKey(key: number): string {
  return formatHex(key >>> 24, (key >>> 16) & 255, (key >>> 8) & 255, key & 255);
}

/** Bounding box of pixel indexes. */
export function boundsOf(indexes: readonly number[], width: number): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (const i of indexes) {
    const x = i % width;
    const y = (i - x) / width;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** x/y of the first instance, plus the region of all of them when there are several. */
export function locate(indexes: readonly number[], width: number): Pick<QualityIssue, "x" | "y" | "region"> {
  if (indexes.length === 0) return {};
  const first = indexes[0];
  const place = { x: first % width, y: Math.floor(first / width) };
  return indexes.length > 1 ? { ...place, region: boundsOf(indexes, width) } : place;
}

function rgbAt(data: Uint8Array, i: number): [number, number, number] {
  return [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
}

/**
 * Edge pixels (drawn, with a transparent 4-neighbour inside the canvas; the canvas border
 * doesn't count, tiles run off it) compared with the differently colored drawn pixels just
 * inside them. In an outlined sprite nearly all are darker, and their colors are the
 * outline colors. Then edge pixels in another color are gaps when their own material
 * continues inward (the fill reaches the transparency), or a halo when they sit outside
 * an outline pixel; anything else (a shadow, a detail) is left alone.
 */
function analyzeOutline(image: RgbaImage, opaque: Uint8Array, lightness: Float32Array): OutlineInfo {
  const { width, height, data } = image;
  const isEdge = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!opaque[i]) continue;
      isEdge[i] = NEIGHBOURS_4.some(([dx, dy]) => {
        const nx = x + dx;
        const ny = y + dy;
        return nx >= 0 && ny >= 0 && nx < width && ny < height && !opaque[ny * width + nx];
      })
        ? 1
        : 0;
    }
  }
  const innerOf = (i: number): number[] => {
    const x = i % width;
    const y = (i - x) / width;
    const inner: number[] = [];
    for (const [dx, dy] of NEIGHBOURS_4) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = ny * width + nx;
      if (opaque[n] && !isEdge[n]) inner.push(n);
    }
    return inner;
  };

  const darker: number[] = [];
  let notDarker = 0;
  for (let i = 0; i < isEdge.length; i++) {
    if (!isEdge[i]) continue;
    // Inner pixels of the same color are the same line or area going on (a 2px outline):
    // they say nothing about whether the edge is darker. Thin parts have no inside at all.
    const others = innerOf(i).filter((n) => keyAt(data, n) !== keyAt(data, i));
    if (others.length === 0) continue;
    const innerL = others.reduce((sum, n) => sum + lightness[n], 0) / others.length;
    if (lightness[i] <= innerL - OUTLINE_DARKER) darker.push(i);
    else notDarker++;
  }
  const classified = darker.length + notDarker;
  const present = classified >= MIN_EDGE_PIXELS && darker.length >= classified * OUTLINED_SHARE;
  if (!present) {
    return { present, colors: new Set(), edge: 0, classified, gaps: [], halo: fringe(image, opaque, lightness, isEdge, innerOf) };
  }

  const counts = new Map<number, number>();
  for (const i of darker) counts.set(keyAt(data, i), (counts.get(keyAt(data, i)) ?? 0) + 1);
  const colors = new Set<number>();
  let covered = 0;
  for (const [key, count] of [...counts].sort((p, q) => q[1] - p[1])) {
    if (covered >= darker.length * OUTLINE_COLOR_SHARE || colors.size >= MAX_OUTLINE_COLORS) break;
    colors.add(key);
    covered += count;
  }

  const outlineEdge = darker.filter((i) => colors.has(keyAt(data, i)));
  const outlineL = outlineEdge.reduce((sum, i) => sum + lightness[i], 0) / Math.max(1, outlineEdge.length);
  const gaps: number[] = [];
  const halo: number[] = [];
  for (let i = 0; i < isEdge.length; i++) {
    if (!isEdge[i] || colors.has(keyAt(data, i))) continue;
    const inner = innerOf(i);
    if (inner.some((n) => colors.has(keyAt(data, n)))) {
      halo.push(i);
      continue;
    }
    // A gap shows the (lighter) fill where the dark line should be; a dark edge pixel
    // without outline (a ground shadow, a dark rim) is drawn that way on purpose.
    const showsFill = lightness[i] >= outlineL + GAP_LIGHTER;
    if (showsFill && inner.some((n) => colorDistance(rgbAt(data, i), rgbAt(data, n)) < SAME_MATERIAL)) gaps.push(i);
  }
  return { present, colors, edge: darker.length, classified, gaps, halo };
}

/**
 * Without a dark edge there may still be a dark line one pixel inside it, wrapped in a
 * lighter fringe: the leftover of art drawn on a light background (a removed backdrop, a
 * resize). Returns the fringe pixels: edge pixels lighter than a dark line just inside.
 */
function fringe(
  image: RgbaImage,
  opaque: Uint8Array,
  lightness: Float32Array,
  isEdge: Uint8Array,
  innerOf: (i: number) => number[],
): number[] {
  const { data } = image;
  // The ring right inside the edge; a dark line there is compared with what lies behind it.
  const secondRing = new Uint8Array(isEdge.length);
  for (let i = 0; i < isEdge.length; i++) if (isEdge[i]) for (const q of innerOf(i)) secondRing[q] = 1;
  const darkLine = (q: number) => {
    const deeper = innerOf(q).filter((r) => !secondRing[r] && keyAt(data, r) !== keyAt(data, q));
    if (deeper.length === 0) return false;
    const deeperL = deeper.reduce((sum, r) => sum + lightness[r], 0) / deeper.length;
    return lightness[q] <= deeperL - OUTLINE_DARKER;
  };
  const found: number[] = [];
  for (let i = 0; i < isEdge.length; i++) {
    if (!isEdge[i] || !opaque[i]) continue;
    const inside = innerOf(i).filter((q) => keyAt(data, q) !== keyAt(data, i));
    if (inside.some((q) => lightness[i] >= lightness[q] + OUTLINE_DARKER && darkLine(q))) found.push(i);
  }
  return found;
}

export function buildContext(image: RgbaImage): QualityContext {
  const { width, height, data } = image;
  const opaque = new Uint8Array(width * height);
  const lightness = new Float32Array(width * height);
  const lab = oklabCache();
  let visible = 0;
  for (let i = 0; i < opaque.length; i++) {
    if (!isOpaque(data[i * 4 + 3])) continue;
    opaque[i] = 1;
    visible++;
    lightness[i] = lab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2])[0];
  }
  return { image, width, height, opaque, lightness, visible, outline: analyzeOutline(image, opaque, lightness) };
}
