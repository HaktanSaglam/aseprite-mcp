import { basename } from "node:path";
import { z } from "zod";
import type { SpriteSummary } from "../../aseprite/protocol.js";
import { formatHex, parseHex } from "../../pixel/color.js";
import type { ToolRegistrar } from "../ToolContext.js";
import { jsonResult } from "../toolResult.js";
import { colorArg } from "./effects.js";

function describeSprite(s: SpriteSummary): string {
  return `${s.id} (${basename(s.filename) || "untitled"}, ${s.width}x${s.height})`;
}

/** create_sprite's fill as the rrggbb(aa) Aseprite expects; undefined = transparent canvas. */
function fillColor(background: string | undefined): string | undefined {
  if (background === undefined) return undefined;
  const [r, g, b, a] = parseHex(background);
  return a === 0 ? undefined : formatHex(r, g, b, a);
}

export const registerSpriteTools: ToolRegistrar = (server, { gateway }) => {
  server.registerTool(
    "get_sprite_info",
    {
      title: "Get sprite info",
      description:
        "Describe the sprite open in Aseprite: size, color mode, frames, layers, tags, active " +
        "frame/layer and the current selection bounds (if any). Call this first.",
      annotations: { readOnlyHint: true },
    },
    async () => jsonResult(await gateway.getSpriteInfo()),
  );

  server.registerTool(
    "create_sprite",
    {
      title: "Create sprite",
      description: "Open a new empty sprite in Aseprite. It becomes the active sprite.",
      inputSchema: {
        width: z.number().int().min(1).max(1024).describe("Canvas width in pixels (sprites are usually 16-128)."),
        height: z.number().int().min(1).max(1024).describe("Canvas height in pixels."),
        colorMode: z.enum(["rgb", "grayscale", "indexed"]).default("rgb").describe("rgb unless asked otherwise."),
        frames: z.number().int().min(1).max(256).default(1).describe("Number of animation frames."),
        background: colorArg.optional().describe('Fill color (#rrggbb). Omit (or "transparent") for a transparent canvas.'),
      },
    },
    // The color is checked by the schema before anything is created: Aseprite opens the
    // new tab first, so a color it rejects would leave an empty tab behind on every retry.
    async ({ background, ...args }) => jsonResult(await gateway.createSprite({ ...args, background: fillColor(background) })),
  );

  server.registerTool(
    "list_sprites",
    {
      title: "List open sprites",
      description:
        "List the sprites open as tabs in Aseprite (id, file, size, frames, which one is active). " +
        "Use it when the user mentions another file, then select_sprite to switch.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const sprites = await gateway.listSprites();
      return jsonResult({
        sprites: sprites.map((s) => ({ ...s, name: basename(s.filename) || "untitled" })),
      });
    },
  );

  server.registerTool(
    "select_sprite",
    {
      title: "Select sprite",
      description:
        "Make another open sprite the active tab; every other tool then works on it. " +
        "Get ids from list_sprites. Returns the newly active sprite's info.",
      inputSchema: {
        id: z.number().int().describe("Sprite id from list_sprites."),
      },
    },
    async ({ id }) => {
      const sprites = await gateway.listSprites();
      if (!sprites.some((s) => s.id === id)) {
        const open = sprites.map(describeSprite).join(", ") || "none";
        throw new Error(`No open sprite has id ${id}. Open sprites: ${open}`);
      }
      await gateway.activateSprite(id);
      return jsonResult(await gateway.getSpriteInfo());
    },
  );
};
