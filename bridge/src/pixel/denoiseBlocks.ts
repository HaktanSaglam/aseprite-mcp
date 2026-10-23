import { createRgbaImage, type RgbaImage } from "./RgbaImage.js";
import { forEachCell, gridSize, type UpscaleGrid } from "./upscaleGrid.js";

type Color4 = [number, number, number, number];

// Share of samples dropped at each end before averaging: removes JPEG ringing outliers
// and the values piled up at 0/255 by clipping, which would bias a plain mean.
const TRIM = 0.2;
// When this share of a color's samples sits exactly on their median, the noise is sharply
// peaked (JPEG keeps flat areas nearly exact) and the median is the true value; broader
// noise is better averaged.
const PEAK_SHARE = 0.4;
// Pixels a merged color needs before its estimate is trusted on its own (4 blocks at x2,
// 2 at x3, 1 from x4 up). Fewer can be one noisy or cut-off block.
const MIN_RELIABLE_PIXELS = 16;
// JPEG ringing moves a lone pixel by up to ~25 per channel; a weak color further than this
// from every reliable one is a color of the art, not noise.
const VOTE_REACH = 40;

interface NoisyCell {
  /** Per-channel median of the block's visible pixels; null when the block is mostly transparent. */
  color: Color4 | null;
  /** Byte offsets of the visible pixels in the source image. */
  pixels: number[];
}

interface Cluster {
  seed: Color4;
  /** 4 x 256 bins of every member pixel's channel values. */
  histogram: Uint32Array;
  pixels: number;
  color: Color4;
}

/** The lower median, so the result is always a value some pixel really has. */
function lowerMedian(values: number[]): number {
  values.sort((p, q) => p - q);
  return values[(values.length - 1) >> 1];
}

function channelDistance(p: readonly number[], q: readonly number[]): number {
  return Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2]), Math.abs(p[3] - q[3]));
}

function noisyCells(image: RgbaImage, grid: UpscaleGrid, deviations: Uint32Array): NoisyCell[] {
  const d = image.data;
  const cells: NoisyCell[] = [];
  forEachCell(image, grid, (cell) => {
    const pixels: number[] = [];
    for (let y = cell.y0; y < cell.y1; y++) {
      for (let x = cell.x0; x < cell.x1; x++) {
        const o = (y * image.width + x) * 4;
        // Half-transparent counts as visible here; binaryAlpha decides about it later.
        if (d[o + 3] >= 128) pixels.push(o);
      }
    }
    const area = (cell.x1 - cell.x0) * (cell.y1 - cell.y0);
    if (pixels.length === 0 || pixels.length * 2 < area) {
      cells.push({ color: null, pixels: [] });
      return;
    }
    const color: Color4 = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) color[c] = lowerMedian(pixels.map((o) => d[o + c]));
    for (const o of pixels) {
      let deviation = 0;
      for (let c = 0; c < 4; c++) deviation = Math.max(deviation, Math.abs(d[o + c] - color[c]));
      deviations[deviation]++;
    }
    cells.push({ color, pixels });
  });
  return cells;
}

function percentile(histogram: Uint32Array, share: number): number {
  let total = 0;
  for (const n of histogram) total += n;
  let seen = 0;
  for (let v = 0; v < histogram.length; v++) {
    seen += histogram[v];
    if (seen >= total * share) return v;
  }
  return histogram.length - 1;
}

/** Greedy clustering within `tolerance` (max channel difference), looked up by color bucket. */
class ColorClusters {
  readonly all: Cluster[] = [];
  private readonly buckets = new Map<string, Cluster[]>();

  constructor(private readonly tolerance: number) {}

  private bucket(color: readonly number[], dr = 0, dg = 0, db = 0): string {
    const t = this.tolerance;
    return `${Math.floor(color[0] / t) + dr},${Math.floor(color[1] / t) + dg},${Math.floor(color[2] / t) + db}`;
  }

  /** The closest cluster seed within the tolerance, or a new cluster seeded by `color`. */
  join(color: Color4): Cluster {
    let best: Cluster | undefined;
    let bestDistance = this.tolerance;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dg = -1; dg <= 1; dg++) {
        for (let db = -1; db <= 1; db++) {
          for (const cluster of this.buckets.get(this.bucket(color, dr, dg, db)) ?? []) {
            const distance = channelDistance(color, cluster.seed);
            if (distance <= bestDistance) {
              best = cluster;
              bestDistance = distance;
            }
          }
        }
      }
    }
    if (best) return best;
    const cluster: Cluster = { seed: color, histogram: new Uint32Array(4 * 256), pixels: 0, color };
    this.all.push(cluster);
    const key = this.bucket(color);
    this.buckets.set(key, [...(this.buckets.get(key) ?? []), cluster]);
    return cluster;
  }
}

