import { decodeRaw, encodeRaw, type PixelTarget } from "../pixel/rawFormat.js";
import type {
  IAsepriteGateway,
  ReadImageRequest,
  SelectionMask,
  WriteImageRequest,
} from "./AsepriteGateway.js";
import type { IAsepriteRpc } from "./AsepriteSocket.js";
import type {
  CreateSpriteOptions,
  ExportOptions,
  FrameOp,
  LayerOp,
  RawImageReply,
  Rect,
  SelectionOp,
  SelectionReply,
  SpriteInfo,
  SpriteOp,
  SpriteRef,
  SpriteSummary,
  TagOp,
} from "./protocol.js";

const FORMAT_BY_MODE = { rgb: "rgba", grayscale: "gray", indexed: "indexed" } as const;

/** Typed Aseprite operations on top of the raw method/params channel. */
export class RpcAsepriteGateway implements IAsepriteGateway {
  constructor(private readonly rpc: IAsepriteRpc) {}

  isConnected(): boolean {
    return this.rpc.isConnected();
  }

  async listSprites(): Promise<SpriteSummary[]> {
    return (await this.rpc.call<{ sprites: SpriteSummary[] }>("list_sprites", {})).sprites;
  }

  async activateSprite(sprite: number): Promise<void> {
    await this.rpc.call("activate_sprite", { sprite });
  }

  getSpriteInfo(ref: SpriteRef = {}): Promise<SpriteInfo> {
    return this.rpc.call("get_sprite_info", ref);
  }

  createSprite(options: CreateSpriteOptions): Promise<SpriteInfo> {
    return this.rpc.call("create_sprite", {
      ...options,
      background: options.background?.replace(/^#/, ""),
    });
  }

  spriteOp(op: SpriteOp, ref: SpriteRef = {}): Promise<SpriteInfo> {
    return this.rpc.call("sprite_op", { ...op, ...ref });
  }

  async undo(steps: number, ref: SpriteRef = {}): Promise<void> {
    await this.rpc.call("undo", { steps, ...ref });
  }

  async redo(steps: number, ref: SpriteRef = {}): Promise<void> {
    await this.rpc.call("redo", { steps, ...ref });
  }

  async saveSprite(options: { path?: string; copy?: boolean }, ref: SpriteRef = {}): Promise<string> {
    return (await this.rpc.call<{ path: string }>("save_sprite", { ...options, ...ref })).path;
  }

  async exportSprite(options: ExportOptions, ref: SpriteRef = {}): Promise<string> {
    return (await this.rpc.call<{ path: string }>("export_sprite", { ...options, ...ref })).path;
  }

  async readImage(request: ReadImageRequest) {
    const reply = await this.rpc.call<RawImageReply>("read_image", request);
    const rect = { x: reply.x, y: reply.y, width: reply.width, height: reply.height };
    const image = decodeRaw(reply.data, rect.width, rect.height, {
      format: reply.format,
      palette: reply.palette,
      transparentIndex: reply.transparentIndex,
    });
    return { rect, image };
  }

  async writeImages(writes: WriteImageRequest[], ref: SpriteRef = {}): Promise<void> {
    if (writes.length === 0) return;
    const target = await this.pixelTarget(ref);
    const payload = writes.map(({ image, ...rest }) => ({
      ...rest,
      width: image.width,
      height: image.height,
      format: target.format,
      data: encodeRaw(image, target),
    }));
    if (payload.length === 1) await this.rpc.call("write_image", { ...payload[0], ...ref });
    else await this.rpc.call("write_images", { writes: payload, ...ref });
  }

  /** The sprite's color mode decides the byte layout Aseprite expects. */
  private async pixelTarget(ref: SpriteRef): Promise<PixelTarget> {
    const info = await this.getSpriteInfo(ref);
    const format = FORMAT_BY_MODE[info.colorMode];
    if (format !== "indexed") return { format };
    const palette = await this.getPalette(ref);
    return {
      format,
      palette: palette.colors.map((c) => c.replace(/^#/, "")),
      transparentIndex: palette.transparentIndex,
    };
  }

  async readSelection(request: Partial<Rect> & SpriteRef): Promise<SelectionMask> {
    const reply = await this.rpc.call<SelectionReply>("read_selection", request);
    if (reply.mask === undefined || reply.width === undefined || reply.height === undefined) {
      return { isEmpty: true, rect: { x: 0, y: 0, width: 0, height: 0 }, mask: new Uint8Array(0) };
    }
    const mask = new Uint8Array(reply.mask.length);
    for (let i = 0; i < reply.mask.length; i++) mask[i] = reply.mask.charCodeAt(i) === 49 ? 1 : 0;
    return {
      isEmpty: reply.isEmpty,
      bounds: reply.bounds,
      rect: { x: reply.x ?? 0, y: reply.y ?? 0, width: reply.width, height: reply.height },
      mask,
    };
  }

  setSelection(op: SelectionOp, rects: number[][], ref: SpriteRef = {}) {
    return this.rpc.call<{ isEmpty: boolean; bounds?: Rect }>("set_selection", { op, rects, ...ref });
  }

  layerOp(op: LayerOp, ref: SpriteRef = {}): Promise<{ layer?: string }> {
    return this.rpc.call("layer_op", { ...op, ...ref });
  }

  frameOp(op: FrameOp, ref: SpriteRef = {}): Promise<{ frames: number }> {
    return this.rpc.call("frame_op", { ...op, ...ref });
  }

  async tagOp(op: TagOp, ref: SpriteRef = {}): Promise<void> {
    await this.rpc.call("tag_op", { ...op, color: "color" in op ? op.color?.replace(/^#/, "") : undefined, ...ref });
  }

  async getPalette(ref: SpriteRef = {}) {
    const reply = await this.rpc.call<{ colors: string[]; transparentIndex: number }>("get_palette", ref);
    return { colors: reply.colors.map((c) => `#${c}`), transparentIndex: reply.transparentIndex };
  }

  async setPalette(colors: string[], ref: SpriteRef = {}): Promise<void> {
    await this.rpc.call("set_palette", { colors: colors.map((c) => c.replace(/^#/, "")), ...ref });
  }
}
