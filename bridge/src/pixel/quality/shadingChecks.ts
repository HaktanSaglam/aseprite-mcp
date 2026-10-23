import type { Rect } from "../../aseprite/protocol.js";
import { NEIGHBOURS_4 } from "../effects/neighbours.js";
import { boundsOf, keyAt, locate, type Finding, type QualityContext } from "./context.js";

// --- Banding -------------------------------------------------------------------------

const BANDING_WEIGHT = 20;
// Bands wider than this are shading areas, not stripes.
const MAX_BAND_WIDTH = 4;
// Shades closer than this (OKLab L) don't form a ramp step.
const MIN_STEP = 0.02;
// A band must keep its width and colors for this many rows (or columns) in a row.
const MIN_CHAIN = 3;
const MIN_BANDED_PIXELS = 12;
const MIN_BANDED_SHARE = 0.03;
const FULL_BANDED_SHARE = 0.12;

interface Run {
  start: number;
  length: number;
  /** Packed color, or -1 for transparent. */
  key: number;
  lightness: number;
}

interface Band {
  signature: string;
  start: number;
  length: number;
  next?: Band;
  /** Rows (or columns) this band continues for, counting itself. */
  chain: number;
}

function runsOf(ctx: QualityContext, count: number, index: (k: number) => number): Run[] {
  const runs: Run[] = [];
  for (let k = 0; k < count; k++) {
    const i = index(k);
    const key = ctx.opaque[i] ? keyAt(ctx.image.data, i) : -1;
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.length++;
    else runs.push({ start: k, length: 1, key, lightness: ctx.lightness[i] });
  }
  return runs;
}

/** Narrow runs that sit between a darker and a lighter shade: one step of a ramp. */
function bandsOf(runs: Run[], outlineColors: ReadonlySet<number>): Band[] {
  const bands: Band[] = [];
  for (let r = 1; r + 1 < runs.length; r++) {
    const [a, b, c] = [runs[r - 1], runs[r], runs[r + 1]];
    if (a.key < 0 || b.key < 0 || c.key < 0 || b.length > MAX_BAND_WIDTH) continue;
    // The outline is a band around everything by design.
    if (outlineColors.has(a.key) || outlineColors.has(b.key) || outlineColors.has(c.key)) continue;
    const rising = a.lightness + MIN_STEP < b.lightness && b.lightness + MIN_STEP < c.lightness;
    const falling = a.lightness > b.lightness + MIN_STEP && b.lightness > c.lightness + MIN_STEP;
    if (!rising && !falling) continue;
    bands.push({ signature: `${a.key}|${b.key}|${c.key}|${b.length}`, start: b.start, length: b.length, chain: 1 });
  }
  return bands;
}

/**
 * Marks the pixels of bands that follow each other line after line with the same width
 * and colors, shifted by a pixel or two: the stair-stepped parallel stripes of banding.
 * Straight stripes (shift 0, e.g. a cylinder's columns or a sky gradient) are fine.
 */
function markBanding(
  ctx: QualityContext,
  lines: number,
  length: number,
  index: (line: number, k: number) => number,
  marked: Uint8Array,
): void {
  const perLine = Array.from({ length: lines }, (_, t) =>
    bandsOf(runsOf(ctx, length, (k) => index(t, k)), ctx.outline.colors),
  );
  for (let t = lines - 2; t >= 0; t--) {
    for (const band of perLine[t]) {
      const next = perLine[t + 1].find((c) => {
        const shift = Math.abs(c.start - band.start);
        return c.signature === band.signature && shift >= 1 && shift <= 2;
      });
      if (!next) continue;
      band.next = next;
      band.chain = 1 + next.chain;
    }
  }
  perLine.forEach((bands, t) => {
    for (const band of bands) {
      if (band.chain < MIN_CHAIN) continue;
      let current: Band | undefined = band;
      for (let line = t; current; line++, current = current.next) {
        for (let k = current.start; k < current.start + current.length; k++) marked[index(line, k)] = 1;
      }
    }
  });
}

