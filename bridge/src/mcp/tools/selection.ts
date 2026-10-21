import { z } from "zod";
import type { IPixelGateway, Rect, SpriteInfo } from "../../aseprite/AsepriteGateway.js";
import {
  clipRect,
  colorMask,
  countSelected,
  ellipseMask,
  maskBounds,
  maskToRects,
  maskToRows,
  opaqueMask,
  type Mask,
  type Rgba,
} from "../../canvas/selectionShapes.js";
import { parseColor } from "../../pixel/PixelGridCodec.js";
import { rejectUnusedArgs } from "../actionArgs.js";
import type { ToolRegistrar } from "../ToolContext.js";
import { jsonResult } from "../toolResult.js";

export const SELECTION_SHAPES = ["rect", "ellipse", "all", "none", "invert", "color", "opaque"] as const;
export const SELECTION_MODES = ["replace", "add", "subtract", "intersect"] as const;

// Beyond this the '#'/'.' rows cost more tokens than they are worth.
export const MAX_MASK_SIDE = 64;

export interface SetSelectionArgs {
  shape: (typeof SELECTION_SHAPES)[number];
  mode?: (typeof SELECTION_MODES)[number];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string;
  tolerance?: number;
  contiguous?: boolean;
  layer?: string;
  frame?: number;
}

const SHAPE_PARAMS: Record<SetSelectionArgs["shape"], string[]> = {
  rect: ["mode", "x", "y", "width", "height"],
  ellipse: ["mode", "x", "y", "width", "height"],
  all: [],
  none: [],
  invert: [],
  color: ["mode", "color", "tolerance", "contiguous", "x", "y", "layer", "frame"],
  opaque: ["mode", "layer", "frame"],
};

/** What a shape covers on the canvas, ready for gateway.setSelection. */
export interface SelectionShape {
  rects: number[][];
  pixels: number;
  bounds?: Rect;
  /** The color that was matched (shape "color"), as #rrggbbaa. */
  color?: string;
}

function fromMask(mask: Mask): SelectionShape {
  return { rects: maskToRects(mask), pixels: countSelected(mask.data), bounds: maskBounds(mask) };
}

function requireBox(args: SetSelectionArgs): Rect {
  const { x, y, width, height } = args;
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    throw new Error(`'${args.shape}' needs x, y, width and height`);
  }
  return { x, y, width, height };
}