function channelMedian(bins: Uint32Array, count: number): number {
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += bins[v];
    if (seen * 2 >= count) return v;
  }
  return 255;
}

/**
 * The value a channel's noisy samples are spread around. Peaked noise: the median.
 * Broad noise: the mean of the middle 60%, far more precise than a median that jumps
 * between neighbouring values. A median stuck at 0 or 255 means clipped samples.
 */
function centralValue(histogram: Uint32Array, channel: number, count: number): number {
  const bins = histogram.subarray(channel * 256, channel * 256 + 256);
  const median = channelMedian(bins, count);
  if (median === 0 || median === 255 || bins[median] >= count * PEAK_SHARE) return median;
  const from = count * TRIM;
  const to = count * (1 - TRIM);
  let sum = 0;
  let weight = 0;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    const n = bins[v];
    // The part of this bin's samples that lies inside the kept [from, to) range.
    const kept = Math.max(0, Math.min(seen + n, to) - Math.max(seen, from));
    sum += kept * v;
    weight += kept;
    seen += n;
  }
  return weight > 0 ? Math.round(sum / weight) : median;
}

/**
 * Each pixel of a weak color's block votes for the nearest reliable color within reach;
 * a majority wins. Undefined when there is none: the block keeps its own color.
 */
function vote(data: Uint8Array, pixels: readonly number[], reliable: readonly Cluster[]): Color4 | undefined {
  const votes = new Map<Cluster, number>();
  for (const o of pixels) {
    const pixel = [data[o], data[o + 1], data[o + 2], data[o + 3]];
    let nearest: Cluster | undefined;
    let nearestDistance = VOTE_REACH;
    for (const candidate of reliable) {
      const distance = channelDistance(pixel, candidate.color);
      if (distance <= nearestDistance) {
        nearest = candidate;
        nearestDistance = distance;
      }
    }
    if (nearest) votes.set(nearest, (votes.get(nearest) ?? 0) + 1);
  }
  let winner: Cluster | undefined;
  for (const [cluster, count] of votes) if (!winner || count > votes.get(winner)!) winner = cluster;
  return winner && votes.get(winner)! * 2 > pixels.length ? winner.color : undefined;
}

/**
 * Downscales noisy upscaled art (JPEG, a filtered resize): each block is reduced to its
 * per-channel median, blocks whose medians agree within the noise are merged, and every
 * merged color is the central value of all its pixels. Symmetric noise cancels out over
 * that many pixels, so the art's own colors come back instead of hundreds of
 * near-identical shades. All images share the merged colors.
 */
export function downscaleDenoised(images: readonly RgbaImage[], grid: UpscaleGrid): RgbaImage[] {
  const deviations = new Uint32Array(256);
  const perImage = images.map((image) => noisyCells(image, grid, deviations));
  // Twice the typical spread inside a block: noise stays in its color, neighbouring
  // shades of a ramp (usually 20+ apart) stay apart.
  const tolerance = Math.max(4, 2 * percentile(deviations, 0.9));

  // Most common block colors seed the clusters, so a seed is a typical member, not an outlier.
  const weights = new Map<string, { color: Color4; weight: number }>();
  for (const cells of perImage) {
    for (const cell of cells) {
      if (!cell.color) continue;
      const key = cell.color.join(",");
      const entry = weights.get(key) ?? { color: cell.color, weight: 0 };
      entry.weight += cell.pixels.length;
      weights.set(key, entry);
    }
  }
  const clusters = new ColorClusters(tolerance);
  const clusterOf = new Map<string, Cluster>();
  for (const [key, { color }] of [...weights].sort((p, q) => q[1].weight - p[1].weight)) {
    clusterOf.set(key, clusters.join(color));
  }

  images.forEach((image, i) => {
    for (const cell of perImage[i]) {
      if (!cell.color) continue;
      const cluster = clusterOf.get(cell.color.join(","))!;
      for (const o of cell.pixels) {
        for (let c = 0; c < 4; c++) cluster.histogram[c * 256 + image.data[o + c]]++;
      }
      cluster.pixels += cell.pixels.length;
    }
  });
  for (const cluster of clusters.all) {
    cluster.color = [0, 1, 2, 3].map((c) => centralValue(cluster.histogram, c, cluster.pixels)) as Color4;
  }
  const reliable = clusters.all.filter((c) => c.pixels >= MIN_RELIABLE_PIXELS);

  return images.map((image, i) => {
    const size = gridSize(image.width, image.height, grid);
    const out = createRgbaImage(size.width, size.height);
    perImage[i].forEach((cell, index) => {
      if (!cell.color) return;
      const cluster = clusterOf.get(cell.color.join(","))!;
      const color = cluster.pixels >= MIN_RELIABLE_PIXELS ? cluster.color : vote(image.data, cell.pixels, reliable);
      out.data.set(color ?? cluster.color, index * 4);
    });
    return out;
  });
}
