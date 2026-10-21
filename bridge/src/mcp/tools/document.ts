import { basename, dirname, extname, join } from "node:path";
import { z } from "zod";
import type { IPixelGateway } from "../../aseprite/AsepriteGateway.js";
import type { ColorMode, ExportOptions, Rect, SpriteInfo, SpriteOp } from "../../aseprite/protocol.js";
import { nodePathProbe, resolveOutputPath, type PathProbe } from "../../canvas/pathPolicy.js";
import { maskBounds, opaqueMask } from "../../canvas/selectionShapes.js";
import { rejectUnusedArgs } from "../actionArgs.js";
import type { ToolRegistrar } from "../ToolContext.js";
import { jsonResult } from "../toolResult.js";

// Bigger canvases make every pixel tool slow and previews useless; nobody pixels at 4K.
export const MAX_CANVAS_SIDE = 2048;
const SAVE_EXTENSIONS = [".aseprite", ".ase", ".png", ".gif"] as const;

export const EDIT_ACTIONS = ["resize", "canvas", "crop", "trim", "color_mode", "rotate", "flip"] as const;

export interface EditSpriteArgs {
  action: (typeof EDIT_ACTIONS)[number];
  width?: number;
  height?: number;
  scale?: number;
  method?: "nearest" | "bilinear" | "rotsprite";
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  x?: number;
  y?: number;
  mode?: ColorMode;
  angle?: 90 | 180 | 270;
  direction?: "horizontal" | "vertical";
}

type CanvasInfo = Pick<SpriteInfo, "width" | "height" | "selection">;

function checkSize(width: number, height: number, what: string): void {
  if (width < 1 || height < 1) throw new Error(`${what} would be ${width}x${height}; both sides must be at least 1`);
  if (width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE) {
    throw new Error(`${what} would be ${width}x${height}; the maximum is ${MAX_CANVAS_SIDE} per side`);
  }
}

function resizeOp(args: EditSpriteArgs, info: CanvasInfo): SpriteOp {
  let { width, height } = args;
  if (args.scale !== undefined) {
    if (width !== undefined || height !== undefined) throw new Error("resize: pass either scale or width/height, not both");
    width = Math.round(info.width * args.scale);
    height = Math.round(info.height * args.scale);
  } else if (width !== undefined && height === undefined) {
    height = Math.max(1, Math.round((info.height * width) / info.width));
  } else if (height !== undefined && width === undefined) {
    width = Math.max(1, Math.round((info.width * height) / info.height));
  }
  if (width === undefined || height === undefined) throw new Error("resize needs width and/or height, or scale");
  checkSize(width, height, "The resized sprite");
  return { op: "resize", width, height, method: args.method ?? "nearest" };
}

function canvasOp(args: EditSpriteArgs, info: CanvasInfo): SpriteOp {
  const { left = 0, top = 0, right = 0, bottom = 0 } = args;
  if (left === 0 && top === 0 && right === 0 && bottom === 0) {
    throw new Error("canvas needs left, top, right and/or bottom: pixels to add (positive) or remove (negative)");
  }
  checkSize(info.width + left + right, info.height + top + bottom, "The canvas");
  return { op: "canvas", left, top, right, bottom };
}

function cropOp(args: EditSpriteArgs, info: CanvasInfo): SpriteOp {
  let rect: Rect;
  if (args.width !== undefined || args.height !== undefined) {
    if (args.width === undefined || args.height === undefined) throw new Error("crop needs both width and height");
    rect = { x: args.x ?? 0, y: args.y ?? 0, width: args.width, height: args.height };
  } else if (info.selection) {
    rect = info.selection;
  } else {
    throw new Error("crop needs x, y, width and height (or an active selection to crop to)");
  }
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > info.width || rect.y + rect.height > info.height) {
    throw new Error(
      `crop rect ${rect.x},${rect.y} ${rect.width}x${rect.height} must lie inside the ${info.width}x${info.height} ` +
        "canvas; use action 'canvas' to grow it instead",
    );
  }
  return { op: "crop", ...rect };
}

const EDIT_PARAMS: Record<EditSpriteArgs["action"], string[]> = {
  resize: ["width", "height", "scale", "method"],
  canvas: ["left", "top", "right", "bottom"],
  crop: ["x", "y", "width", "height"],
  trim: [],
  color_mode: ["mode"],
  rotate: ["angle"],
  flip: ["direction"],
};

/**
 * Validates the flat tool arguments of one action and builds the protocol's sprite_op.
 * `content` (the visible art's bounds over all frames) is only needed for trim.
 */
