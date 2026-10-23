import type { RgbaImage } from "../pixel/RgbaImage.js";
import type {
  IAsepriteGateway,
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

/**
 * Binds every call to one sprite, so a model run keeps drawing into ITS sprite while
 * the user switches tabs, and parallel runs (variations, batches) never touch each
 * other's canvas. Tools stay unaware: they call the gateway without a sprite and the
 * decorator fills it in.
 */
export class ScopedAsepriteGateway implements IAsepriteGateway {
  constructor(
    private readonly inner: IAsepriteGateway,
    readonly spriteId: number,
  ) {}

  isConnected(): boolean {
    return this.inner.isConnected();
  }

  // Methods are async so a refusal is a rejected promise, never a synchronous throw.

  // Reading the list is harmless and lets the model answer "which tabs are open?".
  async listSprites(): Promise<SpriteSummary[]> {
    return this.inner.listSprites();
  }

  async activateSprite(sprite: number): Promise<void> {
    // Already bound to it: switching the user's tab would only steal their focus.
    if (sprite === this.spriteId) return;
    throw this.refusal(`switch to sprite #${sprite}`);
  }

  async getSpriteInfo(ref?: SpriteRef): Promise<SpriteInfo> {
    return this.inner.getSpriteInfo(this.scope(ref));
  }

  async createSprite(_options: CreateSpriteOptions): Promise<SpriteInfo> {
    throw this.refusal("create new sprites");
  }

  async spriteOp(op: SpriteOp, ref?: SpriteRef): Promise<SpriteInfo> {
    return this.inner.spriteOp(op, this.scope(ref));
  }

  async undo(steps: number, ref?: SpriteRef): Promise<void> {
    return this.inner.undo(steps, this.scope(ref));
  }

  async redo(steps: number, ref?: SpriteRef): Promise<void> {
    return this.inner.redo(steps, this.scope(ref));
  }

  async saveSprite(options: { path?: string; copy?: boolean }, ref?: SpriteRef): Promise<string> {
    return this.inner.saveSprite(options, this.scope(ref));
  }

  async exportSprite(options: ExportOptions, ref?: SpriteRef): Promise<string> {
    return this.inner.exportSprite(options, this.scope(ref));
  }

  async readImage(request: ReadImageRequest): Promise<{ rect: Rect; image: RgbaImage }> {
    return this.inner.readImage({ ...request, ...this.scope(request) });
  }

  async writeImages(writes: WriteImageRequest[], ref?: SpriteRef): Promise<void> {
    return this.inner.writeImages(writes, this.scope(ref));
  }

  async readSelection(request: Partial<Rect> & SpriteRef): Promise<SelectionMask> {
    return this.inner.readSelection({ ...request, ...this.scope(request) });
  }

  async setSelection(op: SelectionOp, rects: number[][], ref?: SpriteRef): Promise<{ isEmpty: boolean; bounds?: Rect }> {
    return this.inner.setSelection(op, rects, this.scope(ref));
  }

  async layerOp(op: LayerOp, ref?: SpriteRef): Promise<{ layer?: string }> {
    const scope = this.scope(ref);
    if (op.op === "activate") await this.requireShownToUser(`activate layer "${op.name}"`);
    return this.inner.layerOp(op, scope);
  }

  async frameOp(op: FrameOp, ref?: SpriteRef): Promise<{ frames: number }> {
    const scope = this.scope(ref);
    if (op.op === "activate") await this.requireShownToUser(`activate frame ${op.frame}`);
    return this.inner.frameOp(op, scope);
  }

  async tagOp(op: TagOp, ref?: SpriteRef): Promise<void> {
    return this.inner.tagOp(op, this.scope(ref));
  }

  async getPalette(ref?: SpriteRef): Promise<{ colors: string[]; transparentIndex: number }> {
    return this.inner.getPalette(this.scope(ref));
  }

  async setPalette(colors: string[], ref?: SpriteRef): Promise<void> {
    return this.inner.setPalette(colors, this.scope(ref));
  }

  private scope(ref: SpriteRef = {}): { sprite: number } {
    if (ref.sprite !== undefined && ref.sprite !== this.spriteId) {
      throw this.refusal(`edit sprite #${ref.sprite}`);
    }
    return { sprite: this.spriteId };
  }

  /**
   * Activating a frame or layer makes Aseprite show this sprite, so on a background tab
   * it would pull the user away from the tab they are working in. On the tab they are
   * looking at it only changes what they see there, which is what the model asked for.
   */
  private async requireShownToUser(what: string): Promise<void> {
    const sprites = await this.inner.listSprites();
    if (sprites.some((s) => s.id === this.spriteId && s.isActive)) return;
    throw new Error(
      `This job draws into sprite #${this.spriteId}, which is not the tab the user is looking at, so it ` +
        `cannot ${what}: that would switch the user's tab. Activating is not needed: drawing and view ` +
        "tools take frame and layer arguments, effect tools take frames and layer, so keep working with those.",
    );
  }

  // The message is read by the model, so it says what to do instead.
  private refusal(what: string): Error {
    return new Error(
      `This job draws into its own sprite (#${this.spriteId}) and cannot ${what}. ` +
        "Keep working on this sprite: every tool already targets it (use edit_sprite to resize " +
        "or extend its canvas). If the user wants another sprite, tell them to start a new " +
        "Generate request with a new sprite.",
    );
  }
}
