import { z } from "zod";
import { resolveFrames } from "../../canvas/CanvasService.js";
import { clipRect } from "../../canvas/selectionShapes.js";
import { filmstrip } from "../../pixel/filmstrip.js";
import { decodeGrid, encodeGrid } from "../../pixel/PixelGridCodec.js";
import { previewScale, renderPreviewPng } from "../../pixel/previewPng.js";
import type { RgbaImage } from "../../pixel/RgbaImage.js";
import { seamReport, seamVisible, tileImage, type SeamAxis } from "../../pixel/tiling.js";
import type { ToolRegistrar } from "../ToolContext.js";
import { jsonResult } from "../toolResult.js";
import { formatDurations } from "./animation.js";

// Beyond this the grid costs too many tokens to be useful; view_sprite is cheaper for overviews.
const MAX_READ_PIXELS = 128 * 128;

// Contact sheets: wide enough for an 8-frame walk cycle of 64px sprites at 1x, and
// capped so a long animation of big frames does not become a huge, costly image.
const MAX_SHEET_FRAMES = 64;
const MAX_SHEET_WIDTH = 1024;
const MAX_SHEET_HEIGHT = 1536;
const SHEET_TARGET = 768;
// Same size as draw_script's preview, so both drawing tools look alike.
const WRITE_PREVIEW_TARGET = 512;
// A 3x3 tiling must stay readable: each tile gets about a third of this.
const TILED_TARGET = 768;