export function toSpriteOp(args: EditSpriteArgs, info: CanvasInfo, content?: Rect): SpriteOp {
  rejectUnusedArgs(args.action, args, EDIT_PARAMS[args.action]);
  switch (args.action) {
    case "resize":
      return resizeOp(args, info);
    case "canvas":
      return canvasOp(args, info);
    case "crop":
      return cropOp(args, info);
    case "trim":
      if (!content) throw new Error("The sprite has no visible pixels; there is nothing to trim to");
      return { op: "crop", ...content };
    case "color_mode":
      if (!args.mode) throw new Error("color_mode needs mode: rgb, grayscale or indexed");
      return { op: "color_mode", mode: args.mode };
    case "rotate":
      if (args.angle === undefined) throw new Error("rotate needs angle: 90, 180 or 270 (clockwise)");
      return { op: "rotate", angle: args.angle };
    case "flip":
      if (!args.direction) throw new Error("flip needs direction: horizontal or vertical");
      return { op: "flip", direction: args.direction };
  }
}

/** Union of the non-transparent pixels of every frame, as Aseprite's Sprite > Trim sees them. */
export async function contentBounds(
  gateway: Pick<IPixelGateway, "readImage">,
  info: SpriteInfo,
): Promise<Rect | undefined> {
  // Requests are pipelined; Aseprite answers them in order.
  const reads = await Promise.all(info.frames.map((f) => gateway.readImage({ frame: f.index, flattened: true })));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const { image } of reads) {
    const b = maskBounds(opaqueMask(image, { x: 0, y: 0 }));
    if (!b) continue;
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.width);
    y1 = Math.max(y1, b.y + b.height);
  }
  return x1 < 0 ? undefined : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function summary(info: SpriteInfo) {
  return {
    width: info.width,
    height: info.height,
    colorMode: info.colorMode,
    frames: info.frames.length,
    layers: info.layers.length,
    ...(info.selection ? { selection: info.selection } : {}),
  };
}

// ---- export planning ------------------------------------------------------------

export type ExportKind = ExportOptions["kind"];

export interface ExportArgs {
  path: string;
  kind?: ExportKind;
  scale?: number;
  frame?: number;
  tag?: string;
  sheetType?: ExportOptions["sheetType"];
  columns?: number;
  dataPath?: string;
  overwrite?: boolean;
}

export interface ExportPlan {
  options: ExportOptions;
  /** Human-readable list of what gets written. */
  files: string[];
  frameCount: number;
}

function inferKind(path: string): ExportKind {
  const ext = extname(path.trim()).toLowerCase();
  if (ext === ".gif") return "gif";
  if (ext === ".png") return "png";
  throw new Error(`Cannot tell the export kind from "${path}"; end the path with .png or .gif, or pass kind`);
}

function rejectOption(present: boolean, message: string): void {
  if (present) throw new Error(message);
}

/**
 * Checks an export request against the sprite and the file system before Aseprite
 * writes anything, so the model gets a precise error instead of a silent wrong file.
 */
export function planExport(args: ExportArgs, info: SpriteInfo, probe: PathProbe = nodePathProbe): ExportPlan {
  const kind = args.kind ?? inferKind(args.path);
  const extensions = kind === "gif" ? [".gif"] : [".png"];

  rejectOption(
    kind !== "png" && args.frame !== undefined,
    "frame only applies to kind 'png'; use tag to export a range of frames",
  );
  rejectOption(
    kind === "png" && args.tag !== undefined,
    "tag does not apply to a single png; use kind 'gif', 'sheet' or 'frames'",
  );
  rejectOption(
    kind === "sheet" && args.scale !== undefined,
    "scale is not available for sheets; export kind 'frames' with scale, or resize the sprite first",
  );
  for (const option of ["sheetType", "columns", "dataPath"] as const) {
    rejectOption(kind !== "sheet" && args[option] !== undefined, `${option} only applies to kind 'sheet'`);
  }

  if (args.frame !== undefined && args.frame > info.frames.length) {
    throw new Error(`Frame ${args.frame} out of range (sprite has ${info.frames.length} frames)`);
  }
  let frameCount = kind === "png" ? 1 : info.frames.length;
  if (args.tag !== undefined) {
    const tag = info.tags.find((t) => t.name === args.tag);
    if (!tag) {
      const names = info.tags.map((t) => t.name).join(", ") || "none";
      throw new Error(`Tag "${args.tag}" not found. Tags: ${names}`);
    }
    frameCount = tag.to - tag.from + 1;
  }

  const files: string[] = [];
  let path: string;
  if (kind === "frames") {
    // Aseprite numbers a png sequence itself: hero.png → hero1.png, hero2.png, ...
    path = resolveOutputPath(args.path, { extensions, overwrite: true, label: "path" }, probe);
    const stem = join(dirname(path), basename(path, extname(path)));
    const first = `${stem}1${extname(path)}`;
    if (probe.kind(first) === "file" && !args.overwrite) {
      throw new Error(`"${first}" already exists; pass overwrite: true to replace the sequence or choose another name`);
    }
    files.push(frameCount > 1 ? `${first} … ${stem}${frameCount}${extname(path)}` : first);
  } else {
    path = resolveOutputPath(args.path, { extensions, overwrite: args.overwrite, label: "path" }, probe);
    files.push(path);
  }

  let dataPath: string | undefined;
  if (args.dataPath !== undefined) {
    const rules = { extensions: [".json"], overwrite: args.overwrite, label: "dataPath" };
    dataPath = resolveOutputPath(args.dataPath, rules, probe);
    files.push(dataPath);
  }

  const options: ExportOptions = { path, kind };
  if (args.scale !== undefined) options.scale = args.scale;
  if (args.frame !== undefined) options.frame = args.frame;
  if (args.tag !== undefined) options.tag = args.tag;
  if (kind === "sheet") {
    // A column count only means something for a grid; a plain strip would ignore it.
    options.sheetType = args.sheetType ?? (args.columns !== undefined ? "rows" : "horizontal");
    if (args.columns !== undefined) options.columns = args.columns;
    if (dataPath) options.dataPath = dataPath;
  }
  return { options, files, frameCount };
}

