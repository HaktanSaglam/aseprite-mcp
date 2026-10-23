import type { RgbaImage } from "../pixel/RgbaImage.js";
import type {
  IAsepriteGateway,
  ISpriteCloser,
  ReadImageRequest,
  SelectionMask,
  WriteImageRequest,
} from "./AsepriteGateway.js";
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
import type { DrawnCel, ISpriteActivityLog } from "./SpriteActivity.js";

/**
 * Reports every change that reaches Aseprite to a SpriteActivity log: each mutating
 * method is one Aseprite transaction, i.e. one undo step (empty ones included), and
 * writes also name the cels they drew. Only successful calls count (a failed one is
 * rolled back), and only calls naming their sprite: the active tab could change between
 * the call and the record, and a step booked on the wrong sprite would make "Undo AI
 * run" take back the user's own work. Model runs and the bridge always name it.
 */
export class TrackingAsepriteGateway implements IAsepriteGateway, ISpriteCloser {
  constructor(
    private readonly inner: IAsepriteGateway & ISpriteCloser,
    private readonly log: ISpriteActivityLog,
  ) {}

  isConnected(): boolean {
    return this.inner.isConnected();
  }

  listSprites(): Promise<SpriteSummary[]> {
    return this.inner.listSprites();
  }

  activateSprite(sprite: number): Promise<void> {
    return this.inner.activateSprite(sprite);
  }

  getSpriteInfo(ref?: SpriteRef): Promise<SpriteInfo> {
    return this.inner.getSpriteInfo(ref);
  }

  // A new sprite starts its own history; nothing of an existing sprite changes.
  createSprite(options: CreateSpriteOptions): Promise<SpriteInfo> {
    return this.inner.createSprite(options);
  }

  closeSprite(sprite: number, options?: { onlyIfEmpty?: boolean }): Promise<boolean> {
    return this.inner.closeSprite(sprite, options);
  }

  async spriteOp(op: SpriteOp, ref?: SpriteRef): Promise<SpriteInfo> {
    const info = await this.inner.spriteOp(op, ref);
    this.step(ref);
    return info;
  }

  async undo(steps: number, ref?: SpriteRef): Promise<void> {
    await this.inner.undo(steps, ref);
    if (ref?.sprite !== undefined) this.log.recordUndo(ref.sprite, steps);
  }

  async redo(steps: number, ref?: SpriteRef): Promise<void> {
    await this.inner.redo(steps, ref);
    if (ref?.sprite !== undefined) this.log.recordRedo(ref.sprite, steps);
  }

  // Saving and exporting write files, not the document's history.
  saveSprite(options: { path?: string; copy?: boolean }, ref?: SpriteRef): Promise<string> {
    return this.inner.saveSprite(options, ref);
  }

  exportSprite(options: ExportOptions, ref?: SpriteRef): Promise<string> {
    return this.inner.exportSprite(options, ref);
  }

  readImage(request: ReadImageRequest): Promise<{ rect: Rect; image: RgbaImage }> {
    return this.inner.readImage(request);
  }

  async writeImages(writes: WriteImageRequest[], ref?: SpriteRef): Promise<void> {
    await this.inner.writeImages(writes, ref);
    // An empty list never reaches Aseprite.
    if (writes.length > 0) this.step(ref, writes.map(({ layer, frame }) => ({ layer, frame })));
  }

  readSelection(request: Partial<Rect> & SpriteRef): Promise<SelectionMask> {
    return this.inner.readSelection(request);
  }

  async setSelection(op: SelectionOp, rects: number[][], ref?: SpriteRef): Promise<{ isEmpty: boolean; bounds?: Rect }> {
    const result = await this.inner.setSelection(op, rects, ref);
    this.step(ref);
    return result;
  }

  // Activating changes what the user sees, not the document: no undo step.
  async layerOp(op: LayerOp, ref?: SpriteRef): Promise<{ layer?: string }> {
    const result = await this.inner.layerOp(op, ref);
    if (op.op !== "activate") this.step(ref);
    return result;
  }

  async frameOp(op: FrameOp, ref?: SpriteRef): Promise<{ frames: number }> {
    const result = await this.inner.frameOp(op, ref);
    if (op.op === "copy_cel") {
      this.step(ref, [op.layer === undefined ? { everyLayer: true, frame: op.to } : { layer: op.layer, frame: op.to }]);
    } else if (op.op !== "activate") {
      this.step(ref);
    }
    return result;
  }

  async tagOp(op: TagOp, ref?: SpriteRef): Promise<void> {
    await this.inner.tagOp(op, ref);
    this.step(ref);
  }

  getPalette(ref?: SpriteRef): Promise<{ colors: string[]; transparentIndex: number }> {
    return this.inner.getPalette(ref);
  }

  async setPalette(colors: string[], ref?: SpriteRef): Promise<void> {
    await this.inner.setPalette(colors, ref);
    this.step(ref);
  }

  private step(ref: SpriteRef | undefined, cels?: DrawnCel[]): void {
    if (ref?.sprite !== undefined) this.log.recordStep(ref.sprite, cels);
  }
}
