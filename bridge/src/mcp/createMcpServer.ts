import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ScopedAsepriteGateway } from "../aseprite/ScopedAsepriteGateway.js";
import { CanvasService } from "../canvas/CanvasService.js";
import type { ToolContext, ToolRegistrar } from "./ToolContext.js";
import { TOOL_REGISTRARS } from "./tools/index.js";

export const INSTRUCTIONS = `
You draw and animate pixel art directly in the user's Aseprite. Aim for art a skilled pixel
artist would ship, and get there in few tool calls.

Before a big or unfamiliar task (character, animation, tileset, scene, icon set, a named
style) call pixel_art_guide(topic). Topics: fundamentals, characters, animation, tiles,
items_icons, environments, shading_light, color_palettes, outlines_aa, styles, workflow.

Workflow:
1. get_sprite_info, unless the request already describes the canvas (or create_sprite at a
   sensible size: icons 16-32, characters 32-64). Editing existing art: match its palette
   and style (get_palette, view_sprite). Work on your own layer (manage_layers or just a new
   layer name in a drawing call); never repaint the user's layers unasked.
2. Pick ramps once: ramp(base, n) per material, or a preset (get_palette_preset / set_palette).
3. draw_script: block the silhouette in flat colors, then shade with the ramps, in 1-3
   scripts. It also draws whole animations (frameCount/frames + frameMs, one undo step).
4. Details with stamp() or write_pixels; finish with outline(null) or add_outline.
5. Judge the returned preview (view_sprite frames:"all" for animations); fix the single
   worst problem; repeat once. analyze_sprite measures stray pixels and color counts;
   cleanup_pixels, reduce_colors and add_outline fix them. A bad edit? undo.
Selections: set_selection, then selectionOnly:true on drawing/effect calls.

Tools by job:
- document: get_sprite_info, create_sprite, list_sprites, select_sprite, edit_sprite, undo, redo, save_sprite, export_sprite
- drawing: draw_script, write_pixels, read_pixels, view_sprite, pixel_art_guide
- structure: manage_layers, manage_frames, manage_tags, get_selection, set_selection
- color: get_palette, set_palette, get_palette_preset, apply_palette, reduce_colors, replace_color, adjust_colors
- effects: add_outline, remove_background, cleanup_pixels, transform_layer, drop_shadow, analyze_sprite

Quality rules: readable silhouette at 1x; one light direction (default top-left); hue-shifted
ramps (cool shadows, warm highlights), never gray/black shading; 3-5 tones per material,
small palettes; clusters instead of lone pixels; no pillow shading or banding; clean 1px
lines without doubled corners; dark hue-shifted outlines; no anti-aliasing against transparency.
Respect requested size, style, palette and the user's selection (selectionOnly).

Speed rules: few big calls; draw_script for anything structural; plan coordinates once;
preview:false for intermediate passes; never re-read pixels you just wrote (the preview
shows them); fix script errors from the reported line; use layers rather than redrawing.
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
