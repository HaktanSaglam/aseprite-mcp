/**
 * Wire types of the bridge ↔ Aseprite protocol. docs/PROTOCOL.md is the contract;
 * keep both in sync.
 */

export type ColorMode = "rgb" | "grayscale" | "indexed";
export type PixelFormat = "rgba" | "gray" | "indexed";
export type AnimationDirection = "forward" | "reverse" | "pingpong" | "pingpong_reverse";

export const BLEND_MODES = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten", "color_dodge", "color_burn",
  "hard_light", "soft_light", "difference", "exclusion", "hue", "saturation", "color",
  "luminosity", "addition", "subtract", "divide",
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Every request may target a sprite by id; omitted means the active sprite. */
export interface SpriteRef {
  sprite?: number;
}

export interface LayerInfo {
  name: string;
  path: string;
  isGroup: boolean;
  isVisible: boolean;
  isEditable: boolean;
  opacity: number;
  blendMode: BlendMode;
  stackIndex: number;
  parent?: string;
}

export interface TagInfo {
  name: string;
  from: number;
  to: number;
  direction: AnimationDirection;
  repeats: number;
}

export interface SpriteInfo {
  id: number;
  filename: string;
  width: number;
  height: number;
  colorMode: ColorMode;
  frames: { index: number; durationMs: number }[];
  layers: LayerInfo[];
  tags: TagInfo[];
  activeFrame: number;
  activeLayer?: string;
  selection?: Rect;
  paletteSize: number;
  transparentIndex: number;
}

export interface SpriteSummary {
  id: number;
  filename: string;
  width: number;
  height: number;
  colorMode: ColorMode;
  frames: number;
  isActive: boolean;
}

export interface CreateSpriteOptions {
  width: number;
  height: number;
  colorMode?: ColorMode;
  frames?: number;
  /** rrggbb(aa); fills the first layer of every frame. */
  background?: string;
  /** Tab title of the new, unsaved sprite (e.g. "Slime (variation 2)"). */
  name?: string;
}

export type SpriteOp =
  | { op: "resize"; width: number; height: number; method?: "nearest" | "bilinear" | "rotsprite" }
  | { op: "canvas"; left?: number; top?: number; right?: number; bottom?: number }
  | ({ op: "crop" } & Rect)
  | { op: "color_mode"; mode: ColorMode }
  | { op: "rotate"; angle: 90 | 180 | 270 }
  | { op: "flip"; direction: FlipDirection };

export type LayerOp =
  | { op: "add"; name: string; group?: string; above?: string; isGroup?: boolean }
  | { op: "delete"; name: string }
  | {
      op: "update";
      name: string;
      newName?: string;
      visible?: boolean;
      opacity?: number;
      blendMode?: BlendMode;
      editable?: boolean;
    }
  | { op: "move"; name: string; above?: string; below?: string; group?: string }
  | { op: "duplicate"; name: string; newName?: string }
  | { op: "merge_down"; name: string }
  | { op: "activate"; name: string };

export type FlipDirection = "horizontal" | "vertical";

export type FrameOp =
  | { op: "add"; after?: number; count?: number; copy?: boolean; durationMs?: number }
  | { op: "delete"; from: number; to?: number }
  | { op: "duration"; frames?: number[]; durationMs: number }
  | { op: "activate"; frame: number }
  /** One layer's cel (default: every writable image layer) from `from` to `to`, optionally mirrored. */
  | { op: "copy_cel"; from: number; to: number; layer?: string; flip?: FlipDirection };

export type TagOp =
  | {
      op: "add";
      name: string;
      from?: number;
      to?: number;
      direction?: AnimationDirection;
      repeats?: number;
      color?: string;
    }
  | {
      op: "update";
      name: string;
      newName?: string;
      from?: number;
      to?: number;
      direction?: AnimationDirection;
      repeats?: number;
      color?: string;
    }
  | { op: "delete"; name: string };

export type SelectionOp = "replace" | "add" | "subtract" | "intersect" | "all" | "none" | "invert";

export interface ExportOptions {
  path: string;
  kind: "png" | "gif" | "sheet" | "frames";
  scale?: number;
  frame?: number;
  tag?: string;
  sheetType?: "horizontal" | "vertical" | "rows" | "columns" | "packed";
  columns?: number;
  dataPath?: string;
}

/** read_image result: raw bytes of the requested rectangle as hex. */
export interface RawImageReply extends Rect {
  format: PixelFormat;
  data: string;
  palette?: string[];
  transparentIndex?: number;
}

export interface RawImageWrite extends Rect {
  frame?: number;
  layer?: string;
  format: PixelFormat;
  data: string;
}

export interface SelectionReply extends Partial<Rect> {
  isEmpty: boolean;
  bounds?: Rect;
  mask?: string;
}
