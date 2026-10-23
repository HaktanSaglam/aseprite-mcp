import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Rect } from "../../aseprite/protocol.js";
import { defaultLayerPath, resolveFrames, type TransformResult } from "../../canvas/CanvasService.js";
import { analyzeImage } from "../../pixel/analyze.js";
import { formatHex, parseHex, type Rgba } from "../../pixel/color.js";
import { removeBackground } from "../../pixel/effects/background.js";
import { cleanupPixels } from "../../pixel/effects/cleanup.js";
import { dropShadow } from "../../pixel/effects/dropShadow.js";
import { outline } from "../../pixel/effects/outline.js";
import { TRANSFORM_OPS, transformImage, transformSelection } from "../../pixel/effects/transform.js";
import { normalizePixelArt, type NormalizeResult } from "../../pixel/normalize.js";
import { storedColor } from "../../pixel/rawFormat.js";
import { extractRegion, replaceRegion } from "../../pixel/region.js";
import type { RgbaImage } from "../../pixel/RgbaImage.js";
import { MAX_UNZOOM_SCALE } from "../../pixel/unzoom.js";
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

/** canvas.transform's result: frames touched and exact counts of what the sprite now holds. */
export type EffectRun = TransformResult;

const RGB_HINT = 'add it with set_palette, or switch the sprite with edit_sprite {action: "color_mode", mode: "rgb"}';

function sameColor(p: Rgba, q: Rgba): boolean {
  return (p[3] === 0 && q[3] === 0) || p.every((v, i) => v === q[i]);
}

/** The color the sprite stores for `hex` when that isn't `hex` itself (indexed palette, gray). */
export function snappedColor(run: EffectRun, hex: string): string | undefined {
  if (!run.storage) return undefined;
  const requested = parseHex(hex);
  const stored = storedColor(requested, run.storage);
  return sameColor(stored, requested) ? undefined : formatHex(...stored);
}

/** `hex`, or the color the sprite really stored instead and why. */
export function writtenColor(run: EffectRun, hex: string): string {
  const stored = snappedColor(run, hex);
  if (stored === undefined) return hex;
  return run.storage?.format === "indexed"
    ? `${stored} (the nearest palette color; ${hex} is not in the indexed palette: ${RGB_HINT})`
    : `${stored} (${hex} stored as gray)`;
}

/**
 * Indexed and grayscale sprites can't hold every color. Says so when an edit's colors
 * were snapped, so the model never believes in colors the file doesn't have.
 */
