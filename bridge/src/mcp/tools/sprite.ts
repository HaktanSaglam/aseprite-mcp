import { z } from "zod";
import type { ToolRegistrar } from "../ToolContext.js";
import { jsonResult } from "../toolResult.js";

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
        width: z.number().int().min(1).max(1024),
        height: z.number().int().min(1).max(1024),
        colorMode: z.enum(["rgb", "grayscale", "indexed"]).default("rgb"),
        frames: z.number().int().min(1).max(256).default(1),
        background: z.string().optional().describe("Fill color (#rrggbb). Omit for transparent."),
      },
    },
    async (args) => jsonResult(await gateway.createSprite(args)),
  );
};
