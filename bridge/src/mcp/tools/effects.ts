import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Rect } from "../../aseprite/protocol.js";
import type { CanvasService, LayerTarget } from "../../canvas/CanvasService.js";
import type { PixelFilter } from "../../pixel/composite.js";
import { analyzeImage } from "../../pixel/analyze.js";
import { parseHex } from "../../pixel/color.js";
import { removeBackground } from "../../pixel/effects/background.js";
import { cleanupPixels } from "../../pixel/effects/cleanup.js";
import { dropShadow } from "../../pixel/effects/dropShadow.js";
import { outline } from "../../pixel/effects/outline.js";
import { TRANSFORM_OPS, transformImage } from "../../pixel/effects/transform.js";
import type { RgbaImage } from "../../pixel/RgbaImage.js";
import type { ToolRegistrar } from "../ToolContext.js";
import { jsonResult } from "../toolResult.js";

// --- Shared by the pixel-editing tools (effects, colors) ---------------------------

/** The common target arguments, so every editing tool picks layers/frames/selection the same way. */
export const targetArgs = {
  layer: z
    .string()
    .optional()
    .describe('Layer name or group path ("Group/Layer"). Defaults to the active layer.'),
  frames: z
    .union([z.enum(["current", "all"]), z.array(z.number().int().min(1)).min(1)])
    .optional()
    .describe('"current" (default), "all", or a list of 1-based frame numbers.'),
  selectionOnly: z
    .boolean()
    .optional()
    .describe("Only change pixels inside the user's selection (the whole layer when nothing is selected)."),
};

