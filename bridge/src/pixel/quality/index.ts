import { parseHex } from "../color.js";
import type { RgbaImage } from "../RgbaImage.js";
import { boundsOf, buildContext, keyAt, locate, type Finding, type QualityContext, type QualityIssue } from "./context.js";
import { aaAgainstTransparency, doubledCorners, outlineGaps } from "./outlineChecks.js";
import { banding, lowContrast, pillowShading } from "./shadingChecks.js";

export type { IssueKind, QualityIssue } from "./context.js";

/** What analyze.ts already measured, so the quality checks don't count it again. */
export interface ColorStats {
  /** Pixel indexes of isolated pixels and of single-pixel noise. */
  orphans: readonly number[];
  noise: readonly number[];
  uniqueColors: number;
  /** Nearly identical color pairs ("#rrggbb"), closest first, and how many there are in all. */
  nearDuplicates: readonly [string, string][];
  nearDuplicateCount: number;
}

export interface QualityReport {
  /** 0-100: 100 = none of the checked problems. */
  score: number;
  /** The worst problems first, at most MAX_ISSUES. */
  issues: QualityIssue[];
}

export const MAX_ISSUES = 5;

const STRAY_WEIGHT = 20;
// Stray pixels reach the full penalty at this many, or one per this many drawn pixels in
// big scenes (where a few single-pixel texture details are normal).
const STRAY_FOR_FULL = 6;
const PIXELS_PER_STRAY = 400;
const COLORS_WEIGHT = 25;
// Sprite palettes rarely exceed 32 colors, whole scenes 64; beyond that the art usually
// came from a filter or an image-model render.
const SPRITE_COLORS = 32;
const SCENE_COLORS = 64;
const SCENE_PIXELS = 64 * 64;
const EXCESS_COLORS_FOR_FULL = 64;
const DUPLICATES_WEIGHT = 10;
const DUPLICATES_FOR_FULL = 4;
const MAX_SUGGESTED_SWAPS = 5;

function strayPixels(ctx: QualityContext, stats: ColorStats): Finding | undefined {
  const all = [...stats.orphans, ...stats.noise].sort((p, q) => p - q);
  if (all.length === 0) return undefined;
  const parts: string[] = [];
  if (stats.orphans.length > 0) parts.push(`${stats.orphans.length} isolated`);
  if (stats.noise.length > 0) parts.push(`${stats.noise.length} in a near-identical shade of their surroundings`);
  const full = Math.max(STRAY_FOR_FULL, ctx.visible / PIXELS_PER_STRAY);
  return {
    kind: "stray_pixels",
    message: `Stray single pixels (${parts.join(", ")}) read as noise at 1x: cleanup_pixels removes or recolors them.`,
    ...locate(all, ctx.width),
    fixWith: "cleanup_pixels",
    penalty: STRAY_WEIGHT * Math.min(1, all.length / full),
  };
}

function tooManyColors(ctx: QualityContext, stats: ColorStats): Finding | undefined {
  const allowed = ctx.visible > SCENE_PIXELS ? SCENE_COLORS : SPRITE_COLORS;
  if (stats.uniqueColors <= allowed) return undefined;
  const pixels: number[] = [];
  ctx.opaque.forEach((o, i) => o && pixels.push(i));
  return {
    kind: "too_many_colors",
    message:
      `${stats.uniqueColors} colors is a lot for pixel art (sprites usually 4-32, scenes up to 64): reduce_colors ` +
      "(e.g. 16) or apply_palette with a preset gives clean shared ramps.",
    ...(pixels.length > 0 ? { region: boundsOf(pixels, ctx.width) } : {}),
    fixWith: "reduce_colors",
    penalty: COLORS_WEIGHT * Math.min(1, (stats.uniqueColors - allowed) / EXCESS_COLORS_FOR_FULL),
  };
}

/**
 * replace_color pairs that merge each nearly identical color into the more common one.
 * Pairs never chain in replace_color, so a -> b -> c is written as a -> c directly.
 */
function mergeSwaps(pairs: readonly [string, string][]): { from: string; to: string }[] {
  const into = new Map<string, string>();
  for (const [keep, drop] of pairs) if (!into.has(drop) && keep !== drop) into.set(drop, keep);
  const target = (color: string): string => {
    const seen = new Set<string>();
    let current = color;
    while (into.has(current) && !seen.has(current)) {
      seen.add(current);
      current = into.get(current)!;
    }
    return current;
  };
  return [...into.keys()].map((from) => ({ from, to: target(from) })).filter((s) => s.from !== s.to);
}

function nearDuplicates(ctx: QualityContext, stats: ColorStats): Finding | undefined {
  if (stats.nearDuplicateCount === 0) return undefined;
  const [example] = stats.nearDuplicates;
  const swaps = mergeSwaps(stats.nearDuplicates).slice(0, MAX_SUGGESTED_SWAPS);
  const suggestion = swaps.map((s) => `{from: "${s.from}", to: "${s.to}"}`).join(", ");
  // Point at a pixel of the color to merge away (near duplicates are always opaque).
  const [r, g, b] = parseHex(example[1]);
  const mergeAway = ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
  const at = ctx.opaque.findIndex((o, i) => o === 1 && keyAt(ctx.image.data, i) === mergeAway);
  return {
    kind: "near_duplicate_colors",
    message:
      `${stats.nearDuplicateCount} pair${stats.nearDuplicateCount === 1 ? "" : "s"} of nearly identical colors add ` +
      `noise without detail (e.g. ${example[0]} vs ${example[1]}): merge them in one call with replace_color ` +
      `{pairs: [${suggestion}]}.`,
    ...(at >= 0 ? locate([at], ctx.width) : {}),
    fixWith: "replace_color",
    penalty: DUPLICATES_WEIGHT * Math.min(1, stats.nearDuplicateCount / DUPLICATES_FOR_FULL),
  };
}

/**
 * Scores pixel-art craft from 0 to 100 and lists the worst problems with where they are
 * and which tool fixes them. Each check costs at most a fixed number of points, scaled by
 * how much of the problem there is, so clean art stays near 100 and one bad habit can't
 * sink an otherwise good sprite to 0.
 */
export function assessQuality(image: RgbaImage, stats: ColorStats): QualityReport {
  const ctx = buildContext(image);
  if (ctx.visible === 0) return { score: 100, issues: [] };
  const findings = [
    strayPixels(ctx, stats),
    outlineGaps(ctx),
    doubledCorners(ctx),
    banding(ctx),
    pillowShading(ctx),
    lowContrast(ctx, stats.uniqueColors),
    aaAgainstTransparency(ctx),
    tooManyColors(ctx, stats),
    nearDuplicates(ctx, stats),
  ].filter((f): f is Finding => f !== undefined && f.penalty > 0);
  findings.sort((p, q) => q.penalty - p.penalty);
  const penalty = findings.reduce((sum, f) => sum + f.penalty, 0);
  return {
    score: Math.max(0, Math.min(100, Math.round(100 - penalty))),
    issues: findings.slice(0, MAX_ISSUES).map(({ penalty: _penalty, ...issue }) => issue),
  };
}