export function snapNote(run: EffectRun): string {
  if (run.snapped === 0) return "";
  const pixels = plural(run.snapped, "pixel");
  if (run.storage?.format === "indexed") {
    return (
      ` Indexed sprite: ${pixels} took the nearest palette color because the exact color is not in the palette ` +
      `(${RGB_HINT}).`
    );
  }
  return ` Grayscale sprite: ${pixels} stored as gray.`;
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

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

// Below this share of edges on the grid a forced scale is probably wrong.
const DOUBTFUL_FIT = 0.8;

interface NormalizeContext {
  area: Rect;
  canvas: { width: number; height: number };
  where: string;
  run: EffectRun;
  forced: boolean;
  inSelection: boolean;
}

/** What normalize_pixel_art found and did, and the crop that finishes the job. */
function normalizeSummary(result: NormalizeResult, { area, canvas, where, run, forced, inSelection }: NormalizeContext): string {
  if (result.colorsBefore === 0) return `Nothing to normalize: ${where} is empty${inSelection ? " inside the selection" : ""}.`;
  const { grid } = result;
  const lines: string[] = [];
  if (grid.scale > 1) {
    const found = forced ? `Downscaled ${grid.scale}x` : `Detected ${grid.scale}x upscaling`;
    lines.push(
      `${found} (grid offset ${grid.offsetX}, ${grid.offsetY}; ${percent(grid.fit)} of the color edges on the grid): ` +
        `${area.width}x${area.height} became ${result.width}x${result.height} at (${area.x}, ${area.y}) on ${where}.`,
    );
    if (grid.fit < DOUBTFUL_FIT) {
      lines.push(
        `Only ${percent(grid.fit)} of the edges line up with a ${grid.scale}px grid, so the art may be distorted: ` +
          'check it with view_sprite; if it looks wrong, undo and try scale "auto".',
      );
    }
  } else {
    lines.push(
      forced
        ? `scale 1: no downscaling on ${where}.`
        : `No integer upscaling found on ${where}: the art is already 1x or its pixels are not on a regular grid ` +
            "(pass scale to force a factor).",
    );
  }

  const steps: string[] = [];
  if (result.denoised) steps.push("noisy source (JPEG-like): near-identical shades merged");
  if (result.alphaSnapped > 0) steps.push(`${plural(result.alphaSnapped, "semi-transparent pixel")} snapped to on/off`);
  if (result.palette) steps.push(`colors limited from ${result.colorsBefore} to ${result.colorsAfter}`);
  if (result.removed > 0) steps.push(`${plural(result.removed, "isolated pixel")} removed`);
  if (result.recolored > 0) steps.push(`${plural(result.recolored, "noise pixel")} recolored`);
  const done = steps.join("; ");
  if (done) lines.push(`${done[0].toUpperCase()}${done.slice(1)}.`);
  lines.push(`Result: ${plural(result.colorsAfter, "color")}, ${plural(run.changed, "pixel")} changed.${snapNote(run)}`);

  const shrank = result.width < canvas.width || result.height < canvas.height;
  if (grid.scale > 1 && !inSelection && shrank) {
    lines.push(
      `The canvas is still ${canvas.width}x${canvas.height}: crop it with edit_sprite {action: "crop", x: 0, y: 0, ` +
        `width: ${result.width}, height: ${result.height}} (crops every layer and frame).`,
    );
  }
  return lines.join(" ");
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
      const run = await canvas.transform({ layer, frames, selectionOnly }, (image) => {
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
        `Removed ${plural(run.changed, "background pixel")} (${[...found].join(", ")}, tolerance ${tolerance}) ` +
          `on ${where}.${snapNote(run)}`,
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
      const run = await canvas.transform({ layer, frames, selectionOnly }, (image) =>
        outline(image, { placement, connectivity, color: rgba }).image,
      );
      const where = describeTarget(layer, run.frames);
      if (run.changed === 0) {
        return textResult(
          `No outline added on ${where}: nothing opaque borders a transparent pixel there ` +
            "(empty layer, or the art fills the whole canvas: outline a layer that holds only the sprite).",
        );
      }
      const how = color === undefined ? "automatic shades" : writtenColor(run, color);
      return textResult(
        `Outlined ${placement} (${connectivity}-connected, ${how}): ${plural(run.changed, "pixel")} painted on ` +
          `${where}.${color === undefined ? snapNote(run) : ""}`,
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
      const run = await canvas.transform({ layer, frames, selectionOnly }, (image) => {
        const result = cleanupPixels(image, { minNeighbors, noise });
        removed += result.removed;
        recolored += result.recolored;
        return result.image;
      });
      const where = describeTarget(layer, run.frames);
      if (run.changed === 0) return textResult(`Already clean: no stray pixels on ${where}.`);
      const detail = `${plural(removed, "isolated pixel")} removed, ${plural(recolored, "noise pixel")} recolored`;
      return textResult(
        (selectionOnly
          ? `${plural(run.changed, "pixel")} changed inside the selection on ${where} (whole layer: ${detail}).`
          : `Cleaned ${where}: ${detail}.`) + snapNote(run),
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
        "(seamless tiles, scrolling). With selectionOnly only the selected pixels move: flips and rotations turn " +
        "them within the selection's bounding box, shift moves them anywhere on the canvas (wrap: around the box); " +
        "unselected pixels stay where they are, and the selection outline itself does not move.",
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
      const options = { dx, dy, wrap };
      const moved: { bounds?: Rect } = {};
      // Not clipped to the selection: the selected pixels themselves move, possibly out of its old outline.
      const run = await canvas.transform(
        { layer, frames, selectionOnly },
        (image, _frame, selection) => {
          if (!selection) return transformImage(image, op, options);
          moved.bounds = selection.bounds;
          return transformSelection(image, op, options, selection.bounds, selection.contains);
        },
        { clipToSelection: false },
      );
      const what = op === "shift" ? `Shifted by (${dx}, ${dy})${wrap ? " with wrap" : ""}` : `Applied ${op}`;
      const box = moved.bounds;
      const scope = box ? ` inside the selection (${box.width}x${box.height} at ${box.x},${box.y})` : "";
      return textResult(
        `${what}${scope} on ${describeTarget(layer, run.frames)}: ${plural(run.changed, "pixel")} changed.` +
          snapNote(run),
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
      const run = await canvas.transform({ layer, frames, selectionOnly }, (image) =>
        dropShadow(image, { dx, dy, color: rgba }).image,
      );
      const where = describeTarget(layer, run.frames);
      if (run.changed === 0) return textResult(`No shadow added on ${where}: no opaque art casts onto transparent pixels.`);
      return textResult(
        `Drop shadow (${dx}, ${dy}) ${writtenColor(run, color)}: ${plural(run.changed, "pixel")} painted on ${where}.`,
      );
    },
  );

  server.registerTool(
    "normalize_pixel_art",
    {
      title: "Normalize pixel art",
      description:
        "Turn upscaled or imported 'pixel-style' art into real 1x pixel art: detects the upscale factor and grid " +
        "offset (a 4x screenshot, an image-model render on a pixel grid; JPEG noise is tolerated), shrinks every " +
        "block to its dominant color and writes the result at the top-left of the layer (of the selection with " +
        "selectionOnly); the canvas keeps its size, crop it with the edit_sprite call the result names. Then " +
        "snaps alpha, limits colors (maxColors) and removes stray pixels. Use right after import_image or on art " +
        "pasted at the wrong scale; already-1x art only gets the clean-up steps. All frames share one grid and " +
        "palette. One undo step.",
      inputSchema: {
        scale: z
          .union([z.literal("auto"), z.number().int().min(1).max(MAX_UNZOOM_SCALE)])
          .default("auto")
          .describe('"auto" detects the factor; a number forces it (1 = no downscaling, only the clean-up steps).'),
        maxColors: z
          .number()
          .int()
          .min(2)
          .max(64)
          .optional()
          .describe("Hard color limit after downscaling, e.g. 16. Omit to keep every color."),
        binaryAlpha: z
          .boolean()
          .default(true)
          .describe("Snap semi-transparent pixels to opaque (alpha >= 128) or transparent."),
        cleanup: z
          .boolean()
          .default(true)
          .describe("Afterwards remove isolated single pixels and near-identical single-pixel noise."),
        ...targetArgs,
      },
    },
    async ({ scale, maxColors, binaryAlpha, cleanup, layer, frames, selectionOnly }) => {
      // Pinned, so the frames read for the shared grid are the ones the edit writes.
      const info = await gateway.getSpriteInfo();
      const ref = { sprite: info.id };
      const targetLayer = layer ?? defaultLayerPath(info);
      const frameList = resolveFrames(frames, info);
      const selection = selectionOnly ? await canvas.selectionArea(ref) : undefined;
      const area = selection?.bounds ?? { x: 0, y: 0, width: info.width, height: info.height };
      const options = { scale, maxColors, binaryAlpha, cleanup };
      const regionOf = (image: RgbaImage) => extractRegion(image, area, selection?.contains);

      let result: NormalizeResult | undefined;
      if (frameList.length > 1) {
        // One grid and palette for every frame, so an animation stays aligned and doesn't flicker.
        const images: RgbaImage[] = [];
        for (const frame of frameList) {
          images.push(regionOf((await gateway.readImage({ frame, layer: targetLayer, ...ref })).image));
        }
        result = normalizePixelArt(images, options);
      }
      const run = await canvas.transform({ layer: targetLayer, frames: frameList, selectionOnly, ...ref }, (image, frame) => {
        result ??= normalizePixelArt([regionOf(image)], options);
        return replaceRegion(image, area, result.images[frameList.indexOf(frame)]);
      });
      return textResult(
        normalizeSummary(result!, {
          area,
          canvas: info,
          where: describeTarget(layer, run.frames),
          run,
          forced: scale !== "auto",
          inSelection: selection !== undefined,
        }),
      );
    },
  );

  server.registerTool(
    "analyze_sprite",
    {
      title: "Analyze sprite",
      description:
        "Score pixel-art quality 0-100 and list the worst problems (at most 5), each with a pixel (x, y) or region " +
        "and the tool that fixes it (fixWith): stray pixels, outline gaps, doubled/jaggy outline corners, banding, " +
        "pillow shading, low contrast, anti-aliasing against transparency, too many or near-duplicate colors. Also " +
        "returns color stats, content bounds and a detected solid background. Use after drawing or importing; fix " +
        "the first issues, then check again (clean art scores 85+).",
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
