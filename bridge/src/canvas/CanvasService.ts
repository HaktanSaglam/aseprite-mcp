import type {
  IPixelGateway,
  ISelectionGateway,
  ISpriteGateway,
  SpriteInfo,
  SpriteRef,
} from "../aseprite/AsepriteGateway.js";
import { compose, maskFilter, type PaintMode, type PixelFilter } from "../pixel/composite.js";
import type { RgbaImage } from "../pixel/RgbaImage.js";

export type FrameSelector = "current" | "all" | number[];

export interface PaintRequest {
  x: number;
  y: number;
  image: RgbaImage;
  frame?: number;
  layer?: string;
}

export interface PaintOptions extends SpriteRef {
  /** "over" (default) keeps existing pixels under transparent ones; "replace" erases them. */
  mode?: PaintMode;
  /** Only pixels inside the user's selection change (ignored when nothing is selected). */
  selectionOnly?: boolean;
}

/** Which pixels an edit applies to: a layer, some frames, optionally the selection. */
export interface LayerTarget extends SpriteRef {
  layer?: string;
  frames?: FrameSelector;
  selectionOnly?: boolean;
}

type CanvasGateway = IPixelGateway & ISelectionGateway & Pick<ISpriteGateway, "getSpriteInfo">;

export function resolveFrames(selector: FrameSelector | undefined, info: SpriteInfo): number[] {
  if (selector === undefined || selector === "current") return [info.activeFrame];
  if (selector === "all") return info.frames.map((f) => f.index);
  const frames = [...new Set(selector)];
  for (const f of frames) {
    if (!Number.isInteger(f) || f < 1 || f > info.frames.length) {
      throw new Error(`Frame ${f} out of range (sprite has ${info.frames.length} frames)`);
    }
  }
  return frames;
}

/**
 * Pixel editing on top of the raw gateway: compositing, selection masks and
 * multi-frame edits, so every tool gets the same semantics and a single undo step.
 */
export class CanvasService {
  constructor(private readonly gateway: CanvasGateway) {}

  async paint(requests: PaintRequest[], options: PaintOptions = {}): Promise<void> {
    const mode = options.mode ?? "over";
    const ref: SpriteRef = { sprite: options.sprite };
    const filter = options.selectionOnly ? await this.selectionFilter(ref) : undefined;

    const writes = [];
    for (const request of requests) {
      let image = request.image;
      if (mode === "over" || filter) {
        const base = await this.gateway.readImage({
          x: request.x,
          y: request.y,
          width: image.width,
          height: image.height,
          frame: request.frame,
          layer: request.layer,
          missingOk: true,
          ...ref,
        });
        image = compose(base.image, image, mode, request, filter);
      }
      writes.push({ ...request, image });
    }
    await this.gateway.writeImages(writes, ref);
  }

  /**
   * Reads the whole layer for each target frame, lets `edit` return the new pixels and
   * writes them back (respecting the selection) as one undo step.
   */
  async transform(
    target: LayerTarget,
    edit: (image: RgbaImage, frame: number) => RgbaImage,
  ): Promise<{ frames: number[] }> {
    const ref: SpriteRef = { sprite: target.sprite };
    const info = await this.gateway.getSpriteInfo(ref);
    const frames = resolveFrames(target.frames, info);
    const filter = target.selectionOnly ? await this.selectionFilter(ref) : undefined;

    const writes = [];
    for (const frame of frames) {
      const { image } = await this.gateway.readImage({ frame, layer: target.layer, ...ref });
      const edited = edit(image, frame);
      const result = filter ? compose(image, edited, "replace", { x: 0, y: 0 }, filter) : edited;
      writes.push({ x: 0, y: 0, image: result, frame, layer: target.layer });
    }
    await this.gateway.writeImages(writes, ref);
    return { frames };
  }

  async selectionFilter(ref: SpriteRef): Promise<PixelFilter | undefined> {
    const selection = await this.gateway.readSelection(ref);
    if (selection.isEmpty) return undefined;
    return maskFilter(selection.rect, selection.mask);
  }
}
