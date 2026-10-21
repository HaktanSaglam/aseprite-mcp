import { z } from "zod";
import type { IPaletteGateway } from "../../aseprite/AsepriteGateway.js";
import { resolveFrames } from "../../canvas/CanvasService.js";
import { compose, type PixelFilter } from "../../pixel/composite.js";
import { formatHex, parseHex } from "../../pixel/color.js";
import { adjustColors, hasAdjustments } from "../../pixel/effects/adjustColors.js";
import { replaceColor } from "../../pixel/effects/replaceColor.js";
import { getPalettePreset, isPalettePresetId, PALETTE_PRESET_IDS } from "../../pixel/palettes.js";
import { binarizeAlpha, DITHER_MODES, extractPalette, mapToPalette } from "../../pixel/quantize.js";
import type { RgbaImage } from "../../pixel/RgbaImage.js";
import type { ToolRegistrar } from "../ToolContext.js";
import { colorArg, describeTarget, plural, runEffect, targetArgs, textResult, toleranceArg } from "./effects.js";

const ditherArg = z
  .enum(DITHER_MODES)
  .default("none")
  .describe(
    "'none': flat colors (cleanest pixel art); 'ordered': tidy Bayer pattern for gradients; 'floyd': smooth, noisier.",
  );

/** A palette argument: preset id, "current" (the sprite's own palette) or explicit colors. */
async function resolvePalette(
  spec: string | string[],
  gateway: IPaletteGateway,
): Promise<{ colors: string[]; label: string }> {
  if (Array.isArray(spec)) {
    return { colors: spec.map((c) => formatHex(...parseHex(c))), label: "the custom palette" };
  }
  if (spec === "current") {
    const { colors } = await gateway.getPalette();
    // The transparent slot of an indexed palette is not a color anyone paints with.
    const opaque = colors.filter((c) => parseHex(c)[3] > 0).map((c) => formatHex(...parseHex(c)));
    return { colors: opaque, label: "the sprite palette" };
  }
  if (!isPalettePresetId(spec)) {
    throw new Error(
      `Unknown palette "${spec}". Use a preset (${PALETTE_PRESET_IDS.join(", ")}), "current", ` +
        'or an array of "#rrggbb" colors.',
    );
  }
  const preset = getPalettePreset(spec);
  return { colors: [...preset.colors], label: preset.name };
}

/**
 * Indexed sprites keep a fully transparent entry at their transparent index; without it
 * the preset color landing on that index would render as transparent and be unpaintable.
 */
function withTransparentSlot(colors: string[], transparentIndex: number): string[] {
  const at = Math.max(0, Math.min(transparentIndex, colors.length));
  return [...colors.slice(0, at), "#00000000", ...colors.slice(at)];
}