export const registerPixelTools: ToolRegistrar = (server, { gateway, canvas }) => {
  server.registerTool(
    "read_pixels",
    {
      title: "Read pixels",
      description:
        "Read a rectangle of pixels as a palette grid: {palette: {key: '#rrggbb'}, rows: ['..ab..']}. " +
        "Each character in a row is one pixel; '.' is transparent. Omitting x/y/width/height reads the " +
        `whole canvas. Max ${MAX_READ_PIXELS} pixels per call.`,
      inputSchema: {
        x: z.number().int().optional(),
        y: z.number().int().optional(),
        width: z.number().int().min(1).optional(),
        height: z.number().int().min(1).optional(),
        frame: z.number().int().min(1).optional().describe("1-based. Defaults to the active frame."),
        layer: z.string().optional().describe("Layer name. Defaults to the active layer."),
        flattened: z
          .boolean()
          .default(false)
          .describe("Read what is visible (all layers composited) instead of one layer."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      if (args.width !== undefined && args.height !== undefined && args.width * args.height > MAX_READ_PIXELS) {
        throw new Error(`Region too large; read at most ${MAX_READ_PIXELS} pixels at a time`);
      }
      const { rect, image } = await gateway.readImage(args);
      if (rect.width * rect.height > MAX_READ_PIXELS) {
        throw new Error(
          `Canvas is ${rect.width}x${rect.height}; pass x/y/width/height to read at most ${MAX_READ_PIXELS} pixels`,
        );
      }
      return jsonResult({ ...rect, ...encodeGrid(image) });
    },
  );

  server.registerTool(
    "write_pixels",
    {
      title: "Write pixels",
      description:
        "Draw a palette grid onto the sprite with its top-left corner at (x, y). " +
        "palette maps single characters to '#rrggbb' / '#rrggbbaa'; '.' is always transparent. " +
        "All rows must have the same length. Transparent pixels leave existing pixels untouched " +
        "unless eraseTransparent is true. Returns a preview of the whole sprite (preview: false skips it). " +
        "The whole call is a single undo step in Aseprite.",
      inputSchema: {
        x: z.number().int().default(0).describe("Canvas x of the grid's left column."),
        y: z.number().int().default(0).describe("Canvas y of the grid's top row."),
        palette: z
          .record(z.string(), z.string())
          .describe('One character per color: {"k": "#1a1c2c", "r": "#b13e53"}; "." is always transparent.'),
        rows: z.array(z.string()).min(1).describe('Equal-length rows of palette characters, top to bottom: ["..kk..", ".krrk."].'),
        frame: z.number().int().min(1).optional().describe("1-based. Defaults to the active frame."),
        layer: z
          .string()
          .optional()
          .describe("Target layer name; created if missing. Defaults to the active layer."),
        eraseTransparent: z
          .boolean()
          .default(false)
          .describe("true: '.' pixels erase what is below; false: they leave it untouched."),
        selectionOnly: z
          .boolean()
          .default(false)
          .describe("Only change pixels inside the user's current selection."),
        preview: z
          .boolean()
          .default(true)
          .describe("Return a preview image of the whole sprite. Set false for intermediate passes to save time and tokens."),
      },
    },
    async ({ palette, rows, x, y, frame, layer, eraseTransparent, selectionOnly, preview }) => {
      const image = decodeGrid({ palette, rows });
      // Pinned when previewing, so the preview shows the sprite and frame the pixels went to.
      const info = preview ? await gateway.getSpriteInfo() : undefined;
      await canvas.paint([{ x, y, image, frame, layer }], {
        mode: eraseTransparent ? "replace" : "over",
        selectionOnly,
        sprite: info?.id,
      });
      const result = jsonResult({ ok: true, width: image.width, height: image.height });
      if (!info) return result;
      const { image: view } = await gateway.readImage({ frame: frame ?? info.activeFrame, flattened: true, sprite: info.id });
      const png = renderPreviewPng(view, previewScale(view.width, view.height, WRITE_PREVIEW_TARGET));
      return { content: [...result.content, { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" }] };
    },
  );

  server.registerTool(
    "view_sprite",
    {
      title: "View sprite",
      description:
        "Look at the sprite as an upscaled PNG (transparency shown as a checkerboard). " +
        "Use it to check proportions and readability after drawing; it is much cheaper than read_pixels " +
        "for judging the overall look. frames: \"all\" (or a list) shows an animation as a contact sheet " +
        "(left to right, then the next row) with frame durations; region zooms into part of the canvas. " +
        "tiled: true repeats the image (or region, e.g. one tile of a tileset) 3x3 and scores its seams: use it " +
        "for seamless textures and tiles.",
      inputSchema: {
        frame: z.number().int().min(1).optional().describe("1-based. Defaults to the active frame."),
        layer: z.string().optional().describe("Show only this layer instead of the composited sprite."),
        frames: z
          .union([z.enum(["current", "all"]), z.array(z.number().int().min(1)).min(1)])
          .optional()
          .describe(`Several frames side by side ("all" or 1-based numbers, max ${MAX_SHEET_FRAMES}). Use instead of frame.`),
        region: z
          .object({
            x: z.number().int(),
            y: z.number().int(),
            width: z.number().int().min(1),
            height: z.number().int().min(1),
          })
          .optional()
          .describe("Zoom into this rectangle of the canvas (e.g. a face or the current selection bounds)."),
        tiled: z
          .boolean()
          .default(false)
          .describe("Repeat the image 3x3 and report how visible the wrap-around seams are (one frame only)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ frame, layer, frames, region, tiled }) => {
      if (frame !== undefined && frames !== undefined) throw new Error("Pass either frame or frames, not both");
      const flattened = layer === undefined;
      const sheet = frames !== undefined && frames !== "current";
      if (tiled && sheet) throw new Error("tiled shows one frame: pass frame instead of frames");

      // The plain view stays a single round trip: it is by far the most frequent call.
      if (!sheet && region === undefined) {
        const { rect, image } = await gateway.readImage({ frame, layer, flattened });
        if (tiled) return tiledResult(image, `${rect.width}x${rect.height} sprite`);
        const scale = previewScale(rect.width, rect.height);
        return imageResult(renderPreviewPng(image, scale), `${rect.width}x${rect.height} sprite shown at ${scale}x`);
      }

      const info = await gateway.getSpriteInfo();
      const area = region === undefined ? undefined : clipRect(region, info);
      if (region !== undefined && !area) {
        throw new Error(`region lies outside the ${info.width}x${info.height} canvas`);
      }
      const where = area ? `region (${area.x}, ${area.y}) ${area.width}x${area.height} of ` : "";

      if (!sheet) {
        const { rect, image } = await gateway.readImage({ ...area, frame, layer, flattened });
        const frameNote = info.frames.length > 1 ? `, frame ${frame ?? info.activeFrame}` : "";
        if (tiled) return tiledResult(image, `${where}${info.width}x${info.height} sprite${frameNote}`);
        const scale = previewScale(rect.width, rect.height);
        return imageResult(
          renderPreviewPng(image, scale),
          `${where}${info.width}x${info.height} sprite${frameNote} shown at ${scale}x`,
        );
      }

      const indexes = resolveFrames(frames, info);
      if (indexes.length > MAX_SHEET_FRAMES) {
        throw new Error(
          `Showing ${indexes.length} frames at once is too many; pass at most ${MAX_SHEET_FRAMES} frame numbers`,
        );
      }
      // Requests are pipelined: Aseprite answers them in order without waiting for us.
      const reads = await Promise.all(indexes.map((f) => gateway.readImage({ ...area, frame: f, layer, flattened })));
      const { width: fw, height: fh } = reads[0].rect;
      const columns = Math.max(1, Math.min(8, indexes.length, Math.floor((MAX_SHEET_WIDTH + 1) / (fw + 1))));
      const strip = filmstrip(reads.map((r) => r.image), columns);
      if (strip.height > MAX_SHEET_HEIGHT) {
        throw new Error(
          `${indexes.length} frames of ${fw}x${fh} do not fit in one preview; pass fewer frames or a region`,
        );
      }
      const scale = previewScale(strip.width, strip.height, SHEET_TARGET);
      const durations = formatDurations(indexes.map((f) => info.frames[f - 1]));
      const tags = info.tags.map((t) => `${t.name} ${t.from}-${t.to} ${t.direction}`).join(", ");
      const text =
        `Frames ${formatFrameList(indexes)} of the ${where}${info.width}x${info.height} sprite, ${columns} per row ` +
        `(left to right, 1px gaps), shown at ${scale}x. Durations: ${durations}.` +
        (tags ? ` Tags: ${tags}.` : "");
      return imageResult(renderPreviewPng(strip, scale), text);
    },
  );
};

function seamText(name: string, axis: SeamAxis): string {
  return `${name} ${axis.seam.toFixed(2)} (inside ${axis.interior.toFixed(2)}): ${seamVisible(axis) ? "visible seam" : "seamless"}`;
}

/** view_sprite tiled: the image 3x3 plus how visible each wrap-around seam is. */
function tiledResult(image: RgbaImage, what: string) {
  if (image.width * 3 > MAX_SHEET_WIDTH || image.height * 3 > MAX_SHEET_HEIGHT) {
    throw new Error(
      `A ${image.width}x${image.height} image is too big to show 3x3; pass a region (e.g. one tile of the tileset)`,
    );
  }
  const tiles = tileImage(image, 3, 3);
  const scale = previewScale(tiles.width, tiles.height, TILED_TARGET);
  const seams = seamReport(image);
  const visible = seamVisible(seams.horizontal) || seamVisible(seams.vertical);
  const text =
    `${what} tiled 3x3, shown at ${scale}x. Seam score (mean color jump across the wrap, 0 = invisible; ` +
    `compare with the jump between neighbours inside): ${seamText("left/right", seams.horizontal)}, ` +
    `${seamText("top/bottom", seams.vertical)}.` +
    (visible
      ? ` To fix: transform_layer {op: "shift", dx: ${image.width >> 1}, dy: ${image.height >> 1}, wrap: true} brings ` +
        "the seams to the middle, repaint them there, then shift back."
      : "");
  return imageResult(renderPreviewPng(tiles, scale), text);
}

function imageResult(png: Buffer, text: string) {
  return {
    content: [
      { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
      { type: "text" as const, text },
    ],
  };
}

/** "1-4, 7, 9-10": runs of consecutive frame numbers. */
function formatFrameList(frames: number[]): string {
  const parts: string[] = [];
  let start = 0;
  for (let i = 1; i <= frames.length; i++) {
    if (i < frames.length && frames[i] === frames[i - 1] + 1) continue;
    parts.push(i - 1 === start ? `${frames[start]}` : `${frames[start]}-${frames[i - 1]}`);
    start = i;
  }
  return parts.join(", ");
}
