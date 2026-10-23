import type { IAsepriteRpc } from "../../src/aseprite/AsepriteSocket.js";
import type { ColorMode, PixelFormat } from "../../src/aseprite/protocol.js";

/**
 * The Lua side at the wire level: cels are canvas-sized raw byte buffers in the sprite's
 * color mode, exactly what read_image/write_image move. Pair it with the real
 * RpcAsepriteGateway to test what really lands in an indexed sprite (palette indexes),
 * and with `beforeCall` to have the "user" switch tabs, layers or frames mid-tool.
 */
export interface RawSprite {
  id: number;
  width: number;
  height: number;
  colorMode: ColorMode;
  /** rrggbbaa per index. */
  palette: string[];
  transparentIndex: number;
  /** Bottom to top. */
  layers: string[];
  activeLayer: string;
  activeFrame: number;
  frames: number;
  /** `${layer}#${frame}` → canvas-sized raw bytes. */
  cels: Map<string, Buffer>;
  /** Canvas-sized 0/1, or null when nothing is selected. */
  selection: Uint8Array | null;
}

const BYTES_PER_PIXEL = { rgb: 4, grayscale: 2, indexed: 1 } as const;
const FORMAT: Record<ColorMode, PixelFormat> = { rgb: "rgba", grayscale: "gray", indexed: "indexed" };

export class RawRpcFake implements IAsepriteRpc {
  readonly sprites: RawSprite[] = [];
  /** Index into `sprites` of the active tab. */
  active = 0;
  readonly log: { method: string; params: Record<string, unknown> }[] = [];
  /** Runs before each call with the 1-based call number, e.g. to switch tabs mid-tool. */
  beforeCall?: (method: string, n: number) => void;
  /** write_image(s) and set_palette calls: each is one Aseprite transaction (undo step). */
  transactions = 0;

  isConnected(): boolean {
    return true;
  }

  add(sprite: Partial<RawSprite> & { width: number; height: number }): RawSprite {
    const s: RawSprite = {
      id: this.sprites.length + 1,
      colorMode: "indexed",
      palette: ["00000000", "000000ff", "ffffffff", "ff0000ff"],
      transparentIndex: 0,
      layers: ["Layer 1"],
      activeLayer: sprite.layers?.at(-1) ?? "Layer 1",
      activeFrame: 1,
      frames: 1,
      cels: new Map(),
      selection: null,
      ...sprite,
    };
    this.sprites.push(s);
    return s;
  }

  /** Test helper: set a layer frame's raw bytes (indexes for indexed sprites). */
  setCel(s: RawSprite, bytes: number[], layer = s.layers[0], frame = 1): void {
    this.cel(s, layer, frame).set(bytes);
  }

  cel(s: RawSprite, layer: string, frame: number): Buffer {
    const key = `${layer}#${frame}`;
    let cel = s.cels.get(key);
    if (!cel) {
      cel = Buffer.alloc(s.width * s.height * BYTES_PER_PIXEL[s.colorMode]);
      if (s.colorMode === "indexed") cel.fill(s.transparentIndex);
      s.cels.set(key, cel);
    }
    return cel;
  }

  calls(method: string): Record<string, unknown>[] {
    return this.log.filter((l) => l.method === method).map((l) => l.params);
  }

  async call<T>(method: string, params: object): Promise<T> {
    const p = JSON.parse(JSON.stringify(params)) as Record<string, any>;
    this.log.push({ method, params: p });
    this.beforeCall?.(method, this.log.length);
    const s = this.sprite(p);
    switch (method) {
      case "get_sprite_info":
        return this.info(s) as T;
      case "get_palette":
        return { colors: [...s.palette], transparentIndex: s.transparentIndex } as T;
      case "set_palette":
        this.transactions++;
        s.palette = (p.colors as string[]).map((c) => (c.length === 6 ? `${c}ff` : c));
        return { ok: true } as T;
      case "read_selection":
        return this.readSelection(s) as T;
      case "read_image":
        return this.readImage(s, p) as T;
      case "write_image":
      case "write_images":
        this.transactions++;
        for (const w of method === "write_image" ? [p] : p.writes) this.write(s, w);
        return { ok: true } as T;
    }
    throw new Error(`RawRpcFake: unsupported method ${method}`);
  }

