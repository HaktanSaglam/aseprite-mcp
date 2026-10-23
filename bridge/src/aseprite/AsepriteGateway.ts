import type { RgbaImage } from "../pixel/RgbaImage.js";
import type {
  CreateSpriteOptions,
  ExportOptions,
  FrameOp,
  LayerOp,
  Rect,
  SelectionOp,
  SpriteInfo,
  SpriteOp,
  SpriteRef,
  SpriteSummary,
  TagOp,
} from "./protocol.js";

export type * from "./protocol.js";

export interface ReadImageRequest extends Partial<Rect>, SpriteRef {
  /** 1-based, like the Aseprite UI. Defaults to the active frame. */
  frame?: number;
  /** Layer name or group path ("Group/Layer"). Defaults to the active layer. */
  layer?: string;
  /** The composited, visible result instead of a single layer. */
  flattened?: boolean;
  /** Return transparent pixels instead of failing when the layer doesn't exist yet. */
  missingOk?: boolean;
}

export interface WriteImageRequest {
  x: number;
  y: number;
  image: RgbaImage;
  frame?: number;
  /** Created if it doesn't exist. Defaults to the active layer. */
  layer?: string;
}

export interface SelectionMask {
  isEmpty: boolean;
  bounds?: Rect;
  /** The rectangle `mask` covers. */
  rect: Rect;
  /** One byte per pixel of `rect`: 1 = selected. */
  mask: Uint8Array;
}

// Narrow interfaces so each tool/service depends only on what it uses.

export interface ISpriteGateway {
  isConnected(): boolean;
  listSprites(): Promise<SpriteSummary[]>;
  activateSprite(sprite: number): Promise<void>;
  getSpriteInfo(ref?: SpriteRef): Promise<SpriteInfo>;
  createSprite(options: CreateSpriteOptions): Promise<SpriteInfo>;
  spriteOp(op: SpriteOp, ref?: SpriteRef): Promise<SpriteInfo>;
  undo(steps: number, ref?: SpriteRef): Promise<void>;
  redo(steps: number, ref?: SpriteRef): Promise<void>;
  saveSprite(options: { path?: string; copy?: boolean }, ref?: SpriteRef): Promise<string>;
  exportSprite(options: ExportOptions, ref?: SpriteRef): Promise<string>;
}

export interface IPixelGateway {
  /** Always RGBA, whatever the sprite's color mode. */
  readImage(request: ReadImageRequest): Promise<{ rect: Rect; image: RgbaImage }>;
  /**
   * Replaces each rectangle (transparent pixels included) and converts RGBA to the
   * sprite's color mode. All writes form one undo step.
   */
  writeImages(writes: WriteImageRequest[], ref?: SpriteRef): Promise<void>;
}

export interface ISelectionGateway {
  /** Mask over `rect` (defaults to the selection bounds). */
  readSelection(request: Partial<Rect> & SpriteRef): Promise<SelectionMask>;
  /** `rects` are [x, y, w, h] runs; ignored by all/none/invert. */
  setSelection(op: SelectionOp, rects: number[][], ref?: SpriteRef): Promise<{ isEmpty: boolean; bounds?: Rect }>;
}

export interface ILayerGateway {
  layerOp(op: LayerOp, ref?: SpriteRef): Promise<{ layer?: string }>;
}

export interface IAnimationGateway {
  frameOp(op: FrameOp, ref?: SpriteRef): Promise<{ frames: number }>;
  tagOp(op: TagOp, ref?: SpriteRef): Promise<void>;
}

export interface IPaletteGateway {
  /** Colors as #rrggbbaa in index order. */
  getPalette(ref?: SpriteRef): Promise<{ colors: string[]; transparentIndex: number }>;
  setPalette(colors: string[], ref?: SpriteRef): Promise<void>;
}

/**
 * Cleaning up after a generation that failed or was stopped. Only the bridge's chat
 * services close sprites; no MCP tool can, so it is not part of IAsepriteGateway.
 */
export interface ISpriteCloser {
  /** Closes without asking to save; `onlyIfEmpty` keeps a sprite with any pixel. Resolves to whether it closed. */
  closeSprite(sprite: number, options?: { onlyIfEmpty?: boolean }): Promise<boolean>;
}

/** Everything the MCP tools need from Aseprite, independent of how we talk to it. */
export interface IAsepriteGateway
  extends ISpriteGateway,
    IPixelGateway,
    ISelectionGateway,
    ILayerGateway,
    IAnimationGateway,
    IPaletteGateway {}
