import { z } from "zod";
import { decodeGrid, encodeGrid } from "../../pixel/PixelGridCodec.js";
import { previewScale, renderPreviewPng } from "../../pixel/previewPng.js";
import type { ToolRegistrar } from "../ToolContext.js";
import { jsonResult } from "../toolResult.js";

// Beyond this the grid costs too many tokens to be useful; view_sprite is cheaper for overviews.
const MAX_READ_PIXELS = 128 * 128;

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
        "for judging the overall look.",
      inputSchema: {
        frame: z.number().int().min(1).optional().describe("1-based. Defaults to the active frame."),
        layer: z.string().optional().describe("Show only this layer instead of the composited sprite."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ frame, layer }) => {
      const { rect, image } = await gateway.readImage({ frame, layer, flattened: layer === undefined });
      const scale = previewScale(rect.width, rect.height);
      const png = renderPreviewPng(image, scale);
      return {
        content: [
          { type: "image", data: png.toString("base64"), mimeType: "image/png" },
          { type: "text", text: `${rect.width}x${rect.height} sprite shown at ${scale}x` },
        ],
      };
    },
  );
};
