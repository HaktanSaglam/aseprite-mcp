import { downscaleDenoised } from "./denoiseBlocks.js";
import { createRgbaImage, type RgbaImage } from "./RgbaImage.js";
import { forEachCell, gridSize, type UpscaleGrid } from "./upscaleGrid.js";

export const MAX_UNZOOM_SCALE = 64;

const NO_GRID: UpscaleGrid = { scale: 1, offsetX: 0, offsetY: 0, fit: 1 };
// 1x art lines up with a k-grid by chance only ~1/k of the time, so requiring nearly all
// edges on the grid lines keeps detailed 1x art from being "unzoomed" by accident.
const MIN_FIT = 0.8;
// Divisors of the true scale fit as well as the scale itself (their lines include its
// lines), and noise near edges favours them slightly: a multiple this close to the best
// fit is preferred.
const FIT_SLACK = 0.06;
// Fewer edge crossings than this say nothing reliable about a grid.
const MIN_EDGES = 8;
// A few edges fit many grids by chance (a 4x4 icon with a 2x2 center "fits" a 2x grid).
// L distinct edge lines all land on one of k offsets with chance k^(1-L) per axis; a grid
// is only believed when that chance is below this.
const MAX_CHANCE_FIT = 0.05;
// A line is evidence when it carries at least this share of the strongest line's edges.
const EVIDENCE_LINE_SHARE = 0.05;
// Share of the evidence lines that may lie off the grid (a border drawn after upscaling).
const MAX_OFF_GRID_LINES = 0.1;
// Blocks whose pixels match their most common color at least this often are clean
// nearest-neighbour blocks; below it the image is noisy (JPEG, resampling) and colors are
// merged within the noise instead.
const CLEAN_UNIFORMITY = 0.9;

/**
 * Largest per-channel difference of two pixels. Fully transparent pixels are equal
 * whatever RGB they carry; against a visible pixel the difference is its alpha.
 */
function pixelDiff(d: Uint8Array, p: number, q: number): number {
  const a = d[p + 3];
  const b = d[q + 3];
  if (a === 0 || b === 0) return a === b ? 0 : Math.max(a, b);
  return Math.max(Math.abs(d[p] - d[q]), Math.abs(d[p + 1] - d[q + 1]), Math.abs(d[p + 2] - d[q + 2]), Math.abs(a - b));
}

/**
 * Calls visit for every horizontal and vertical neighbour pair with something visible;
 * `position` is the column (x) or row (y) of the pair's second pixel.
 */
function forEachPair(image: RgbaImage, visit: (diff: number, axis: "x" | "y", position: number) => void): void {
  const { width, height, data } = image;
  const row = width * 4;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (x > 0 && (data[o + 3] !== 0 || data[o - 1] !== 0)) visit(pixelDiff(data, o - 4, o), "x", x);
      if (y > 0 && (data[o + 3] !== 0 || data[o - row + 3] !== 0)) visit(pixelDiff(data, o - row, o), "y", y);
    }
  }
}

/**
 * The smallest difference that counts as a color edge. Clean art: any change. Noisy art
 * (JPEG): twice the median difference between neighbours, since most neighbour pairs of
 * upscaled art lie inside a block and differ only by noise.
 */
function edgeThreshold(images: readonly RgbaImage[]): number {
  const histogram = new Uint32Array(256);
  let pairs = 0;
  for (const image of images) {
    forEachPair(image, (diff) => {
      histogram[diff]++;
      pairs++;
    });
  }
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += histogram[v];
    if (seen * 2 >= pairs) return v === 0 ? 1 : 2 * v + 1;
  }
  return 1;
}

interface EdgeProfiles {
  /** x[i]: summed strength of the edges between column i-1 and column i. */
  x: Float64Array;
  y: Float64Array;
  edges: number;
}

/**
 * Run boundaries (where a run of equal colors ends) of every row and column, summed per
 * grid line. Upscaled art has them only every `scale` pixels, so the scale is the GCD of
 * the run lengths; voting per line keeps that GCD robust against noise. An edge votes
 * with its squared strength, so real color edges outweigh JPEG ringing and stray noise
 * pixels by far.
 */
function edgeProfiles(images: readonly RgbaImage[]): EdgeProfiles {
  const { width, height } = images[0];
  const threshold = edgeThreshold(images);
  const profiles: EdgeProfiles = { x: new Float64Array(width), y: new Float64Array(height), edges: 0 };
  for (const image of images) {
    forEachPair(image, (diff, axis, position) => {
      if (diff < threshold) return;
      profiles[axis][position] += diff * diff;
      profiles.edges++;
    });
  }
  return profiles;
}

interface AxisFit {
  offset: number;
  /** Edge strength on the grid lines. */
  hits: number;
  /** Lines carrying real edges (not just a stray noise pixel's) on and off the grid. */
  linesOn: number;
  linesOff: number;
}

function bestOffset(profile: Float64Array, scale: number): AxisFit {
  const sums = new Float64Array(scale);
  let strongest = 0;
  for (let i = 1; i < profile.length; i++) {
    sums[i % scale] += profile[i];
    strongest = Math.max(strongest, profile[i]);
  }
  let offset = 0;
  for (let o = 1; o < scale; o++) if (sums[o] > sums[offset]) offset = o;
  let linesOn = 0;
  let linesOff = 0;
  for (let i = 1; i < profile.length; i++) {
    if (profile[i] <= strongest * EVIDENCE_LINE_SHARE) continue;
    if (i % scale === offset) linesOn++;
    else linesOff++;
  }
  return { offset, hits: sums[offset], linesOn, linesOff };
}

