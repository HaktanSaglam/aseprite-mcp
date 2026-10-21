import { z } from "zod";
import { resolveFrames } from "../../canvas/CanvasService.js";
import { clipRect } from "../../canvas/selectionShapes.js";
import { filmstrip } from "../../pixel/filmstrip.js";
import { decodeGrid, encodeGrid } from "../../pixel/PixelGridCodec.js";
import { previewScale, renderPreviewPng } from "../../pixel/previewPng.js";
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
        "unless eraseTransparent is true. The whole call is a single undo step in Aseprite.",
      inputSchema: {
        x: z.number().int().default(0),
        y: z.number().int().default(0),
        palette: z.record(z.string(), z.string()),
        rows: z.array(z.string()).min(1),
        frame: z.number().int().min(1).optional().describe("1-based. Defaults to the active frame."),
        layer: z
          .string()
          .optional()
          .describe("Target layer name; created if missing. Defaults to the active layer."),
        eraseTransparent: z.boolean().default(false),
        selectionOnly: z
          .boolean()
          .default(false)
          .describe("Only change pixels inside the user's current selection."),
      },
    },
    async ({ palette, rows, x, y, frame, layer, eraseTransparent, selectionOnly }) => {
      const image = decodeGrid({ palette, rows });
      await canvas.paint([{ x, y, image, frame, layer }], {
        mode: eraseTransparent ? "replace" : "over",
        selectionOnly,
      });
      return jsonResult({ ok: true, width: image.width, height: image.height });
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
        "(left to right, then the next row) with frame durations; region zooms into part of the canvas.",
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
      },
      annotations: { readOnlyHint: true },
    },
    async ({ frame, layer, frames, region }) => {
      if (frame !== undefined && frames !== undefined) throw new Error("Pass either frame or frames, not both");
      const flattened = layer === undefined;
      const sheet = frames !== undefined && frames !== "current";

      // The plain view stays a single round trip: it is by far the most frequent call.
      if (!sheet && region === undefined) {
        const { rect, image } = await gateway.readImage({ frame, layer, flattened });
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
        const scale = previewScale(rect.width, rect.height);
        const frameNote = info.frames.length > 1 ? `, frame ${frame ?? info.activeFrame}` : "";
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
