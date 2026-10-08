import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IAsepriteGateway } from "../../aseprite/AsepriteGateway.js";
import { previewScale, renderPreviewPng } from "../../pixel/previewPng.js";

export function registerViewSprite(server: McpServer, gateway: IAsepriteGateway): void {
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
      const { rect, image } = await gateway.readRegion({ frame, layer, flattened: layer === undefined });
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
}
