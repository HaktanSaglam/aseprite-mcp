import type { IAnimationGateway, IPixelGateway, ISpriteGateway } from "../aseprite/AsepriteGateway.js";
import type { PaintOptions, PaintRequest } from "../canvas/CanvasService.js";
import { compose } from "../pixel/composite.js";
import { filmstrip } from "../pixel/filmstrip.js";
import { createRgbaImage, type RgbaImage } from "../pixel/RgbaImage.js";
import type { IScriptRunner, ScriptFrame } from "./ScriptRunner.js";

/** What the script starts from: nothing, each frame's own pixels, or one frame copied to all. */
export type ScriptBase = "empty" | "current" | number;

export interface DrawScriptJob {
  code: string;
  x: number;
  y: number;
  /** Defaults to the canvas size minus x/y. */
  width?: number;
  height?: number;
  /** 1-based target frames; frames past the end are created. Omitted → the active frame. */
  frames?: number[];
  layer?: string;
  base: ScriptBase;
  seed: number;
  selectionOnly: boolean;
  /** Sets the duration of every target frame. */
  frameMs?: number;
  /** Return the composited result (a filmstrip for several frames). */
  preview: boolean;
}

export interface DrawScriptOutcome {
  width: number;
  height: number;
  frames: number[];
  created: number[];
  calls: number;
  elapsedMs: number;
  logs: string[];
  preview?: RgbaImage;
}

export const MAX_SIDE = 512;
export const MAX_FRAMES_PER_CALL = 32;
// Bounds the payload of the single write (and memory): e.g. 16 frames of 512x512.
const MAX_TOTAL_PIXELS = 512 * 512 * 16;
export const FILMSTRIP_COLUMNS = 4;

type Gateway = Pick<ISpriteGateway, "getSpriteInfo"> & Pick<IPixelGateway, "readImage"> & Pick<IAnimationGateway, "frameOp">;

/** The one CanvasService capability this service needs. */
export interface IPainter {
  paint(requests: PaintRequest[], options?: PaintOptions): Promise<void>;
}

/** Copies `image` into a transparent canvas-sized image at (x, y), clipping what falls outside. */
function placeOnCanvas(image: RgbaImage, x: number, y: number, width: number, height: number): RgbaImage {
  const canvas = createRgbaImage(width, height);
  for (let row = 0; row < image.height; row++) {
    const cy = y + row;
    if (cy < 0 || cy >= height) continue;
    const from = Math.max(0, -x);
    const to = Math.min(image.width, width - x);
    if (from >= to) continue;
    canvas.data.set(
      image.data.subarray((row * image.width + from) * 4, (row * image.width + to) * 4),
      (cy * width + x + from) * 4,
    );
  }
  return canvas;
}

/**
 * draw_script's business logic: resolves the region and frames, runs the script once per
 * frame and writes every frame in a single undo step. Frames are only created after the
 * script succeeded, so a broken script leaves the sprite untouched.
 */
export class DrawScriptService {
  constructor(
    private readonly gateway: Gateway,
    private readonly canvas: IPainter,
    private readonly runner: IScriptRunner,
  ) {}

  async draw(job: DrawScriptJob): Promise<DrawScriptOutcome> {
    const info = await this.gateway.getSpriteInfo();
    const frameCount = info.frames.length;
    const width = job.width ?? Math.min(MAX_SIDE, info.width - job.x);
    const height = job.height ?? Math.min(MAX_SIDE, info.height - job.y);
    if (width < 1 || height < 1 || job.x >= info.width || job.y >= info.height) {
      throw new Error(
        `Region at (${job.x}, ${job.y}) is outside the ${info.width}x${info.height} canvas; use x/y inside it.`,
      );
    }

    const frames = [...new Set(job.frames ?? [info.activeFrame])];
    for (const f of frames) {
      if (!Number.isInteger(f) || f < 1) throw new Error(`Frame ${f} is invalid: frames are 1-based integers.`);
    }
    if (frames.length > MAX_FRAMES_PER_CALL) {
      throw new Error(`At most ${MAX_FRAMES_PER_CALL} frames per draw_script call; split the animation into several calls.`);
    }
    const lastFrame = Math.max(...frames);
    if (lastFrame - frameCount > MAX_FRAMES_PER_CALL) {
      throw new Error(
        `Frame ${lastFrame} would create ${lastFrame - frameCount} frames (sprite has ${frameCount}); ` +
          `target frames up to ${frameCount + MAX_FRAMES_PER_CALL}.`,
      );
    }
    if (width * height * frames.length > MAX_TOTAL_PIXELS) {
      throw new Error(
        `${frames.length} frames of ${width}x${height} is too much for one call; draw fewer frames or a smaller region.`,
      );
    }
    if (typeof job.base === "number" && (!Number.isInteger(job.base) || job.base < 1 || job.base > frameCount)) {
      throw new Error(`base frame ${job.base} does not exist (sprite has ${frameCount} frames).`);
    }

    const region = { x: job.x, y: job.y, width, height };
    const readRegion = async (frame: number) =>
      (await this.gateway.readImage({ ...region, frame, layer: job.layer, missingOk: true })).image;

    const sharedBase = typeof job.base === "number" ? await readRegion(job.base) : undefined;
    const scriptFrames: ScriptFrame[] = [];
    for (const frame of frames) {
      const base =
        job.base === "current" && frame <= frameCount ? await readRegion(frame) : sharedBase;
      scriptFrames.push({ frame, base });
    }

    const result = await this.runner.run({ code: job.code, width, height, seed: job.seed, frames: scriptFrames });

    const created = frames.filter((f) => f > frameCount);
    if (lastFrame > frameCount) {
      // copy: other layers (backgrounds) continue into the new frames; the target layer
      // is cleared below so the copy never ghosts under the new drawing.
      await this.gateway.frameOp({ op: "add", after: frameCount, count: lastFrame - frameCount, copy: true });
    }

    const requests: PaintRequest[] = [];
    for (let k = 0; k < frames.length; k++) {
      const frame = frames[k];
      const out = result.images[k];
      if (frame > frameCount) {
        requests.push({ x: 0, y: 0, frame, layer: job.layer, image: placeOnCanvas(out, job.x, job.y, info.width, info.height) });
      } else if (job.base === "empty") {
        // An empty base must not wipe the art around the script's shapes.
        requests.push({ ...region, frame, layer: job.layer, image: compose(await readRegion(frame), out, "over") });
      } else {
        // Starting from existing pixels makes the script authoritative: transparent erases.
        requests.push({ ...region, frame, layer: job.layer, image: out });
      }
    }
    await this.canvas.paint(requests, { mode: "replace", selectionOnly: job.selectionOnly });

    if (job.frameMs !== undefined) {
      await this.gateway.frameOp({ op: "duration", frames, durationMs: job.frameMs });
    }

    let preview: RgbaImage | undefined;
    if (job.preview) {
      const views = [];
      for (const frame of frames) views.push((await this.gateway.readImage({ frame, flattened: true })).image);
      preview = views.length === 1 ? views[0] : filmstrip(views, FILMSTRIP_COLUMNS);
    }

    return {
      width,
      height,
      frames,
      created,
      calls: result.calls,
      elapsedMs: result.elapsedMs,
      logs: result.logs,
      preview,
    };
  }
}
