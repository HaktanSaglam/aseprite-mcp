import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IAsepriteGateway } from "../aseprite/AsepriteGateway.js";
import { registerCreateSprite } from "./tools/createSprite.js";
import { registerGetPalette } from "./tools/getPalette.js";
import { registerGetSpriteInfo } from "./tools/getSpriteInfo.js";
import { registerReadPixels } from "./tools/readPixels.js";
import { registerViewSprite } from "./tools/viewSprite.js";
import { registerWritePixels } from "./tools/writePixels.js";

const INSTRUCTIONS = `
You are drawing pixel art directly inside the user's Aseprite.

Workflow:
1. get_sprite_info to learn canvas size, layers and selection (or create_sprite for a new piece).
2. get_palette / read_pixels when editing existing art, so new pixels match its colors and style.
3. write_pixels to draw. Prefer a dedicated layer (e.g. "AI") so the user's layers stay intact.
4. view_sprite to look at the result, then fix problems with another write_pixels.

Pixel art guidance: keep palettes small (4-16 colors), use clean 1px outlines,
avoid stray single pixels and noisy dithering, light consistently from one direction,
and keep silhouettes readable at 1x zoom.
`.trim();

export function createMcpServer(gateway: IAsepriteGateway): McpServer {
  const server = new McpServer(
    { name: "aseprite-mcp", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );
  registerGetSpriteInfo(server, gateway);
  registerCreateSprite(server, gateway);
  registerGetPalette(server, gateway);
  registerReadPixels(server, gateway);
  registerWritePixels(server, gateway);
  registerViewSprite(server, gateway);
  return server;
}
