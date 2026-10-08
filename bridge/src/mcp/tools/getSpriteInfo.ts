import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IAsepriteGateway } from "../../aseprite/AsepriteGateway.js";
import { jsonResult } from "../toolResult.js";

export function registerGetSpriteInfo(server: McpServer, gateway: IAsepriteGateway): void {
  server.registerTool(
    "get_sprite_info",
    {
      title: "Get sprite info",
      description:
        "Describe the sprite open in Aseprite: size, color mode, frames, layers, active frame/layer " +
        "and the current selection bounds (if any). Call this first.",
      annotations: { readOnlyHint: true },
    },
    async () => jsonResult(await gateway.getSpriteInfo()),
  );
}