function sum(values: Float64Array): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/**
 * A grid, and the chance that 1x art with edges on as many lines would fit it this well
 * by accident (an axis without edges says nothing either way). Real edge lines off the
 * grid contradict it outright.
 */
function gridFor(profiles: EdgeProfiles, scale: number, total: number): { grid: UpscaleGrid; chance: number } {
  const x = bestOffset(profiles.x, scale);
  const y = bestOffset(profiles.y, scale);
  const axisChance = (axis: AxisFit) => {
    if (axis.linesOff > (axis.linesOn + axis.linesOff) * MAX_OFF_GRID_LINES) return Number.POSITIVE_INFINITY;
    return axis.linesOn === 0 ? 1 : scale ** (1 - axis.linesOn);
  };
  return {
    grid: { scale, offsetX: x.offset, offsetY: y.offset, fit: total > 0 ? (x.hits + y.hits) / total : 1 },
    chance: x.linesOn + y.linesOn === 0 ? 1 : axisChance(x) * axisChance(y),
  };
}

/**
 * Finds the upscale factor and grid offset of upscaled pixel art (all frames share one
 * grid). `scale` forces the factor and only searches the offset. Art that is not on an
 * integer grid comes back as scale 1.
 */
export function detectGrid(images: readonly RgbaImage[], scale?: number): UpscaleGrid {
  if (images.length === 0) throw new Error("detectGrid: no images");
  const { width, height } = images[0];
  if (images.some((i) => i.width !== width || i.height !== height)) throw new Error("detectGrid: images differ in size");
  if (scale === 1) return NO_GRID;

  const profiles = edgeProfiles(images);
  const total = sum(profiles.x) + sum(profiles.y);
  if (scale !== undefined) return gridFor(profiles, scale, total).grid;
  if (profiles.edges < MIN_EDGES || total === 0) return NO_GRID;

  const maxScale = Math.min(MAX_UNZOOM_SCALE, Math.floor(Math.max(width, height) / 2));
  const valid: UpscaleGrid[] = [];
  for (let k = 2; k <= maxScale; k++) {
    const candidate = gridFor(profiles, k, total);
    if (candidate.grid.fit >= MIN_FIT && candidate.chance <= MAX_CHANCE_FIT) valid.push(candidate.grid);
  }
  if (valid.length === 0) return NO_GRID;
  // The true scale and its divisors fit best; climb from the best fit to its largest
  // multiple that fits as well. Unrelated scales that fit almost as well by accident
  // (a 7px grid over 5x art) are never multiples, so they can't win.
  const best = valid.reduce((p, q) => (q.fit > p.fit ? q : p));
  const multiples = valid.filter((g) => g.scale % best.scale === 0 && g.fit >= best.fit - FIT_SLACK);
  return multiples[multiples.length - 1];
}

/** Packed rgba; every fully transparent pixel is 0, so they all count as one color. */
function keyAt(d: Uint8Array, o: number): number {
  if (d[o + 3] === 0) return 0;
  return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
}

/**
 * Each block becomes its most common exact color; a tie goes to the block's center pixel,
 * the one farthest from any seam. Also counts how many pixels agreed with their block's
 * color, which tells clean nearest-neighbour upscales from noisy ones.
 */
function downscaleExact(image: RgbaImage, grid: UpscaleGrid): { image: RgbaImage; agreeing: number; pixels: number } {
  const size = gridSize(image.width, image.height, grid);
  const out = createRgbaImage(size.width, size.height);
  const d = image.data;
  const counts = new Map<number, number>();
  let agreeing = 0;
  let pixels = 0;
  forEachCell(image, grid, (cell, index) => {
    const centre = (((cell.y0 + cell.y1 - 1) >> 1) * image.width + ((cell.x0 + cell.x1 - 1) >> 1)) * 4;
    const centreKey = keyAt(d, centre);
    counts.clear();
    let best = centreKey;
    let bestCount = 0;
    for (let y = cell.y0; y < cell.y1; y++) {
      for (let x = cell.x0; x < cell.x1; x++) {
        const key = keyAt(d, (y * image.width + x) * 4);
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        if (count > bestCount || (count === bestCount && key === centreKey)) {
          best = key;
          bestCount = count;
        }
      }
    }
    agreeing += bestCount;
    pixels += (cell.x1 - cell.x0) * (cell.y1 - cell.y0);
    if (best !== 0) out.data.set([best >>> 24, (best >>> 16) & 255, (best >>> 8) & 255, best & 255], index * 4);
  });
  return { image: out, agreeing, pixels };
}

export interface Unzoomed {
  images: RgbaImage[];
  /** True when the blocks were noisy and colors were merged within the noise. */
  denoised: boolean;
}

/**
 * Turns every block of `grid` into one pixel of its dominant color. All images (frames)
 * share the grid and, for noisy sources, one set of merged colors.
 */
export function unzoom(images: readonly RgbaImage[], grid: UpscaleGrid): Unzoomed {
  if (grid.scale === 1) {
    return { images: images.map((i) => ({ width: i.width, height: i.height, data: new Uint8Array(i.data) })), denoised: false };
  }
  let agreeing = 0;
  let pixels = 0;
  const exact = images.map((image) => {
    const result = downscaleExact(image, grid);
    agreeing += result.agreeing;
    pixels += result.pixels;
    return result.image;
  });
  if (pixels === 0 || agreeing / pixels >= CLEAN_UNIFORMITY) return { images: exact, denoised: false };
  return { images: downscaleDenoised(images, grid), denoised: true };
}