function hasBeenSaved(filename: string): boolean {
  return /[/\\]/.test(filename);
}

// ---- tools ----------------------------------------------------------------------

export const registerDocumentTools: ToolRegistrar = (server, { gateway }) => {
  server.registerTool(
    "edit_sprite",
    {
      title: "Edit sprite (resize, canvas, crop, trim, rotate, flip, color mode)",
      description:
        "Change the whole sprite (all layers and frames) in one undo step. Pick an action:\n" +
        "- resize: scale the art. width and/or height (aspect kept if one is omitted) or scale " +
        "(2 = double). method defaults to nearest (crisp pixels).\n" +
        "- canvas: add (positive) or remove (negative) pixels at left/top/right/bottom without " +
        "scaling the art.\n" +
        "- crop: keep only x, y, width, height (omit them to crop to the current selection).\n" +
        "- trim: cut away the transparent margins around the visible art of all frames.\n" +
        "- color_mode: convert to rgb, grayscale or indexed (mode).\n" +
        "- rotate: angle 90, 180 or 270 clockwise.\n" +
        "- flip: direction horizontal or vertical.\n" +
        "To edit one layer only, use transform_layer instead. Returns the new size.",
      inputSchema: {
        action: z.enum(EDIT_ACTIONS).describe("What to change; each action uses only the arguments listed above."),
        width: z.number().int().min(1).optional().describe("resize: new width; crop: width of the kept area."),
        height: z.number().int().min(1).optional().describe("resize: new height; crop: height of the kept area."),
        scale: z.number().positive().max(64).optional().describe("resize: factor (2, 0.5) instead of width/height."),
        method: z
          .enum(["nearest", "bilinear", "rotsprite"])
          .optional()
          .describe("resize: nearest (default) keeps hard pixel edges."),
        left: z.number().int().optional().describe("canvas: pixels to add (+) or cut (-) on the left."),
        top: z.number().int().optional().describe("canvas: pixels to add (+) or cut (-) at the top."),
        right: z.number().int().optional().describe("canvas: pixels to add (+) or cut (-) on the right."),
        bottom: z.number().int().optional().describe("canvas: pixels to add (+) or cut (-) at the bottom."),
        x: z.number().int().min(0).optional().describe("crop: left edge of the kept area."),
        y: z.number().int().min(0).optional().describe("crop: top edge of the kept area."),
        mode: z.enum(["rgb", "grayscale", "indexed"]).optional().describe("color_mode: target color mode."),
        angle: z.union([z.literal(90), z.literal(180), z.literal(270)]).optional().describe("rotate: degrees clockwise."),
        direction: z.enum(["horizontal", "vertical"]).optional().describe("flip: mirror axis."),
      },
    },
    async (args) => {
      const before = await gateway.getSpriteInfo();
      const content = args.action === "trim" ? await contentBounds(gateway, before) : undefined;
      const op = toSpriteOp(args, before, content);
      // No-ops would still cost the user an undo step, so report them instead.
      const fullCanvas = content?.width === before.width && content.height === before.height;
      const unchanged =
        op.op === "color_mode" && op.mode === before.colorMode
          ? `Sprite is already ${before.colorMode}`
          : args.action === "trim" && fullCanvas
            ? "The art already touches every edge"
            : undefined;
      if (unchanged) return jsonResult({ action: args.action, unchanged, ...summary(before) });
      const after = await gateway.spriteOp(op);
      return jsonResult({
        action: args.action,
        before: { width: before.width, height: before.height, colorMode: before.colorMode },
        ...summary(after),
      });
    },
  );

  const steps = z.number().int().min(1).max(100).default(1).describe("How many steps (default 1).");

  server.registerTool(
    "undo",
    {
      title: "Undo",
      description:
        "Undo the last changes in the active sprite, like Ctrl+Z. Every tool call that edits the sprite " +
        "is one step, so undo after a bad draw instead of repainting by hand.",
      inputSchema: { steps },
    },
    async ({ steps: n }) => {
      await gateway.undo(n);
      return { content: [{ type: "text", text: `Undid ${n} step${n === 1 ? "" : "s"}.` }] };
    },
  );

  server.registerTool(
    "redo",
    {
      title: "Redo",
      description: "Redo changes that undo reverted (like Ctrl+Y). Only works right after undo.",
      inputSchema: { steps },
    },
    async ({ steps: n }) => {
      await gateway.redo(n);
      return { content: [{ type: "text", text: `Redid ${n} step${n === 1 ? "" : "s"}.` }] };
    },
  );

  server.registerTool(
    "save_sprite",
    {
      title: "Save sprite",
      description:
        "Save the active sprite. Without path it saves to its current file (only if it was saved before). " +
        "With path it saves as that file: absolute or ~/..., .aseprite keeps layers/frames/tags " +
        "(.png/.gif flatten, prefer export_sprite for those). Existing files are only replaced with overwrite: true.",
      inputSchema: {
        path: z.string().optional().describe("Absolute path or ~/..., ending in .aseprite, .ase, .png or .gif."),
        copy: z.boolean().default(false).describe("Save a copy; the open document keeps its current file name."),
        overwrite: z.boolean().default(false).describe("Allow replacing an existing file."),
      },
    },
    async ({ path, copy, overwrite }) => {
      const info = await gateway.getSpriteInfo();
      if (path === undefined) {
        if (!hasBeenSaved(info.filename)) {
          throw new Error(
            `"${info.filename}" has never been saved; pass path, e.g. ~/Desktop/${info.filename || "sprite"}.aseprite`,
          );
        }
        return jsonResult({ ok: true, path: await gateway.saveSprite({}) });
      }
      const target = resolveOutputPath(path, {
        extensions: SAVE_EXTENSIONS,
        overwrite,
        currentFile: hasBeenSaved(info.filename) ? info.filename : undefined,
        label: "path",
      });
      return jsonResult({ ok: true, path: await gateway.saveSprite({ path: target, copy }), copy });
    },
  );

  server.registerTool(
    "export_sprite",
    {
      title: "Export sprite",
      description:
        "Write the sprite as an image file for games or sharing; the open document is not changed. Kinds:\n" +
        "- png: one frame (frame, default the active one) as .png\n" +
        "- gif: animated .gif of all frames or one tag\n" +
        "- sheet: sprite sheet .png (sheetType, columns) with optional JSON frame data (dataPath)\n" +
        "- frames: one .png per frame, numbered name1.png, name2.png, ...\n" +
        "Paths must be absolute or ~/...; existing files are only replaced with overwrite: true.",
      inputSchema: {
        path: z.string().describe("Absolute path or ~/..., ending in .png (gif: .gif)."),
        kind: z.enum(["png", "gif", "sheet", "frames"]).optional().describe("Defaults to png/gif from the extension."),
        scale: z.number().int().min(1).max(20).optional().describe("Integer upscale for crisp pixels (png, gif, frames)."),
        frame: z.number().int().min(1).optional().describe("png: 1-based frame to export (default: active frame)."),
        tag: z.string().optional().describe("gif/sheet/frames: export only this tag's frames."),
        sheetType: z
          .enum(["horizontal", "vertical", "rows", "columns", "packed"])
          .optional()
          .describe("sheet layout; default horizontal strip, or rows when columns is given."),
        columns: z.number().int().min(1).optional().describe("sheet: frames per row."),
        dataPath: z.string().optional().describe("sheet: also write Aseprite JSON frame data to this .json path."),
        overwrite: z.boolean().default(false).describe("Allow replacing existing files."),
      },
    },
    async (args) => {
      const info = await gateway.getSpriteInfo();
      const plan = planExport(args, info);
      await gateway.exportSprite(plan.options);
      const scale = plan.options.scale ?? 1;
      return jsonResult({
        ok: true,
        kind: plan.options.kind,
        files: plan.files,
        frames: plan.frameCount,
        frameSize: `${info.width * scale}x${info.height * scale}`,
      });
    },
  );
};
