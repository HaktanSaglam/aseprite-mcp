import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IAsepriteGateway } from "../../aseprite/AsepriteGateway.js";
import { encodeGrid } from "../../pixel/PixelGridCodec.js";
import { jsonResult } from "../toolResult.js";

// Beyond this the grid costs too many tokens to be useful; view_sprite is cheaper for overviews.
const MAX_PIXELS = 128 * 128;

export function registerReadPixels(server: McpServer, gateway: IAsepriteGateway): void {
  server.registerTool(
    "read_pixels",
    {
      title: "Read pixels",
      description:
        "Read a rectangle of pixels as a palette grid: {palette: {key: '#rrggbb'}, rows: ['..ab..']}. " +
        "Each character in a row is one pixel; '.' is transparent. Omitting x/y/width/height reads the " +
        `whole canvas. Max ${MAX_PIXELS} pixels per call.`,
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
      if (args.width !== undefined && args.height !== undefined && args.width * args.height > MAX_PIXELS) {
        throw new Error(`Region too large; read at most ${MAX_PIXELS} pixels at a time`);
      }
      const { rect, image } = await gateway.readRegion(args);
      if (rect.width * rect.height > MAX_PIXELS) {
        throw new Error(
          `Canvas is ${rect.width}x${rect.height}; pass x/y/width/height to read at most ${MAX_PIXELS} pixels`,
        );
      }
      return jsonResult({ ...rect, ...encodeGrid(image) });
    },
  );
}