export function banding(ctx: QualityContext): Finding | undefined {
  const { width, height } = ctx;
  const marked = new Uint8Array(width * height);
  markBanding(ctx, height, width, (y, x) => y * width + x, marked);
  markBanding(ctx, width, height, (x, y) => y * width + x, marked);
  const pixels: number[] = [];
  marked.forEach((m, i) => m && pixels.push(i));
  const share = ctx.visible > 0 ? pixels.length / ctx.visible : 0;
  if (pixels.length < MIN_BANDED_PIXELS || share < MIN_BANDED_SHARE) return undefined;
  return {
    kind: "banding",
    message:
      `Banding: ${pixels.length} pixels of shade bands run parallel in equal-width stair steps, which shows the ` +
      "pixel grid. Vary the band widths, merge a shade or dither the transition (draw_script with base:\"current\").",
    ...locate(pixels, width),
    fixWith: "draw_script",
    penalty: BANDING_WEIGHT * Math.min(1, share / FULL_BANDED_SHARE),
  };
}

// --- Pillow shading ------------------------------------------------------------------

const PILLOW_WEIGHT = 20;
// Smaller shapes don't have room for shading rings.
const MIN_COMPONENT = 40;
const MIN_RINGS = 3;
// Flat (unshaded) shapes are not pillow shaded.
const MIN_LIGHTNESS_SPREAD = 0.03;
// Lightness rises toward the middle at least this consistently (Pearson r)...
const MIN_DEPTH_CORRELATION = 0.5;
// ...and each ring is nearly one value: the depth explains this share of the variation.
const MIN_RING_SHARE = 0.6;
const FULL_RING_SHARE = 0.9;

/** 8-connected groups of drawn pixels that don't touch the canvas border (those are scenery). */
function components(ctx: QualityContext): number[][] {
  const { width, height, opaque } = ctx;
  const seen = new Uint8Array(width * height);
  const groups: number[][] = [];
  for (let start = 0; start < seen.length; start++) {
    if (!opaque[start] || seen[start]) continue;
    const group = [start];
    seen[start] = 1;
    let touchesBorder = false;
    for (let g = 0; g < group.length; g++) {
      const i = group[g];
      const x = i % width;
      const y = (i - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const n = ny * width + nx;
          if (opaque[n] && !seen[n]) {
            seen[n] = 1;
            group.push(n);
          }
        }
      }
    }
    if (!touchesBorder && group.length >= MIN_COMPONENT) groups.push(group);
  }
  return groups;
}

/** Distance (4-steps) from the shape's edge: 1 on the edge, 2 just inside, ... */
function depths(ctx: QualityContext, group: number[]): Map<number, number> {
  const { width, height, opaque } = ctx;
  const depth = new Map<number, number>();
  const queue: number[] = [];
  for (const i of group) {
    const x = i % width;
    const y = (i - x) / width;
    const edge = NEIGHBOURS_4.some(([dx, dy]) => {
      const nx = x + dx;
      const ny = y + dy;
      return nx < 0 || ny < 0 || nx >= width || ny >= height || !opaque[ny * width + nx];
    });
    if (edge) {
      depth.set(i, 1);
      queue.push(i);
    }
  }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const x = i % width;
    const y = (i - x) / width;
    for (const [dx, dy] of NEIGHBOURS_4) {
      const n = (y + dy) * width + (x + dx);
      if (opaque[n] && !depth.has(n)) {
        depth.set(n, depth.get(i)! + 1);
        queue.push(n);
      }
    }
  }
  return depth;
}

interface PillowScore {
  ringShare: number;
  region: Rect;
}

/**
 * Pillow shading: the shape gets lighter ring by ring toward its middle, the same all
 * the way round, instead of being lit from one side. Measured as how much of the
 * lightness variation the distance from the edge explains, and whether lightness rises
 * with that distance.
 */