  private sprite(p: Record<string, unknown>): RawSprite {
    if (p.sprite === undefined) return this.sprites[this.active];
    const s = this.sprites.find((x) => x.id === p.sprite);
    if (!s) throw new Error(`Sprite ${p.sprite} is not open anymore`);
    return s;
  }

  private isActive(s: RawSprite): boolean {
    return this.sprites[this.active] === s;
  }

  // Like U.defaultLayer / U.frameNumber: the active layer/frame only count on the active tab.
  private layerOf(s: RawSprite, layer: unknown): string {
    if (typeof layer === "string") return layer;
    return this.isActive(s) ? s.activeLayer : s.layers[s.layers.length - 1];
  }

  private frameOf(s: RawSprite, frame: unknown): number {
    if (typeof frame === "number") return frame;
    return this.isActive(s) ? s.activeFrame : 1;
  }

  private info(s: RawSprite) {
    return {
      id: s.id,
      filename: `Sprite-${s.id}`,
      width: s.width,
      height: s.height,
      colorMode: s.colorMode,
      frames: Array.from({ length: s.frames }, (_, i) => ({ index: i + 1, durationMs: 100 })),
      layers: s.layers.map((name, i) => ({
        name,
        path: name,
        isGroup: false,
        isVisible: true,
        isEditable: true,
        opacity: 255,
        blendMode: "normal",
        stackIndex: i + 1,
      })),
      tags: [],
      activeFrame: this.frameOf(s, undefined),
      ...(this.isActive(s) ? { activeLayer: s.activeLayer } : {}),
      paletteSize: s.palette.length,
      transparentIndex: s.transparentIndex,
    };
  }

  private readSelection(s: RawSprite) {
    if (!s.selection || !s.selection.includes(1)) return { isEmpty: true };
    let x0 = s.width;
    let y0 = s.height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < s.height; y++) {
      for (let x = 0; x < s.width; x++) {
        if (!s.selection[y * s.width + x]) continue;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
    const rect = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
    let mask = "";
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) mask += s.selection[y * s.width + x] ? "1" : "0";
    }
    return { isEmpty: false, bounds: rect, ...rect, mask };
  }

  private readImage(s: RawSprite, p: Record<string, any>) {
    const bpp = BYTES_PER_PIXEL[s.colorMode];
    const x = p.x ?? 0;
    const y = p.y ?? 0;
    const width = p.width ?? s.width;
    const height = p.height ?? s.height;
    const layer = this.layerOf(s, p.layer);
    if (!s.layers.includes(layer) && !p.missingOk) throw new Error(`Layer not found: ${layer}`);
    const src = this.cel(s, layer, this.frameOf(s, p.frame));
    const out = Buffer.alloc(width * height * bpp);
    if (s.colorMode === "indexed") out.fill(s.transparentIndex);
    for (let yy = 0; yy < height; yy++) {
      for (let xx = 0; xx < width; xx++) {
        const cx = x + xx;
        const cy = y + yy;
        if (cx < 0 || cy < 0 || cx >= s.width || cy >= s.height) continue;
        src.copy(out, (yy * width + xx) * bpp, (cy * s.width + cx) * bpp, (cy * s.width + cx + 1) * bpp);
      }
    }
    const reply: Record<string, unknown> = { x, y, width, height, format: FORMAT[s.colorMode], data: out.toString("hex") };
    if (s.colorMode === "indexed") {
      reply.palette = [...s.palette];
      reply.transparentIndex = s.transparentIndex;
    }
    return reply;
  }

  private write(s: RawSprite, w: Record<string, any>): void {
    if (w.format !== FORMAT[s.colorMode]) throw new Error(`Pixel format ${w.format} does not match the sprite`);
    const bpp = BYTES_PER_PIXEL[s.colorMode];
    const layer = this.layerOf(s, w.layer);
    if (!s.layers.includes(layer)) s.layers.push(layer);
    const dst = this.cel(s, layer, this.frameOf(s, w.frame));
    const data = Buffer.from(w.data, "hex");
    for (let yy = 0; yy < w.height; yy++) {
      for (let xx = 0; xx < w.width; xx++) {
        const cx = w.x + xx;
        const cy = w.y + yy;
        if (cx < 0 || cy < 0 || cx >= s.width || cy >= s.height) continue;
        data.copy(dst, (cy * s.width + cx) * bpp, (yy * w.width + xx) * bpp, (yy * w.width + xx + 1) * bpp);
      }
    }
  }
}
