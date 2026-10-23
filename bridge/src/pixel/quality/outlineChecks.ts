import { hexOfKey, keyAt, locate, type Finding, type QualityContext } from "./context.js";

// Score points each problem can cost at most, and how much of it reaches that maximum:
// a count, or a share of the outline so a long outline may have a few slips.
const GAP_WEIGHT = 20;
const GAPS_FOR_FULL = 4;
const GAP_SHARE_FOR_FULL = 0.08;
const DOUBLED_WEIGHT = 20;
const DOUBLED_FOR_FULL = 6;
const DOUBLED_SHARE_FOR_FULL = 0.2;
const SOFT_WEIGHT = 20;
const SOFT_FOR_FULL = 8;
// Lighter pixels outside the outline are anti-aliasing only when they run along a good
// part of it; a few are a shadow or a detail.
const HALO_SHARE = 0.25;
const MIN_HALO = 4;

function severity(count: number, full: number): number {
  return Math.min(1, count / full);
}

/** Holes in a dark outline: fill pixels that touch transparency directly. */
export function outlineGaps(ctx: QualityContext): Finding | undefined {
  const { gaps, present, colors } = ctx.outline;
  if (!present || gaps.length === 0) return undefined;
  const outlineColor = hexOfKey([...colors][0]);
  return {
    kind: "outline_gaps",
    message:
      `${gaps.length} edge pixel${gaps.length === 1 ? "" : "s"} where the fill touches transparency without the ` +
      `${outlineColor} outline. Close them with write_pixels in the outline color, or add_outline ` +
      `{placement: "inside", color: "${outlineColor}"}.`,
    ...locate(gaps, ctx.width),
    fixWith: "add_outline",
    penalty: GAP_WEIGHT * severity(gaps.length, Math.max(GAPS_FOR_FULL, ctx.outline.edge * GAP_SHARE_FOR_FULL)),
  };
}

/**
 * Doubled corners: in a 1px outline, an L of three outline pixels where the line could
 * step diagonally instead. Square corners (both arms run on straight) are fine; a stair
 * step whose arm stops after one pixel makes the line look 2px thick and jaggy.
 */
export function doubledCorners(ctx: QualityContext): Finding | undefined {
  const { outline, width, height, image } = ctx;
  if (!outline.present) return undefined;
  const line = new Uint8Array(width * height);
  for (let i = 0; i < line.length; i++) if (ctx.opaque[i] && outline.colors.has(keyAt(image.data, i))) line[i] = 1;
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && line[y * width + x] === 1;

  const corners: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!line[y * width + x]) continue;
      const left = on(x - 1, y);
      const right = on(x + 1, y);
      const up = on(x, y - 1);
      const down = on(x, y + 1);
      if (left === right || up === down) continue;
      const dx = left ? -1 : 1;
      const dy = up ? -1 : 1;
      // A filled 2x2 block is an area, not a line.
      if (on(x + dx, y + dy)) continue;
      const armRunsOn = on(x + 2 * dx, y) && on(x, y + 2 * dy);
      if (!armRunsOn) corners.push(y * width + x);
    }
  }
  if (corners.length === 0) return undefined;
  return {
    kind: "doubled_corners",
    message:
      `${corners.length} doubled outline pixel${corners.length === 1 ? "" : "s"}: L-shaped clumps that make 1px lines ` +
      "look thick and jaggy. Recolor the corner pixel of each L to the fill (or erase it) so the line steps diagonally.",
    ...locate(corners, width),
    fixWith: "write_pixels",
    penalty: DOUBLED_WEIGHT * severity(corners.length, Math.max(DOUBLED_FOR_FULL, outline.edge * DOUBLED_SHARE_FOR_FULL)),
  };
}

/**
 * Anti-aliasing against transparency: semi-transparent pixels, and lighter pixels
 * outside a dark outline. Both blend toward one background color and look wrong on any other.
 */
export function aaAgainstTransparency(ctx: QualityContext): Finding | undefined {
  const { data } = ctx.image;
  const partial: number[] = [];
  for (let i = 0; i < ctx.width * ctx.height; i++) {
    const a = data[i * 4 + 3];
    if (a > 0 && a < 255) partial.push(i);
  }
  const { outline } = ctx;
  const systematic = outline.halo.length >= Math.max(MIN_HALO, outline.classified * HALO_SHARE);
  const halo = systematic ? outline.halo : [];
  const count = partial.length + halo.length;
  if (count === 0) return undefined;
  const parts: string[] = [];
  if (partial.length > 0) parts.push(`${partial.length} semi-transparent pixel${partial.length === 1 ? "" : "s"}`);
  if (halo.length > 0) parts.push(`${halo.length} lighter pixel${halo.length === 1 ? "" : "s"} outside the dark outline`);
  const fix =
    partial.length >= halo.length
      ? "normalize_pixel_art {scale: 1} snaps alpha to fully on/off"
      : "erase the pixels outside the outline (write_pixels with eraseTransparent)";
  return {
    kind: "aa_against_transparency",
    message: `Anti-aliasing against transparency: ${parts.join(", ")}. They only blend with one background; ${fix}.`,
    ...locate([...partial, ...halo], ctx.width),
    fixWith: partial.length >= halo.length ? "normalize_pixel_art" : "write_pixels",
    penalty: SOFT_WEIGHT * severity(count, SOFT_FOR_FULL),
  };
}
