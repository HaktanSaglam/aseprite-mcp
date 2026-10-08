import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IAsepriteGateway } from "../../aseprite/AsepriteGateway.js";
import { jsonResult } from "../toolResult.js";

export function registerCreateSprite(server: McpServer, gateway: IAsepriteGateway): void {
  server.registerTool(
    "create_sprite",
    {
      title: "Create sprite",
      description: "Open a new empty sprite in Aseprite. It becomes the active sprite.",
      inputSchema: {
        width: z.number().int().min(1).max(1024),
        height: z.number().int().min(1).max(1024),
        colorMode: z.enum(["rgb", "grayscale", "indexed"]).default("rgb"),
      },
    },
    async (args) => jsonResult(await gateway.createSprite(args)),
  );
}