export const colorArg = z
  .string()
  .regex(
    /^(#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|transparent)$/,
    'Use "#rrggbb", "#rrggbbaa" or "transparent"',
  );

export const toleranceArg = z
  .number()
  .min(0)
  .max(100)
  .describe("0 = exact color only, 10 = also noise/compression artifacts, 25 = also neighbouring shades, 50+ = broad.");

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export interface EffectRun {
  frames: number[];
  /** Pixels that actually changed, counted only where the edit was allowed (selection). */
  changed: number;
}

export function countChanged(before: RgbaImage, after: RgbaImage, filter?: PixelFilter): number {
  let changed = 0;
  const a = before.data;
  const b = after.data;
  for (let y = 0; y < before.height; y++) {
    for (let x = 0; x < before.width; x++) {
      const o = (y * before.width + x) * 4;
      if (a[o] === b[o] && a[o + 1] === b[o + 1] && a[o + 2] === b[o + 2] && a[o + 3] === b[o + 3]) continue;
      if (filter && !filter(x, y)) continue;
      changed++;
    }
  }
  return changed;
}

/**
 * canvas.transform plus an exact count of changed pixels, so tool summaries tell the
 * model what really happened (selection included). Pass `filter` when the caller
 * already read the selection, to avoid reading it twice.
 */
export async function runEffect(
  canvas: CanvasService,
  target: LayerTarget,
  edit: (image: RgbaImage, frame: number) => RgbaImage,
  filter?: PixelFilter,
): Promise<EffectRun> {
  const mask = filter ?? (target.selectionOnly ? await canvas.selectionFilter({ sprite: target.sprite }) : undefined);
  let changed = 0;
  const { frames } = await canvas.transform(target, (image, frame) => {
    const edited = edit(image, frame);
    changed += countChanged(image, edited, mask);
    return edited;
  });
  return { frames, changed };
}

/** 'layer "Hero", frames 1-4' — what a summary says it touched. */
export function describeTarget(layer: string | undefined, frames: number[]): string {
  const where = layer === undefined ? "the active layer" : `layer "${layer}"`;
  const sorted = [...frames].sort((p, q) => p - q);
  const contiguous = sorted.every((f, i) => i === 0 || f === sorted[i - 1] + 1);
  let which: string;
  if (sorted.length === 1) which = `frame ${sorted[0]}`;
  else if (contiguous) which = `frames ${sorted[0]}-${sorted[sorted.length - 1]}`;
  else which = `frames ${sorted.join(", ")}`;
  return `${where}, ${which}`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// --- Effect tools ----------------------------------------------------------------------

export const registerEffectTools: ToolRegistrar = (server, { gateway, canvas }) => {
  server.registerTool(
    "remove_background",
    {
      title: "Remove background",
      description:
        "Make a background transparent. mode 'edges' (default) detects the background color(s) along the canvas " +
        "border (solid fills, fake-transparency checkerboards) and flood-fills inward, so the same color inside the " +
        "subject survives: use it on imported or AI-generated images and sprites drawn on a filled background. " +
        "mode 'color' removes every pixel near `color`, wherever it is. One undo step.",
      inputSchema: {
        mode: z.enum(["edges", "color"]).default("edges").describe("'edges': connected to the border; 'color': everywhere."),
        color: colorArg.optional().describe("Background color to remove; required for mode 'color'."),
        tolerance: toleranceArg.default(10),
        ...targetArgs,
      },
    },
    async ({ mode, color, tolerance, layer, frames, selectionOnly }) => {
      if (mode === "color" && color === undefined) {
        throw new Error('mode "color" needs color (e.g. "#ffffff"); mode "edges" detects the background itself');
      }
      const rgba = color === undefined ? undefined : parseHex(color);
      const found = new Set<string>();
      const run = await runEffect(canvas, { layer, frames, selectionOnly }, (image) => {
        const result = removeBackground(image, { mode, color: rgba, tolerance });
        result.colors.forEach((c) => found.add(c));
        return result.image;
      });
      const where = describeTarget(layer, run.frames);
      if (run.changed === 0) {
        return textResult(
          mode === "edges" && found.size === 0
            ? `No background found on ${where}: the edges are already transparent or have no dominant color. ` +
                'Use mode "color" with the background color, or raise tolerance.'
            : `Nothing removed on ${where}: no pixels within tolerance ${tolerance} of ` +
                `${[...found].join(", ")}. Raise tolerance.`,
        );
      }
      return textResult(
        `Removed ${plural(run.changed, "background pixel")} (${[...found].join(", ")}, tolerance ${tolerance}) on ${where}.`,
      );
    },
  );

  server.registerTool(
    "add_outline",
    {
      title: "Add outline",
      description:
        "Add a 1px outline around the opaque art so it reads against any background. By default each outline pixel " +
        "is a darker, hue-shifted shade of the art next to it (looks hand-picked); pass color for one uniform line " +
        "(e.g. '#000000'). 'outside' grows the silhouette by 1px (needs a transparent margin), 'inside' recolors " +
        "the edge pixels and keeps the size. Use on a layer that holds just the sprite. One undo step.",
      inputSchema: {
        color: colorArg.optional().describe("Uniform outline color. Omit for automatic per-pixel shades."),
        placement: z
          .enum(["outside", "inside"])
          .default("outside")
          .describe("'outside' grows the silhouette by 1px; 'inside' recolors the edge pixels."),
        connectivity: z
          .union([z.literal(4), z.literal(8)])
          .default(4)
          .describe("4: clean outline without diagonal corner pixels (usual for sprites); 8: also fills corners."),
        ...targetArgs,
      },
    },
    async ({ color, placement, connectivity, layer, frames, selectionOnly }) => {
      const rgba = color === undefined ? undefined : parseHex(color);
      const run = await runEffect(canvas, { layer, frames, selectionOnly }, (image) =>
        outline(image, { placement, connectivity, color: rgba }).image,
      );
      const where = describeTarget(layer, run.frames);
      if (run.changed === 0) {
        return textResult(
          `No outline added on ${where}: nothing opaque borders a transparent pixel there ` +
            "(empty layer, or the art fills the whole canvas: outline a layer that holds only the sprite).",
        );
      }
      return textResult(
        `Outlined ${placement} (${connectivity}-connected, ${color ?? "automatic shades"}): ` +
          `${plural(run.changed, "pixel")} painted on ${where}.`,
      );
    },
  );

  server.registerTool(
    "cleanup_pixels",
    {
      title: "Clean up stray pixels",
      description:
        "Remove isolated pixels (fewer than minNeighbors opaque neighbours, 8-connected) and recolor single " +
        "'noise' pixels enclosed on all 4 sides by one other color. Use after drawing, downscaling or reducing " +
        "colors; analyze_sprite reports how many there are. One undo step.",
      inputSchema: {
        minNeighbors: z
          .number()
          .int()
          .min(0)
          .max(4)
          .default(1)
          .describe("1 removes only fully isolated pixels; 2 also removes line tips; 0 keeps them all."),
        noise: z
          .enum(["similar", "all", "off"])
          .default("similar")
          .describe(
            "'similar': only stray pixels in a near-identical shade (keeps deliberate 1px details like eye glints); " +
              "'all': every enclosed lone pixel; 'off': skip.",
          ),
        ...targetArgs,
      },
    },
    async ({ minNeighbors, noise, layer, frames, selectionOnly }) => {
      let removed = 0;
      let recolored = 0;
      const run = await runEffect(canvas, { layer, frames, selectionOnly }, (image) => {
        const result = cleanupPixels(image, { minNeighbors, noise });
        removed += result.removed;
        recolored += result.recolored;
        return result.image;
      });
      const where = describeTarget(layer, run.frames);
      if (run.changed === 0) return textResult(`Already clean: no stray pixels on ${where}.`);
      const detail = `${plural(removed, "isolated pixel")} removed, ${plural(recolored, "noise pixel")} recolored`;
      return textResult(
        selectionOnly
          ? `${plural(run.changed, "pixel")} changed inside the selection on ${where} (whole layer: ${detail}).`
          : `Cleaned ${where}: ${detail}.`,
      );
    },
  );

  server.registerTool(
    "transform_layer",
    {
      title: "Flip, rotate or shift a layer",
      description:
        "Flip, rotate (clockwise, about the canvas center) or shift a layer's pixels; the canvas keeps its size, so " +
        "on non-square canvases rotated corners that leave the canvas are clipped (edit_sprite rotates/flips the " +
        "whole sprite instead). shift moves the art by dx/dy; wrap: true brings pixels around to the other side " +
        "(seamless tiles, scrolling). With selectionOnly the transform happens inside the selection's bounding box.",
      inputSchema: {
        op: z
          .enum(TRANSFORM_OPS)
          .describe("flip_h/flip_v mirror, rotate_90/180/270 turn clockwise, shift moves by dx/dy."),
        dx: z.number().int().default(0).describe("shift: pixels to the right (negative: left)."),
        dy: z.number().int().default(0).describe("shift: pixels down (negative: up)."),
        wrap: z.boolean().default(false).describe("shift: wrap around the edges instead of clipping."),
        ...targetArgs,
      },
    },
    async ({ op, dx, dy, wrap, layer, frames, selectionOnly }) => {
      if (op === "shift" && dx === 0 && dy === 0) throw new Error("shift needs dx and/or dy (e.g. dx: 2 moves right by 2)");
      let region: Rect | undefined;
      if (selectionOnly) {
        const selection = await gateway.readSelection({});
        region = selection.isEmpty ? undefined : (selection.bounds ?? selection.rect);
      }
      const run = await runEffect(canvas, { layer, frames, selectionOnly }, (image) =>
        transformImage(image, op, { dx, dy, wrap }, region),
      );
      const what = op === "shift" ? `Shifted by (${dx}, ${dy})${wrap ? " with wrap" : ""}` : `Applied ${op}`;
      const scope = region ? ` inside the selection (${region.width}x${region.height} at ${region.x},${region.y})` : "";
      return textResult(
        `${what}${scope} on ${describeTarget(layer, run.frames)}: ${plural(run.changed, "pixel")} changed.`,
      );
    },
  );

  server.registerTool(
    "drop_shadow",
    {
      title: "Drop shadow",
      description:
        "Add a hard drop shadow: the art's silhouette offset by (dx, dy), painted only into transparent pixels so " +
        "it stays behind the art. Good for text, icons and UI sprites. One undo step.",
      inputSchema: {
        dx: z.number().int().min(-16).max(16).default(1).describe("Offset to the right (negative: left)."),
        dy: z.number().int().min(-16).max(16).default(1).describe("Offset down (negative: up)."),
        color: colorArg.default("#000000").describe("Shadow color; a dark tone of the background often looks best."),
        ...targetArgs,
      },
    },
    async ({ dx, dy, color, layer, frames, selectionOnly }) => {
      if (dx === 0 && dy === 0) throw new Error("dx and dy can't both be 0: the shadow would hide behind the art");
      const rgba = parseHex(color);
      if (rgba[3] === 0) throw new Error("The shadow color must not be fully transparent");
      const run = await runEffect(canvas, { layer, frames, selectionOnly }, (image) =>
        dropShadow(image, { dx, dy, color: rgba }).image,
      );
      const where = describeTarget(layer, run.frames);
      if (run.changed === 0) return textResult(`No shadow added on ${where}: no opaque art casts onto transparent pixels.`);
      return textResult(`Drop shadow (${dx}, ${dy}) ${color}: ${plural(run.changed, "pixel")} painted on ${where}.`);
    },
  );

  server.registerTool(
    "analyze_sprite",
    {
      title: "Analyze sprite",
      description:
        "Check art for common pixel-art problems: color count, nearly identical colors, isolated and noise pixels, " +
        "semi-transparent pixels, a solid background, and where the content sits (bounds). Returns stats plus " +
        "suggestions naming the tool that fixes each problem. Use after drawing or importing.",
      inputSchema: {
        layer: z.string().optional().describe("Analyze one layer. Omit to analyze the visible, flattened sprite."),
        frame: z.number().int().min(1).optional().describe("1-based. Defaults to the active frame."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ layer, frame }) => {
      const { image } = await gateway.readImage({ layer, frame, flattened: layer === undefined });
      return jsonResult({ layer: layer ?? "(flattened)", frame: frame ?? "active", ...analyzeImage(image) });
    },
  );
};
