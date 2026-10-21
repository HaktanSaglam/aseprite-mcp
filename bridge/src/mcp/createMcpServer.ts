import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ScopedAsepriteGateway } from "../aseprite/ScopedAsepriteGateway.js";
import { CanvasService } from "../canvas/CanvasService.js";
import type { ToolContext, ToolRegistrar } from "./ToolContext.js";
import { TOOL_REGISTRARS } from "./tools/index.js";

const INSTRUCTIONS = `
You are drawing pixel art directly inside the user's Aseprite.

Workflow:
1. get_sprite_info to learn canvas size, layers and selection (or create_sprite for a new piece).
2. get_palette / read_pixels when editing existing art, so new pixels match its colors and style.
3. Draw. Prefer a dedicated layer (e.g. "AI") so the user's layers stay intact.
   - draw_script for anything larger than ~48x48, backgrounds, scenes and repeated
     structure: one short program draws thousands of pixels in seconds. Draw a whole
     scene in one or a few scripts (back to front) rather than many small calls.
   - write_pixels for small sprites (up to ~48x48) and pixel-level touch-ups.
4. Check the result (draw_script returns a preview; otherwise view_sprite), then fix
   problems with targeted edits.

Pixel art guidance: keep palettes small (4-16 colors), use clean 1px outlines,
avoid stray single pixels and noisy dithering, light consistently from one direction,
and keep silhouettes readable at 1x zoom.
`.trim();

/**
 * One server per request (stateless HTTP) or per instant tool call; `ctx` decides which
 * sprite the tools act on. `registrars` is only overridden by tests.
 */
export function createMcpServer(ctx: ToolContext, registrars: readonly ToolRegistrar[] = TOOL_REGISTRARS): McpServer {
  const server = new McpServer(
    { name: "aseprite-mcp", version: "1.0.0" },
    { instructions: INSTRUCTIONS },
  );
  for (const register of registrars) register(server, ctx);
  return server;
}

/**
 * The same tools, bound to one sprite. The canvas is rebuilt on the scoped gateway
 * because it reads and writes through whatever gateway it was given.
 */
export function scopeToolContext(base: ToolContext, sprite: number): ToolContext {
  const gateway = new ScopedAsepriteGateway(base.gateway, sprite);
  return { ...base, gateway, canvas: new CanvasService(gateway) };
}
