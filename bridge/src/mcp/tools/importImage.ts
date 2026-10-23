import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { z } from "zod";
import type { SpriteInfo } from "../../aseprite/protocol.js";
import { resolveInputPath } from "../../canvas/pathPolicy.js";
import { clipRect } from "../../canvas/selectionShapes.js";
import { decodePng } from "../../pixel/pngDecode.js";
import type { RgbaImage } from "../../pixel/RgbaImage.js";
import { detectGrid } from "../../pixel/unzoom.js";
import { gridSize } from "../../pixel/upscaleGrid.js";
import type { ToolRegistrar } from "../ToolContext.js";
import { textResult } from "./effects.js";

export const MAX_IMPORT_SIDE = 1024;
// A 1024x1024 RGBA PNG stays near 4 MB even uncompressed; a much bigger file is not one.
const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
// Pixel art rarely uses more; past this an import is a photo or a smooth render.
const MANY_COLORS = 64;

function readPngFile(path: string): RgbaImage {
  const bytes = statSync(path).size;
  if (bytes > MAX_IMPORT_BYTES) {
    throw new Error(`"${path}" is ${Math.round(bytes / 1048576)} MB, too big for a ${MAX_IMPORT_SIDE}x${MAX_IMPORT_SIDE} PNG`);
  }
  try {
    return decodePng(readFileSync(path), MAX_IMPORT_SIDE);
  } catch (error) {
    throw new Error(`Can't import "${path}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** "hero", else "hero 2", ...: a name no layer has, so an import never paints over the user's art. */
function newLayerName(info: SpriteInfo, file: string): string {
  // A "/" would address a group.
  const stem = basename(file, extname(file)).replace(/[\\/]/g, "-").trim() || "Imported";
  const taken = new Set(info.layers.map((l) => l.name));
  if (!taken.has(stem)) return stem;
  let n = 2;
  while (taken.has(`${stem} ${n}`)) n++;
  return `${stem} ${n}`;
}

function countColors(image: RgbaImage): number {
  const colors = new Set<number>();
  const d = image.data;
  for (let o = 0; o < d.length; o += 4) {
    if (d[o + 3] > 0) colors.add(((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0);
  }
  return colors.size;
}

/** What to do next with an import that is upscaled or has too many colors to be pixel art. */
function followUp(image: RgbaImage, layer: string): string {
  const grid = detectGrid([image]);
  const colors = countColors(image);
  const tips: string[] = [];
  if (grid.scale > 1) {
    const size = gridSize(image.width, image.height, grid);
    tips.push(
      `It looks ${grid.scale}x upscaled: normalize_pixel_art {layer: ${JSON.stringify(layer)}} turns it into ` +
        `${size.width}x${size.height} pixel art.`,
    );
  }
  if (colors > MANY_COLORS) {
    tips.push(
      `It has ${colors} colors (pixel art uses 4-32): add maxColors (e.g. 16) to normalize_pixel_art, or use reduce_colors.`,
    );
  }
  return tips.map((tip) => ` ${tip}`).join("");
}

export const registerImportImage: ToolRegistrar = (server, { gateway, canvas }) => {
  server.registerTool(
    "import_image",
    {
      title: "Import image",
      description:
        "Put a PNG file from disk onto a layer of the sprite (the bridge reads the file; nothing opens in Aseprite). " +
        `path: absolute or ~/..., .png only, at most ${MAX_IMPORT_SIDE}x${MAX_IMPORT_SIDE}, not inside hidden ` +
        "folders. Lands on a new layer named after the file unless layer is given, top-left corner at (x, y); " +
        "transparent pixels keep what is below, pixels beyond the canvas are dropped (create_sprite at the image " +
        "size first to keep everything). Screenshots, upscaled art and image-model renders: run " +
        "normalize_pixel_art next to get real 1x pixel art. One undo step.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute path or ~/... of a .png file, e.g. ~/Desktop/hero.png."),
        layer: z
          .string()
          .optional()
          .describe("Target layer, created if missing. Default: a new layer named after the file."),
        frame: z.number().int().min(1).optional().describe("1-based frame. Defaults to the active frame."),
        x: z.number().int().default(0).describe("Canvas x of the image's left edge."),
        y: z.number().int().default(0).describe("Canvas y of the image's top edge."),
      },
    },
    async ({ path, layer, frame, x, y }) => {
      const file = resolveInputPath(path, { extensions: [".png"], label: "path" });
      const image = readPngFile(file);
      // Pinned: the layer name and the write must concern the same sprite.
      const info = await gateway.getSpriteInfo();
      if (frame !== undefined && frame > info.frames.length) {
        throw new Error(`Frame ${frame} does not exist (sprite has ${info.frames.length} frames)`);
      }
      const visible = clipRect({ x, y, width: image.width, height: image.height }, info);
      if (!visible) {
        throw new Error(
          `At (${x}, ${y}) the ${image.width}x${image.height} image lies outside the ${info.width}x${info.height} ` +
            "canvas; use x/y inside it",
        );
      }
      const target = layer ?? newLayerName(info, file);
      await canvas.paint([{ x, y, image, frame, layer: target }], { sprite: info.id });

      const onto = layer === undefined ? `new layer "${target}"` : `layer "${target}"`;
      let text =
        `Imported ${basename(file)} (${image.width}x${image.height}) onto ${onto} at (${x}, ${y}), ` +
        `frame ${frame ?? info.activeFrame}.`;
      if (visible.width < image.width || visible.height < image.height) {
        text +=
          ` Only ${visible.width}x${visible.height} of it is on the ${info.width}x${info.height} canvas; the rest was ` +
          `dropped (create_sprite at ${image.width}x${image.height} and import again to keep it all).`;
      }
      if (info.colorMode === "indexed") text += " Indexed sprite: its colors were mapped to the nearest palette colors.";
      if (info.colorMode === "grayscale") text += " Grayscale sprite: its colors were stored as gray.";
      return textResult(text + followUp(image, target));
    },
  );
};