function pillowScore(ctx: QualityContext, group: number[]): PillowScore | undefined {
  const depth = depths(ctx, group);
  // The outline ring is dark by design: rings start inside it.
  const skip = ctx.outline.present ? 1 : 0;
  const samples: [number, number][] = [];
  for (const i of group) {
    const d = depth.get(i)! - skip;
    if (d >= 1) samples.push([d, ctx.lightness[i]]);
  }
  const rings = new Map<number, { n: number; sum: number; sumSq: number }>();
  let n = 0;
  let sumD = 0;
  let sumL = 0;
  for (const [d, l] of samples) {
    const ring = rings.get(d) ?? { n: 0, sum: 0, sumSq: 0 };
    ring.n++;
    ring.sum += l;
    ring.sumSq += l * l;
    rings.set(d, ring);
    n++;
    sumD += d;
    sumL += l;
  }
  if (rings.size < MIN_RINGS || n < MIN_COMPONENT / 2) return undefined;
  const meanD = sumD / n;
  const meanL = sumL / n;
  let total = 0;
  let covariance = 0;
  let varianceD = 0;
  for (const [d, l] of samples) {
    total += (l - meanL) ** 2;
    covariance += (d - meanD) * (l - meanL);
    varianceD += (d - meanD) ** 2;
  }
  if (Math.sqrt(total / n) < MIN_LIGHTNESS_SPREAD || varianceD === 0) return undefined;
  const correlation = covariance / Math.sqrt(total * varianceD);
  let within = 0;
  for (const ring of rings.values()) within += ring.sumSq - (ring.sum * ring.sum) / ring.n;
  const ringShare = 1 - within / total;
  if (correlation < MIN_DEPTH_CORRELATION || ringShare < MIN_RING_SHARE) return undefined;
  return { ringShare, region: boundsOf(group, ctx.width) };
}

export function pillowShading(ctx: QualityContext): Finding | undefined {
  let worst: PillowScore | undefined;
  for (const group of components(ctx)) {
    const score = pillowScore(ctx, group);
    if (score && (!worst || score.ringShare > worst.ringShare)) worst = score;
  }
  if (!worst) return undefined;
  const strength = Math.min(1, (worst.ringShare - MIN_RING_SHARE) / (FULL_RING_SHARE - MIN_RING_SHARE));
  return {
    kind: "pillow_shading",
    message:
      "Pillow shading: the shape darkens evenly toward every edge, so it looks flat and puffy. Pick one light " +
      "direction (top-left): highlights on that side, the darkest shade on the opposite side (draw_script with " +
      'base:"current").',
    x: worst.region.x,
    y: worst.region.y,
    region: worst.region,
    fixWith: "draw_script",
    penalty: PILLOW_WEIGHT * (0.5 + 0.5 * strength),
  };
}

// --- Contrast ------------------------------------------------------------------------

const CONTRAST_WEIGHT = 15;
// Lightness range (OKLab L, 5th to 95th percentile) below which shapes blur together at 1x.
const MIN_VALUE_RANGE = 0.25;
const FULL_LOW_CONTRAST = 0.2;
const MIN_PIXELS_FOR_CONTRAST = 16;

/**
 * The value range of the art itself: a dark outline around pale, nearly equal tones still
 * reads as one flat blob, so outline pixels don't count.
 */
export function lowContrast(ctx: QualityContext, uniqueColors: number): Finding | undefined {
  const values: number[] = [];
  ctx.opaque.forEach((o, i) => {
    if (o && !ctx.outline.colors.has(keyAt(ctx.image.data, i))) values.push(ctx.lightness[i]);
  });
  const fillColors = uniqueColors - ctx.outline.colors.size;
  if (values.length < MIN_PIXELS_FOR_CONTRAST || fillColors < 2) return undefined;
  values.sort((p, q) => p - q);
  const low = values[Math.floor(values.length * 0.05)];
  const high = values[Math.min(values.length - 1, Math.floor(values.length * 0.95))];
  const range = high - low;
  if (range >= MIN_VALUE_RANGE) return undefined;
  const pixels: number[] = [];
  ctx.opaque.forEach((o, i) => o && pixels.push(i));
  return {
    kind: "low_contrast",
    message:
      `Low contrast: almost all pixels lie within ${Math.round(range * 100)}% of the lightness scale, so shapes ` +
      "blur together at 1x. Widen the ramps: darker darks and lighter lights (adjust_colors {contrast: 30}).",
    region: boundsOf(pixels, ctx.width),
    fixWith: "adjust_colors",
    penalty: CONTRAST_WEIGHT * Math.min(1, (MIN_VALUE_RANGE - range) / FULL_LOW_CONTRAST),
  };
}
