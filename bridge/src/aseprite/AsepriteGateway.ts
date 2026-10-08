import type { RgbaImage } from "../pixel/RgbaImage.js";

export type ColorMode = "rgb" | "grayscale" | "indexed";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpriteInfo {
  filename: string;
  width: number;
  height: number;
  colorMode: ColorMode;
  frames: { index: number; durationMs: number }[];
  layers: { name: string; path: string; isGroup: boolean; isVisible: boolean }[];
  activeFrame: number;
  activeLayer?: string;
  selection?: Rect;
}

export interface ReadRegionRequest extends Partial<Rect> {
  /** 1-based, like the Aseprite UI. Defaults to the active frame. */
  frame?: number;
  /** Layer name or group path ("Group/Layer"). Defaults to the active layer. */
  layer?: string;
  /** Read the composited, visible result instead of a single layer. */
  flattened?: boolean;
}

export interface WriteRegionRequest {
  x: number;
  y: number;
  image: RgbaImage;
  frame?: number;
  /** Created if it doesn't exist. Defaults to the active layer. */
  layer?: string;
  /** Alpha-0 pixels erase existing content instead of being skipped. */
  eraseTransparent?: boolean;
  /** Only pixels inside the current selection are changed. */
  selectionOnly?: boolean;
}

/** Everything the MCP tools need from Aseprite, independent of how we talk to it. */
export interface IAsepriteGateway {
  isConnected(): boolean;
  getSpriteInfo(): Promise<SpriteInfo>;
  createSprite(options: { width: number; height: number; colorMode?: ColorMode }): Promise<SpriteInfo>;
  readRegion(request: ReadRegionRequest): Promise<{ rect: Rect; image: RgbaImage }>;
  writeRegion(request: WriteRegionRequest): Promise<void>;
  /** Colors as #rrggbbaa, in palette index order. */
  getPalette(): Promise<string[]>;
}
