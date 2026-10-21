import type { RgbaImage } from "../pixel/RgbaImage.js";

export interface DrawScriptRequest {
  code: string;
  width: number;
  height: number;
  /** Existing pixels to start from, so scripts can recolour or shade current art. */
  base?: RgbaImage;
  /** Seed for rand(): the same script draws the same picture. */
  seed?: number;
}

export interface DrawScriptResult {
  image: RgbaImage;
  /** Number of drawing calls the script made; a rough measure of what it did. */
  calls: number;
  elapsedMs: number;
}

/** Runs model-written drawing code. Implementations must isolate it from the host. */
export interface IScriptRunner {
  run(request: DrawScriptRequest): Promise<DrawScriptResult>;
}