export const registerColorTools: ToolRegistrar = (server, { gateway, canvas }) => {
  server.registerTool(
    "reduce_colors",
    {
      title: "Reduce colors",
      description:
        "Reduce the art to at most `colors` colors, chosen from the art itself (perceptual median cut + k-means; " +
        "colors snap to existing ones, so hand-picked colors survive). Use on imported/AI images or busy art to get " +
        "a clean pixel-art palette; all target frames share one palette so animations don't flicker. " +
        "Semi-transparent pixels become fully opaque (alpha >= 128) or fully transparent. One undo step.",
      inputSchema: {
        colors: z.number().int().min(2).max(64).describe("Maximum number of colors, e.g. 8, 16 or 32."),
        dither: ditherArg,
        ...targetArgs,
      },
    },
    async ({ colors, dither, layer, frames, selectionOnly }) => {
      const info = await gateway.getSpriteInfo();
      const frameList = resolveFrames(frames, info);
      const filter: PixelFilter | undefined = selectionOnly ? await canvas.selectionFilter({}) : undefined;

      // One palette for every frame: read them all first when there is more than one.
      let palette: string[] | undefined;
      if (frameList.length > 1) {
        const images: RgbaImage[] = [];
        for (const frame of frameList) images.push((await gateway.readImage({ frame, layer })).image);
        palette = extractPalette(images, colors, filter);
      }
      const run = await runEffect(
        canvas,
        { layer, frames: frameList, selectionOnly },
        (image) => {
          palette ??= extractPalette([image], colors, filter);
          return palette.length > 0 ? mapToPalette(image, palette, dither) : binarizeAlpha(image);
        },
        filter,
      );
      const where = describeTarget(layer, run.frames);
      if (!palette || palette.length === 0) return textResult(`Nothing to reduce: ${where} has no opaque pixels.`);
      return textResult(
        `Reduced to ${plural(palette.length, "color")} (dither ${dither}) on ${where}: ` +
          `${plural(run.changed, "pixel")} changed. Palette: ${palette.join(" ")}`,
      );
    },
  );

  server.registerTool(
    "apply_palette",
    {
      title: "Apply palette",
      description:
        "Redraw the art using only the colors of a palette (nearest perceptual match): a preset id, 'current' " +
        "(the sprite's palette) or a list of colors. setSpritePalette also makes it the sprite's palette, which " +
        "indexed sprites need (their pixels can only use sprite-palette colors). Semi-transparent pixels snap to " +
        "opaque/transparent. One undo step (two with setSpritePalette).",
      inputSchema: {
        palette: z
          .union([z.string(), z.array(colorArg).min(1).max(256)])
          .describe(`Preset id (${PALETTE_PRESET_IDS.join(", ")}), "current", or ["#rrggbb", ...].`),
        dither: ditherArg,
        setSpritePalette: z.boolean().default(false).describe("Also replace the sprite's palette with these colors."),
        ...targetArgs,
      },
    },
    async ({ palette: spec, dither, setSpritePalette, layer, frames, selectionOnly }) => {
      const { colors, label } = await resolvePalette(spec, gateway);
      if (colors.length === 0) throw new Error(`${label} has no opaque colors to map to`);
      const info = await gateway.getSpriteInfo();
      const frameList = resolveFrames(frames, info);
      const updatePalette = setSpritePalette && spec !== "current";

      if (updatePalette && info.colorMode === "indexed") {
        // Indexed pixels store palette indexes: remap while the old palette still decodes
        // them, swap the palette, then write (encoded against the new palette).
        const filter = selectionOnly ? await canvas.selectionFilter({}) : undefined;
        const writes = [];
        for (const frame of frameList) {
          const { image } = await gateway.readImage({ frame, layer });
          const mapped = mapToPalette(image, colors, dither);
          const result = filter ? compose(image, mapped, "replace", { x: 0, y: 0 }, filter) : mapped;
          writes.push({ x: 0, y: 0, frame, layer, image: result });
        }
        await gateway.setPalette(withTransparentSlot(colors, info.transparentIndex));
        await gateway.writeImages(writes);
        const others = info.layers.filter((l) => !l.isGroup).length > 1 || frameList.length < info.frames.length;
        return textResult(
          `Applied ${label} (${colors.length} colors, dither ${dither}) to ${describeTarget(layer, frameList)} ` +
            "and set it as the sprite palette." +
            (others
              ? " Indexed sprite: other layers/frames keep their palette indexes, so they now show the new colors " +
                "by index; apply the palette to them too (frames: \"all\", each layer) if they look wrong."
              : ""),
        );
      }

      const run = await runEffect(canvas, { layer, frames: frameList, selectionOnly }, (image) =>
        mapToPalette(image, colors, dither),
      );
      if (updatePalette) await gateway.setPalette(colors);
      const snapped =
        info.colorMode === "indexed" && spec !== "current"
          ? " Indexed sprite: pixels were snapped to the nearest sprite-palette colors; pass setSpritePalette: true " +
            "to get this palette's exact colors."
          : "";
      return textResult(
        `Applied ${label} (${colors.length} colors, dither ${dither}) to ${describeTarget(layer, run.frames)}: ` +
          `${plural(run.changed, "pixel")} changed${updatePalette ? "; sprite palette replaced" : ""}.${snapped}`,
      );
    },
  );

  server.registerTool(
    "adjust_colors",
    {
      title: "Adjust colors",
      description:
        "Shift hue, saturation, lightness, brightness or contrast, invert, or convert to grayscale. Use for " +
        "recolors (e.g. a red variant of a blue enemy: hue), mood (night: lightness/saturation down) or damage " +
        "flashes (invert on a copied frame). Order: invert, hue/saturation/lightness, brightness, contrast, " +
        "grayscale; alpha is kept. One undo step.",
      inputSchema: {
        hue: z.number().min(-180).max(180).optional().describe("Degrees around the color wheel."),
        saturation: z.number().min(-100).max(100).optional().describe("-100 = gray, +100 = fully saturated."),
        lightness: z.number().min(-100).max(100).optional().describe("-100 = black, +100 = white."),
        brightness: z.number().min(-100).max(100).optional().describe("Adds the same amount to every channel."),
        contrast: z.number().min(-100).max(100).optional().describe("Negative flattens toward gray, positive punches."),
        invert: z.boolean().optional().describe("Negative colors (applied first)."),
        grayscale: z.boolean().optional().describe("Convert to gray (applied last)."),
        ...targetArgs,
      },
    },
    async ({ layer, frames, selectionOnly, ...adjustments }) => {
      if (!hasAdjustments(adjustments)) {
        throw new Error(
          "Nothing to adjust: pass at least one of hue, saturation, lightness, brightness, contrast, invert, grayscale",
        );
      }
      const run = await runEffect(canvas, { layer, frames, selectionOnly }, (image) =>
        adjustColors(image, adjustments).image,
      );
      const applied = Object.entries(adjustments)
        .filter(([, v]) => v !== undefined && v !== 0 && v !== false)
        .map(([k, v]) => (v === true ? k : `${k} ${(v as number) > 0 ? "+" : ""}${v}`))
        .join(", ");
      return textResult(
        `Adjusted ${applied} on ${describeTarget(layer, run.frames)}: ${plural(run.changed, "pixel")} changed.`,
      );
    },
  );

  server.registerTool(
    "replace_color",
    {
      title: "Replace color",
      description:
        "Replace one color with another across the layer (not just a connected area). tolerance also catches " +
        "near shades, which all become exactly `to`. 'transparent' as `to` erases; as `from` it fills every " +
        "empty pixel. Use read_pixels or analyze_sprite to find the exact colors first. One undo step.",
      inputSchema: {
        from: colorArg.describe("Color to replace."),
        to: colorArg.describe("New color."),
        tolerance: toleranceArg.default(0),
        ...targetArgs,
      },
    },
    async ({ from, to, tolerance, layer, frames, selectionOnly }) => {
      const fromRgba = parseHex(from);
      const toRgba = parseHex(to);
      const run = await runEffect(canvas, { layer, frames, selectionOnly }, (image) =>
        replaceColor(image, fromRgba, toRgba, tolerance).image,
      );
      const where = describeTarget(layer, run.frames);
      if (run.changed === 0) {
        return textResult(
          `No pixels matched ${from} (tolerance ${tolerance}) on ${where}. Check the exact color with read_pixels ` +
            "or analyze_sprite, or raise tolerance.",
        );
      }
      return textResult(
        `Replaced ${plural(run.changed, "pixel")} of ${from} (tolerance ${tolerance}) with ${to} on ${where}.`,
      );
    },
  );
};
