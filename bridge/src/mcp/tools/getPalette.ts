import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IAsepriteGateway } from "../../aseprite/AsepriteGateway.js";
import { jsonResult } from "../toolResult.js";

export function registerGetPalette(server: McpServer, gateway: IAsepriteGateway): void {
  server.registerTool(
    "get_palette",
    {
      title: "Get palette",
      description:
        "List the sprite's palette as '#rrggbbaa' colors in index order. Prefer these colors " +
        "when drawing so new pixels match the user's existing art.",
      annotations: { readOnlyHint: true },
    },
    async () => jsonResult({ colors: await gateway.getPalette() }),
  );
}
