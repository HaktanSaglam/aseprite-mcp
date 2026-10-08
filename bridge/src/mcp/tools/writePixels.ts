import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IAsepriteGateway } from "../../aseprite/AsepriteGateway.js";
import { decodeGrid } from "../../pixel/PixelGridCodec.js";
import { jsonResult } from "../toolResult.js";

export function registerWritePixels(server: McpServer, gateway: IAsepriteGateway): void {
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
    async ({ palette, rows, ...rest }) => {
      const image = decodeGrid({ palette, rows });
      await gateway.writeRegion({ ...rest, image });
      return jsonResult({ ok: true, width: image.width, height: image.height });
    },
  );
}
