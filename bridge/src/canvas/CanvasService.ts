import type {
  IPixelGateway,
  ISelectionGateway,
  ISpriteGateway,
  LayerInfo,
  Rect,
  SpriteInfo,
  SpriteRef,
  WriteImageRequest,
} from "../aseprite/AsepriteGateway.js";
import { compose, countChangedPixels, maskFilter, type PaintMode, type PixelFilter } from "../pixel/composite.js";
import { storedPixels, type PixelTarget } from "../pixel/rawFormat.js";
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

/** The user's selection as an edit sees it. */
export interface SelectionArea {
  /** The smallest rectangle around the selected pixels. */
  bounds: Rect;
  /** Canvas coordinates: is this pixel selected? */
  contains: PixelFilter;
}

export interface TransformOptions {
  /**
   * With selectionOnly, pixels outside the selection keep their old value (default).
   * Off for edits that move the selected pixels themselves (flip, rotate, shift): those
   * may land outside the selection and must not be cut off at its old outline.
   */
  clipToSelection?: boolean;
}

/** Turns a whole-layer image into the edited one; `selection` is set with selectionOnly. */
export type LayerEdit = (image: RgbaImage, frame: number, selection?: SelectionArea) => RgbaImage;

export interface TransformResult {
  frames: number[];
  /** Pixels whose stored color changed, over all frames (only where the edit was allowed). */
  changed: number;
  /** Edited pixels the sprite stores in another color than asked (indexed palette, gray). */
  snapped: number;
  /** How the layer stores its pixels; undefined means RGBA. */
  storage?: PixelTarget;
}

type CanvasGateway = IPixelGateway & ISelectionGateway & Pick<ISpriteGateway, "getSpriteInfo">;

/** One tool call's fixed target, so every RPC of the call hits the same sprite, layer and frame. */
interface Pin {
  info: SpriteInfo;
  ref: { sprite: number };
  /** The layer Aseprite would default to right now, or undefined to let it decide. */
  layer?: string;
}

const ORIGIN = { x: 0, y: 0 };

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
 * The layer Aseprite uses when none is named (U.defaultLayer in the extension): the
 * active one, the top image layer inside an active group, else the sprite's top image
 * layer. Returned as a path so that a user clicking another layer or tab halfway
 * through a call can't redirect its write; undefined whenever the bridge can't be sure
 * (duplicate paths, an empty active group), leaving the choice or the error to Aseprite.
 */
export function defaultLayerPath(info: SpriteInfo): string | undefined {
  const layer = info.activeLayer === undefined ? topImageLayer(info.layers) : activeImageLayer(info);
  if (!layer) return undefined;
  return info.layers.filter((l) => l.path === layer.path).length === 1 ? layer.path : undefined;
}

/** info.layers is in Aseprite's stacking order, bottom first. */
function topImageLayer(layers: LayerInfo[]): LayerInfo | undefined {
  return layers.filter((l) => !l.isGroup).at(-1);
}

/** activeLayer is a path (e.g. "Body/Arm"), never a bare name. */
function activeImageLayer(info: SpriteInfo): LayerInfo | undefined {
  const active = info.layers.filter((l) => l.path === info.activeLayer);
  if (active.length !== 1) return undefined;
  if (!active[0].isGroup) return active[0];
  return topImageLayer(info.layers.filter((l) => l.path.startsWith(`${active[0].path}/`)));
}

/**
 * Pixel editing on top of the raw gateway: compositing, selection masks and
 * multi-frame edits, so every tool gets the same semantics and a single undo step.
 */
export class CanvasService {
  constructor(private readonly gateway: CanvasGateway) {}

  async paint(requests: PaintRequest[], options: PaintOptions = {}): Promise<void> {
    const mode = options.mode ?? "over";
    const pin = await this.pin(options.sprite);
    const filter = options.selectionOnly ? (await this.selectionArea(pin.ref))?.contains : undefined;
    // Indexed pixels are read even when replaced, so the untouched ones keep their exact index.
    const readBase = mode === "over" || filter !== undefined || pin.info.colorMode === "indexed";

    const writes: WriteImageRequest[] = [];
    for (const request of requests) {
      const frame = request.frame ?? pin.info.activeFrame;
      const layer = request.layer ?? pin.layer;
      let image = request.image;
      if (readBase) {
        const { image: base } = await this.gateway.readImage({
          x: request.x,
          y: request.y,
          width: image.width,
          height: image.height,
          frame,
          layer,
          missingOk: true,
          ...pin.ref,
        });
        if (mode === "over" || filter) image = compose(base, image, mode, request, filter);
        image = { ...image, source: base.source };
      }
      writes.push({ x: request.x, y: request.y, image, frame, layer });
    }
    await this.gateway.writeImages(writes, pin.ref);
  }

  /**
   * Reads the whole layer for each target frame, lets `edit` return the new pixels and
   * writes them back (respecting the selection) as one undo step. Counts what really
   * changed in the sprite, after indexed/grayscale sprites snapped the colors.
   */
  async transform(target: LayerTarget, edit: LayerEdit, options: TransformOptions = {}): Promise<TransformResult> {
    const pin = await this.pin(target.sprite);
    const frames = resolveFrames(target.frames, pin.info);
    const layer = target.layer ?? pin.layer;
    const selection = target.selectionOnly ? await this.selectionArea(pin.ref) : undefined;
    const clip = options.clipToSelection === false ? undefined : selection;

    const writes: WriteImageRequest[] = [];
    let changed = 0;
    let snapped = 0;
    let storage: PixelTarget | undefined;
    for (const frame of frames) {
      const { image } = await this.gateway.readImage({ frame, layer, ...pin.ref });
      storage ??= image.source?.target;
      const edited = edit(image, frame, selection);
      const requested = clip ? compose(image, edited, "replace", ORIGIN, clip.contains) : edited;
      const stored = asStored(requested, image);
      snapped += countChangedPixels(requested, stored);
      const frameChanged = countChangedPixels(image, stored);
      // Rewriting an unchanged frame would still unlink its cel and add an undo step.
      if (frameChanged === 0) continue;
      changed += frameChanged;
      writes.push({ x: 0, y: 0, image: stored, frame, layer });
    }
    if (writes.length > 0) await this.gateway.writeImages(writes, pin.ref);
    return { frames, changed, snapped, storage };
  }

  async selectionFilter(ref: SpriteRef): Promise<PixelFilter | undefined> {
    return (await this.selectionArea(ref))?.contains;
  }

  /** The selection, or undefined when nothing is selected. */
  async selectionArea(ref: SpriteRef): Promise<SelectionArea | undefined> {
    const selection = await this.gateway.readSelection(ref);
    if (selection.isEmpty) return undefined;
    return { bounds: selection.bounds ?? selection.rect, contains: maskFilter(selection.rect, selection.mask) };
  }

  private async pin(sprite: number | undefined): Promise<Pin> {
    const info = await this.gateway.getSpriteInfo({ sprite });
    return { info, ref: { sprite: info.id }, layer: defaultLayerPath(info) };
  }
}

/** `edited` as the sprite will hold it; pixels left as read keep their exact stored value. */
function asStored(edited: RgbaImage, read: RgbaImage): RgbaImage {
  const source = read.source;
  if (!source || edited.width !== read.width || edited.height !== read.height) return edited;
  return storedPixels({ ...edited, source }, source.target);
}
