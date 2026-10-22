import { z } from "zod";
import { formatHex, parseHex } from "../../pixel/color.js";
import { getPalettePreset, PALETTE_PRESET_IDS, suggestRamps } from "../../pixel/palettes.js";
import type { ToolRegistrar } from "../ToolContext.js";
import { jsonResult } from "../toolResult.js";
import { colorArg, textResult } from "./effects.js";

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
    async () => {
      const { colors, transparentIndex } = await gateway.getPalette();
      return jsonResult({ colors, transparentIndex });
    },
  );

  server.registerTool(
    "set_palette",
    {
      title: "Set palette",
      description:
        "Replace the sprite's palette with explicit colors or a preset. RGB sprites: only the swatches change, " +
        "pixels stay as they are (use apply_palette to also recolor the art). Indexed sprites: pixels store " +
        "palette indexes, so this RECOLORS existing art (index i shows new color i), a palette swap.",
      inputSchema: {
        colors: z.array(colorArg).min(1).max(256).optional().describe('["#rrggbb", ...] in index order.'),
        preset: z.enum(PALETTE_PRESET_IDS).optional().describe("A built-in palette instead of colors."),
      },
    },
    async ({ colors, preset }) => {
      if ((colors === undefined) === (preset === undefined)) {
        throw new Error(`Pass exactly one of colors (["#rrggbb", ...]) or preset (${PALETTE_PRESET_IDS.join(", ")})`);
      }
      const list = preset ? [...getPalettePreset(preset).colors] : colors!.map((c) => formatHex(...parseHex(c)));
      const info = await gateway.getSpriteInfo();
      // Pinned, so the warnings below are about the sprite that really changed.
      await gateway.setPalette(list, { sprite: info.id });

      let text = `Sprite palette set to ${list.length} colors${preset ? ` (${getPalettePreset(preset).name})` : ""}.`;
      if (info.colorMode === "indexed") {
        text += " Indexed sprite: existing pixels now show the new color at their index.";
        if (list.length < info.paletteSize) {
          text +=
            ` The old palette had ${info.paletteSize} colors: pixels using index ${list.length} or higher now show ` +
            "nothing (they keep their index; a palette that long brings them back).";
        }
        const slot = list[info.transparentIndex];
        if (slot !== undefined && parseHex(slot)[3] > 0) {
          text +=
            ` Index ${info.transparentIndex} (${slot}) is the transparent index, so it renders transparent and can't ` +
            'be painted; put "#00000000" first if every color must be drawable.';
        }
      }
      return textResult(text);
    },
  );

  server.registerTool(
    "get_palette_preset",
    {
      title: "Get palette preset",
      description:
        "Get the exact colors of a well-known pixel-art palette, plus suggested shading ramps (colors grouped by " +
        "hue, dark → light). Draw with 3-4 neighbouring colors of a ramp for shadow/base/highlight and the darkest " +
        "colors for outlines. Pair with set_palette / apply_palette to use the palette in the sprite.",
      inputSchema: {
        id: z.enum(PALETTE_PRESET_IDS).describe("Palette preset id."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const preset = getPalettePreset(id);
      return jsonResult({ ...preset, size: preset.colors.length, ramps: suggestRamps(preset.colors) });
    },
  );
};
