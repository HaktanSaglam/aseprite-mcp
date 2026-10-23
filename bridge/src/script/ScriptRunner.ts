import type { RgbaImage } from "../pixel/RgbaImage.js";

export interface ScriptFrame {
  /** The script's F global: the 1-based Aseprite frame number being drawn. */
  frame: number;
  /** Pixels this frame starts from (to recolour, shade or animate existing art). */
  base?: RgbaImage;
}

export interface DrawScriptRequest {
  code: string;
  width: number;
  height: number;
  /** The script runs once per entry, in order. Omitted → one run with F = 1 starting from `base`. */
  frames?: ScriptFrame[];
  /** Single-frame shorthand for `frames: [{ frame: 1, base }]`. */
  base?: RgbaImage;
  /** Seed for rand() and noise(): the same script draws the same picture. */
  seed?: number;
}

export interface DrawScriptResult {
  /** One image per requested frame, in request order. */
  images: RgbaImage[];
  /** images[0], for single-frame callers. */
  image: RgbaImage;
  /** Number of host calls the script made; a rough measure of what it did. */
  calls: number;
  elapsedMs: number;
  /** console.log output (capped), so the model can debug its own script. */
  logs: string[];
}

/** A script failed; the message is written for the model that has to fix the script. */
export class ScriptError extends Error {
  constructor(
    message: string,
    readonly line?: number,
    readonly frame?: number,
  ) {
    super(message);
    this.name = "ScriptError";
  }
}

/** Runs model-written drawing code. Implementations must isolate it from the host. */
export interface IScriptRunner {
  run(request: DrawScriptRequest): Promise<DrawScriptResult>;
}