function toHex(rgba: Rgba): string {
  return `#${rgba.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function pixelAt(image: { width: number; data: Uint8Array }, x: number, y: number): Rgba {
  const o = (y * image.width + x) * 4;
  return [image.data[o], image.data[o + 1], image.data[o + 2], image.data[o + 3]];
}

async function colorShape(args: SetSelectionArgs, info: SpriteInfo, gateway: IPixelGateway): Promise<SelectionShape> {
  if ((args.x === undefined) !== (args.y === undefined)) throw new Error("'color' needs both x and y, or neither");
  const point = args.x !== undefined && args.y !== undefined ? { x: args.x, y: args.y } : undefined;
  if (args.contiguous && !point) {
    throw new Error("contiguous: true needs x and y of the pixel to start from (magic wand)");
  }
  if (args.color === undefined && !point) {
    throw new Error("'color' needs color, or x and y of a pixel whose color to select");
  }
  if (args.color !== undefined && point && !args.contiguous) {
    throw new Error("x and y are only used with contiguous: true, or instead of color to sample it");
  }
  if (point && (point.x < 0 || point.y < 0 || point.x >= info.width || point.y >= info.height)) {
    throw new Error(`Pixel (${point.x}, ${point.y}) is outside the ${info.width}x${info.height} canvas`);
  }

  const source = args.layer === undefined ? "the visible image" : `layer "${args.layer}"`;
  const { image } = await gateway.readImage(
    args.layer === undefined ? { frame: args.frame, flattened: true } : { frame: args.frame, layer: args.layer },
  );
  // Validation above guarantees a point whenever no color was given.
  const color = args.color !== undefined ? parseColor(args.color) : pixelAt(image, point!.x, point!.y);
  const tolerance = args.tolerance ?? 0;
  const seed = args.contiguous ? point : undefined;
  const mask = colorMask(image, { x: 0, y: 0 }, color, { tolerance, seed });
  const shape = { ...fromMask(mask), color: toHex(color) };
  if (shape.pixels === 0) {
    const where = seed ? ` at (${seed.x}, ${seed.y})` : "";
    throw new Error(
      `No pixels of ${source}${where} match ${toHex(color)} within tolerance ${tolerance}; selection unchanged. ` +
        "Raise tolerance, or pass x/y to sample an existing color.",
    );
  }
  return shape;
}

/** Computes the pixels a set_selection call covers; throws instead of selecting nothing. */
export async function selectionShape(
  args: SetSelectionArgs,
  info: SpriteInfo,
  gateway: IPixelGateway,
): Promise<SelectionShape> {
  const { shape, ...rest } = args;
  rejectUnusedArgs(shape, rest, SHAPE_PARAMS[shape]);
  const canvas = { width: info.width, height: info.height };
  switch (shape) {
    case "rect": {
      const rect = clipRect(requireBox(args), canvas);
      if (!rect) throw new Error(`The rect lies outside the ${info.width}x${info.height} canvas; selection unchanged`);
      return { rects: [[rect.x, rect.y, rect.width, rect.height]], pixels: rect.width * rect.height, bounds: rect };
    }
    case "ellipse": {
      const mask = ellipseMask(requireBox(args), canvas);
      const result = mask ? fromMask(mask) : undefined;
      if (!result || result.pixels === 0) {
        throw new Error(`The ellipse lies outside the ${info.width}x${info.height} canvas; selection unchanged`);
      }
      return result;
    }
    case "color":
      return colorShape(args, info, gateway);
    case "opaque": {
      const { image } = await gateway.readImage({ frame: args.frame, layer: args.layer });
      const result = fromMask(opaqueMask(image, { x: 0, y: 0 }));
      if (result.pixels === 0) {
        const layer = args.layer === undefined ? "The active layer" : `Layer "${args.layer}"`;
        throw new Error(`${layer} has no visible pixels on frame ${args.frame ?? info.activeFrame}; selection unchanged`);
      }
      return result;
    }
    case "all":
    case "none":
    case "invert":
      return { rects: [], pixels: 0 };
  }
}

export const registerSelectionTools: ToolRegistrar = (server, { gateway }) => {
  server.registerTool(
    "get_selection",
    {
      title: "Get selection",
      description:
        "Read the user's current selection in the active sprite: bounds, number of selected pixels and " +
        "whether it is a plain rectangle. includeMask adds the exact shape as rows of '#' (selected) " +
        `and '.' for selections up to ${MAX_MASK_SIDE}x${MAX_MASK_SIDE}. Pixel tools with selectionOnly: true ` +
        "only change selected pixels.",
      inputSchema: {
        includeMask: z
          .boolean()
          .default(false)
          .describe(`Also return the shape as '#'/'.' rows (up to ${MAX_MASK_SIDE}x${MAX_MASK_SIDE}).`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ includeMask }) => {
      const selection = await gateway.readSelection({});
      if (selection.isEmpty) {
        return jsonResult({ isEmpty: true, note: "Nothing is selected; pixel tools act on the whole layer." });
      }
      const bounds = selection.bounds ?? selection.rect;
      const pixelCount = countSelected(selection.mask);
      const result: Record<string, unknown> = {
        isEmpty: false,
        bounds,
        pixelCount,
        isRectangle: pixelCount === bounds.width * bounds.height,
      };
      if (includeMask) {
        if (selection.rect.width <= MAX_MASK_SIDE && selection.rect.height <= MAX_MASK_SIDE) {
          const { rect, mask } = selection;
          result.mask = { x: rect.x, y: rect.y, rows: maskToRows({ rect, data: mask }) };
        } else {
          result.maskOmitted =
            `The selection is ${bounds.width}x${bounds.height}; masks are only returned up to ` +
            `${MAX_MASK_SIDE}x${MAX_MASK_SIDE}. Use view_sprite with region set to the bounds to see it.`;
        }
      }
      return jsonResult(result);
    },
  );

  server.registerTool(
    "set_selection",
    {
      title: "Set selection",
      description:
        "Select pixels so later edits (selectionOnly: true) touch only them; also what the user sees as " +
        "marching ants. One undo step. Shapes:\n" +
        "- rect / ellipse: x, y, width, height (ellipse fits inside that box)\n" +
        "- color: pixels matching color within tolerance (0 = exact, 100 = everything), read from the " +
        "visible image or layer. Instead of color pass x, y to sample a pixel; contiguous: true with x, y " +
        "selects only the connected area (magic wand)\n" +
        "- opaque: every non-transparent pixel of layer (default: active layer)\n" +
        "- all, none (deselect), invert\n" +
        "mode combines with the current selection: replace (default), add, subtract, intersect.",
      inputSchema: {
        shape: z.enum(SELECTION_SHAPES).describe("What to select; each shape uses only the arguments listed above."),
        mode: z.enum(SELECTION_MODES).optional().describe("How to combine with the current selection (default replace)."),
        x: z.number().int().optional().describe("rect/ellipse: left edge; color: pixel to sample or start the wand from."),
        y: z.number().int().optional().describe("rect/ellipse: top edge; color: pixel to sample or start the wand from."),
        width: z.number().int().min(1).optional().describe("rect/ellipse: width of the box."),
        height: z.number().int().min(1).optional().describe("rect/ellipse: height of the box."),
        color: z.string().optional().describe('color: "#rrggbb", "#rrggbbaa" or "transparent".'),
        tolerance: z.number().min(0).max(100).optional().describe("color: 0 (exact, default) to 100 (any color)."),
        contiguous: z.boolean().optional().describe("color: only the area connected to x, y (magic wand)."),
        layer: z
          .string()
          .optional()
          .describe("color/opaque: read this layer (color default: visible image; opaque default: active layer)."),
        frame: z.number().int().min(1).optional().describe("color/opaque: frame to read (default: active frame)."),
      },
    },
    async (args) => {
      const info = await gateway.getSpriteInfo();
      const shape = await selectionShape(args, info, gateway);
      const mode = args.mode ?? "replace";
      const { shape: kind } = args;
      const isOp = kind === "all" || kind === "none" || kind === "invert";
      const result = await gateway.setSelection(isOp ? kind : mode, shape.rects);
      return jsonResult({
        isEmpty: result.isEmpty,
        ...(result.bounds ? { bounds: result.bounds } : {}),
        shape: args.shape,
        ...(isOp ? {} : { mode, shapePixels: shape.pixels }),
        ...(shape.color ? { color: shape.color } : {}),
        note: result.isEmpty
          ? "Nothing is selected now; pixel tools act on the whole layer."
          : "Tools with selectionOnly: true now change only the selected pixels.",
      });
    },
  );
};
