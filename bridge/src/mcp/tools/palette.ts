import type { ToolRegistrar } from "../ToolContext.js";
import { jsonResult } from "../toolResult.js";

export const registerPaletteTools: ToolRegistrar = (server, { gateway }) => {
  server.registerTool(
    "get_palette",
    {
      title: "Get palette",
      description:
        "List the sprite's palette as '#rrggbbaa' colors in index order. Prefer these colors " +
        "when drawing so new pixels match the user's existing art.",
      annotations: { readOnlyHint: true },
    },
    async () => jsonResult({ colors: (await gateway.getPalette()).colors }),
  );
};
