import type {
  IAsepriteGateway,
  ISpriteCloser,
  ReadImageRequest,
  SelectionMask,
  WriteImageRequest,
} from "../../src/aseprite/AsepriteGateway.js";
import type {
  AnimationDirection,
  BlendMode,
  ColorMode,
  CreateSpriteOptions,
  ExportOptions,
  FrameOp,
  LayerInfo,
  LayerOp,
  Rect,
  SelectionOp,
  SpriteInfo,
  SpriteOp,
  SpriteRef,
  SpriteSummary,
  TagOp,
} from "../../src/aseprite/protocol.js";
import { compose } from "../../src/pixel/composite.js";
import { parseColor } from "../../src/pixel/PixelGridCodec.js";
import { createRgbaImage, type RgbaImage } from "../../src/pixel/RgbaImage.js";

export interface FakeLayer {
  name: string;
  isGroup: boolean;
  visible: boolean;
  editable: boolean;
  opacity: number;
  blendMode: BlendMode;
  /** Canvas-sized images keyed by 1-based frame number (image layers only). */
  cels: Map<number, RgbaImage>;
  /** Bottom to top, like Aseprite's stack. */
  children: FakeLayer[];
}

export interface FakeTag {
  name: string;
  from: number;
  to: number;
  direction: AnimationDirection;
  repeats: number;
  color?: string;
}

export interface FakeSpriteState {
  width: number;
  height: number;
  colorMode: ColorMode;
  filename: string;
  frames: { durationMs: number }[];
  /** Top-level layers, bottom to top. */
  layers: FakeLayer[];
  tags: FakeTag[];
  activeFrame: number;
  /** Path of the active layer. */
  activeLayer?: string;
  /** Canvas-sized 0/1 mask, null when nothing is selected. */
  selection: Uint8Array | null;
  /** "#rrggbbaa" per index. */
  palette: string[];
  transparentIndex: number;
}

interface FakeSprite {
  id: number;
  state: FakeSpriteState;
  undo: FakeSpriteState[];
  redo: FakeSpriteState[];
}

export interface FakeCall {
  method: string;
  args: unknown[];
}

export interface AddSpriteOptions extends Partial<CreateSpriteOptions> {
  filename?: string;
  /** Extra empty image layers above "Layer 1". */
  layers?: string[];
}

interface LayerEntry {
  layer: FakeLayer;
  path: string;
  parentPath?: string;
  /** The array that holds the layer (its parent's children or the top level). */
  siblings: FakeLayer[];
}

const DEFAULT_PALETTE = ["#00000000", "#000000ff", "#ffffffff"];

/**
 * In-memory IAsepriteGateway with Aseprite-like semantics: layer trees, cels per frame,
 * selection masks, tags and snapshot-based undo (every mutating call is one step).
 * Errors use the same wording as the Lua extension so tools see realistic failures.
 * Test-arrangement helpers (addSprite, fillRect, ...) are not recorded in `calls`.
 */
export class FakeGateway implements IAsepriteGateway, ISpriteCloser {
  connected = true;
  activeId: number | null = null;
  readonly calls: FakeCall[] = [];
  readonly saves: { path: string; copy: boolean; sprite: number }[] = [];
  readonly exports: (ExportOptions & { sprite: number })[] = [];
  private readonly sprites = new Map<number, FakeSprite>();
  private nextId = 1;

  // ---- test helpers -------------------------------------------------------------

  addSprite(options: AddSpriteOptions = {}): number {
    const id = this.nextId++;
    const width = options.width ?? 16;
    const height = options.height ?? 16;
    const frameCount = options.frames ?? 1;
    const base = newLayer("Layer 1");
    if (options.background) {
      const rgba = parseColor(options.background);
      for (let f = 1; f <= frameCount; f++) base.cels.set(f, solidImage(width, height, rgba));
    }
    const layers = [base, ...(options.layers ?? []).map((name) => newLayer(name))];
    this.sprites.set(id, {
      id,
      state: {
        width,
        height,
        colorMode: options.colorMode ?? "rgb",
        filename: options.filename ?? `Sprite-${String(id).padStart(4, "0")}`,
        frames: Array.from({ length: frameCount }, () => ({ durationMs: 100 })),
        layers,
        tags: [],
        activeFrame: 1,
        activeLayer: layers[layers.length - 1].name,
        selection: null,
        palette: [...DEFAULT_PALETTE],
        transparentIndex: 0,
      },
      undo: [],
      redo: [],
    });
    this.activeId = id;
    return id;
  }

  state(id?: number): FakeSpriteState {
    return this.sprite({ sprite: id }).state;
  }

  /** Paints a solid rectangle straight into a layer's cel (creating the layer if needed). */
  fillRect(options: { sprite?: number; layer?: string; frame?: number; x: number; y: number; width: number; height: number; color: string }): void {
    const s = this.sprite({ sprite: options.sprite }).state;
    const layer = options.layer === undefined ? this.defaultLayer(s) : this.findOrCreateLayer(s, options.layer);
    if (!layer) throw new Error("Sprite has no image layer");
    const frame = options.frame ?? s.activeFrame;
    const cel = this.celFor(s, layer, frame);
    const rgba = parseColor(options.color);
    for (let y = options.y; y < options.y + options.height; y++) {
      for (let x = options.x; x < options.x + options.width; x++) {
        if (x >= 0 && y >= 0 && x < s.width && y < s.height) cel.data.set(rgba, (y * s.width + x) * 4);
      }
    }
  }

  /** Canvas-sized copy of a layer's pixels (transparent when it has no cel). */
  layerImage(layer: string, frame = 1, sprite?: number): RgbaImage {
    const s = this.sprite({ sprite }).state;
    const entry = this.find(s, layer);
    if (!entry) throw new Error(`Layer not found: ${layer}`);
    const cel = entry.layer.cels.get(frame);
    return cel ? { width: cel.width, height: cel.height, data: new Uint8Array(cel.data) } : createRgbaImage(s.width, s.height);
  }

  pixel(layer: string, x: number, y: number, frame = 1, sprite?: number): number[] {
    const img = this.layerImage(layer, frame, sprite);
    const o = (y * img.width + x) * 4;
    return [...img.data.subarray(o, o + 4)];
  }

  callsOf(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  // ---- ISpriteGateway ---------------------------------------------------------

  isConnected(): boolean {
    return this.connected;
  }

  async listSprites(): Promise<SpriteSummary[]> {
    this.log("listSprites");
    return [...this.sprites.values()].map(({ id, state: s }) => ({
      id,
      filename: s.filename,
      width: s.width,
      height: s.height,
      colorMode: s.colorMode,
      frames: s.frames.length,
      isActive: id === this.activeId,
    }));
  }

  async activateSprite(sprite: number): Promise<void> {
    this.log("activateSprite", sprite);
    this.activeId = this.sprite({ sprite }).id;
  }

  async getSpriteInfo(ref: SpriteRef = {}): Promise<SpriteInfo> {
    this.log("getSpriteInfo", ref);
    return this.info(this.sprite(ref));
  }

  async createSprite(options: CreateSpriteOptions): Promise<SpriteInfo> {
    this.log("createSprite", options);
    const id = this.addSprite(options);
    return this.info(this.sprite({ sprite: id }));
  }

  /** Like the extension: onlyIfEmpty keeps a sprite with any pixel in any cel. */
  async closeSprite(sprite: number, options: { onlyIfEmpty?: boolean } = {}): Promise<boolean> {
    this.log("closeSprite", sprite, options);
    const found = this.sprite({ sprite });
    const hasPixels = (layers: FakeLayer[]): boolean =>
      layers.some((l) => [...l.cels.values()].some((c) => c.data.some((v, i) => i % 4 === 3 && v > 0)) || hasPixels(l.children));
    if (options.onlyIfEmpty && hasPixels(found.state.layers)) return false;
    this.sprites.delete(sprite);
    if (this.activeId === sprite) this.activeId = null;
    return true;
  }

  /** Test helper: whether a sprite is still open. */
  isOpen(sprite: number): boolean {
    return this.sprites.has(sprite);
  }

  async spriteOp(op: SpriteOp, ref: SpriteRef = {}): Promise<SpriteInfo> {
    this.log("spriteOp", op, ref);
    const sprite = this.sprite(ref);
    this.mutate(sprite, (s) => applySpriteOp(s, op));
    return this.info(sprite);
  }

  async undo(steps: number, ref: SpriteRef = {}): Promise<void> {
    this.log("undo", steps, ref);
    const sprite = this.sprite(ref);
    for (let i = 0; i < steps && sprite.undo.length > 0; i++) {
      sprite.redo.push(sprite.state);
      sprite.state = sprite.undo.pop()!;
    }
  }

  async redo(steps: number, ref: SpriteRef = {}): Promise<void> {
    this.log("redo", steps, ref);
    const sprite = this.sprite(ref);
    for (let i = 0; i < steps && sprite.redo.length > 0; i++) {
      sprite.undo.push(sprite.state);
      sprite.state = sprite.redo.pop()!;
    }
  }

  async saveSprite(options: { path?: string; copy?: boolean }, ref: SpriteRef = {}): Promise<string> {
    this.log("saveSprite", options, ref);
    const sprite = this.sprite(ref);
    const path = options.path ?? sprite.state.filename;
    if (!options.path && !/[/\\]/.test(path)) throw new Error("This sprite has never been saved; pass a path");
    if (!options.copy) sprite.state.filename = path;
    this.saves.push({ path, copy: options.copy ?? false, sprite: sprite.id });
    return path;
  }

  async exportSprite(options: ExportOptions, ref: SpriteRef = {}): Promise<string> {
    this.log("exportSprite", options, ref);
    const sprite = this.sprite(ref);
    this.exports.push({ ...options, sprite: sprite.id });
    return options.path;
  }

  // ---- IPixelGateway ----------------------------------------------------------

  async readImage(request: ReadImageRequest): Promise<{ rect: Rect; image: RgbaImage }> {
    this.log("readImage", request);
    const s = this.sprite(request).state;
    const frame = checkFrame(s, request.frame ?? s.activeFrame);
    const rect = {
      x: request.x ?? 0,
      y: request.y ?? 0,
      width: request.width ?? s.width,
      height: request.height ?? s.height,
    };
    if (rect.width < 1 || rect.height < 1) throw new Error("Region is empty");

    let source: RgbaImage;
    if (request.flattened) {
      source = flatten(s, frame);
    } else {
      let layer: FakeLayer | undefined;
      if (request.layer !== undefined) {
        layer = this.find(s, request.layer)?.layer;
        if (!layer && !request.missingOk) throw new Error(`Layer not found: ${request.layer}`);
      } else {
        layer = this.defaultLayer(s);
      }
      if (layer?.isGroup) throw new Error(`Layer is a group: ${layer.name}`);
      source = layer?.cels.get(frame) ?? createRgbaImage(s.width, s.height);
    }
    return { rect, image: crop(source, rect) };
  }

  async writeImages(writes: WriteImageRequest[], ref: SpriteRef = {}): Promise<void> {
    this.log("writeImages", writes, ref);
    if (writes.length === 0) return;
    const sprite = this.sprite(ref);
    this.mutate(sprite, (s) => {
      for (const w of writes) {
        const layer = w.layer === undefined ? this.defaultLayer(s) : this.findOrCreateLayer(s, w.layer);
        if (!layer) throw new Error("Sprite has no image layer");
        if (layer.isGroup) throw new Error(`Layer is a group: ${layer.name}`);
        if (!layer.editable) throw new Error(`Layer is locked: ${layer.name}`);
        const frame = checkFrame(s, w.frame ?? s.activeFrame);
        const cel = this.celFor(s, layer, frame);
        paste(cel, w.image, w.x, w.y);
      }
    });
  }

  // ---- ISelectionGateway ------------------------------------------------------

  async readSelection(request: Partial<Rect> & SpriteRef): Promise<SelectionMask> {
    this.log("readSelection", request);
    const s = this.sprite(request).state;
    const bounds = s.selection ? maskBoundsOf(s.selection, s.width, s.height) : undefined;
    if (request.width === undefined && !bounds) {
      return { isEmpty: true, rect: { x: 0, y: 0, width: 0, height: 0 }, mask: new Uint8Array(0) };
    }
    const rect =
      request.width !== undefined
        ? { x: request.x ?? 0, y: request.y ?? 0, width: request.width, height: request.height ?? s.height }
        : bounds!;
    const mask = new Uint8Array(rect.width * rect.height);
    if (s.selection) {
      for (let y = 0; y < rect.height; y++) {
        for (let x = 0; x < rect.width; x++) {
          const cx = rect.x + x;
          const cy = rect.y + y;
          if (cx >= 0 && cy >= 0 && cx < s.width && cy < s.height) mask[y * rect.width + x] = s.selection[cy * s.width + cx];
        }
      }
    }
    return { isEmpty: !bounds, bounds, rect, mask };
  }

  async setSelection(op: SelectionOp, rects: number[][], ref: SpriteRef = {}): Promise<{ isEmpty: boolean; bounds?: Rect }> {
    this.log("setSelection", op, rects, ref);
    const sprite = this.sprite(ref);
    this.mutate(sprite, (s) => {
      const size = s.width * s.height;
      const current = s.selection ?? new Uint8Array(size);
      const shape = new Uint8Array(size);
      for (const [rx, ry, rw, rh] of rects) {
        for (let y = Math.max(0, ry); y < Math.min(s.height, ry + rh); y++) {
          for (let x = Math.max(0, rx); x < Math.min(s.width, rx + rw); x++) shape[y * s.width + x] = 1;
        }
      }
      let next: Uint8Array;
      switch (op) {
        case "replace":
          next = shape;
          break;
        case "add":
          next = current.map((v, i) => v | shape[i]);
          break;
        case "subtract":
          next = current.map((v, i) => v & (1 - shape[i]));
          break;
        case "intersect":
          next = current.map((v, i) => v & shape[i]);
          break;
        case "all":
          next = new Uint8Array(size).fill(1);
          break;
        case "none":
          next = new Uint8Array(size);
          break;
        case "invert":
          next = current.map((v) => 1 - v);
          break;
        default:
          throw new Error(`Unknown selection op: ${String(op)}`);
      }
      s.selection = next.includes(1) ? next : null;
    });
    const s = sprite.state;
    const bounds = s.selection ? maskBoundsOf(s.selection, s.width, s.height) : undefined;
    return { isEmpty: !bounds, bounds };
  }

  // ---- ILayerGateway ----------------------------------------------------------

  async layerOp(op: LayerOp, ref: SpriteRef = {}): Promise<{ layer?: string }> {
    this.log("layerOp", op, ref);
    const sprite = this.sprite(ref);
    if (op.op === "activate") {
      const entry = this.require(sprite.state, op.name);
      this.activeId = sprite.id;
      sprite.state.activeLayer = entry.path;
      return { layer: entry.layer.name };
    }
    let result: string | undefined;
    this.mutate(sprite, (s) => {
      result = this.applyLayerOp(s, op);
    });
    return { layer: result };
  }

  private applyLayerOp(s: FakeSpriteState, op: Exclude<LayerOp, { op: "activate" }>): string | undefined {
    switch (op.op) {
      case "add": {
        const layer = newLayer(op.name, op.isGroup);
        let siblings = s.layers;
        if (op.group !== undefined && op.group !== "") siblings = this.requireGroup(s, op.group).children;
        if (op.above) {
          const anchor = this.require(s, op.above);
          anchor.siblings.splice(anchor.siblings.indexOf(anchor.layer) + 1, 0, layer);
        } else {
          siblings.push(layer);
        }
        return layer.name;
      }
      case "delete": {
        const entry = this.require(s, op.name);
        entry.siblings.splice(entry.siblings.indexOf(entry.layer), 1);
        if (s.activeLayer === entry.path) s.activeLayer = undefined;
        return undefined;
      }
      case "update": {
        const { layer } = this.require(s, op.name);
        if (op.newName !== undefined) layer.name = op.newName;
        if (op.visible !== undefined) layer.visible = op.visible;
        if (op.editable !== undefined) layer.editable = op.editable;
        if (op.opacity !== undefined) layer.opacity = Math.max(0, Math.min(255, Math.floor(op.opacity)));
        if (op.blendMode !== undefined) layer.blendMode = op.blendMode;
        return layer.name;
      }
      case "move": {
        const entry = this.require(s, op.name);
        const { layer } = entry;
        if (op.group !== undefined) {
          const target = op.group === "" ? s.layers : this.requireGroup(s, op.group).children;
          entry.siblings.splice(entry.siblings.indexOf(layer), 1);
          target.push(layer);
        }
        const place = (anchorName: string, offset: number) => {
          const anchor = this.require(s, anchorName);
          const current = this.require(s, layer.name);
          current.siblings.splice(current.siblings.indexOf(layer), 1);
          anchor.siblings.splice(anchor.siblings.indexOf(anchor.layer) + offset, 0, layer);
        };
        if (op.above) place(op.above, 1);
        if (op.below) place(op.below, 0);
        return layer.name;
      }
      case "duplicate": {
        const entry = this.require(s, op.name);
        const copy = cloneLayer(entry.layer);
        copy.name = op.newName ?? `${entry.layer.name} Copy`;
        entry.siblings.splice(entry.siblings.indexOf(entry.layer) + 1, 0, copy);
        s.activeLayer = entry.parentPath ? `${entry.parentPath}/${copy.name}` : copy.name;
        return copy.name;
      }
      case "merge_down": {
        const entry = this.require(s, op.name);
        const index = entry.siblings.indexOf(entry.layer);
        if (index === 0) throw new Error(`Nothing below ${entry.layer.name} to merge into`);
        const below = entry.siblings[index - 1];
        for (let f = 1; f <= s.frames.length; f++) {
          const top = entry.layer.cels.get(f);
          if (!top) continue;
          const base = below.cels.get(f) ?? createRgbaImage(s.width, s.height);
          below.cels.set(f, compose(base, withOpacity(top, entry.layer.opacity), "over"));
        }
        entry.siblings.splice(index, 1);
        s.activeLayer = entry.parentPath ? `${entry.parentPath}/${below.name}` : below.name;
        return below.name;
      }
    }
  }

  // ---- IAnimationGateway ------------------------------------------------------

  async frameOp(op: FrameOp, ref: SpriteRef = {}): Promise<{ frames: number }> {
    this.log("frameOp", op, ref);
    const sprite = this.sprite(ref);
    if (op.op === "activate") {
      sprite.state.activeFrame = checkFrame(sprite.state, op.frame);
      this.activeId = sprite.id;
    } else if (op.op === "copy_cel") {
      this.mutate(sprite, (s) => copyCel(s, op, this.copyTargets(s, op.layer)));
    } else {
      this.mutate(sprite, (s) => applyFrameOp(s, op));
    }
    return { frames: sprite.state.frames.length };
  }

  async tagOp(op: TagOp, ref: SpriteRef = {}): Promise<void> {
    this.log("tagOp", op, ref);
    this.mutate(this.sprite(ref), (s) => {
      const find = (name: string) => {
        const tag = s.tags.find((t) => t.name === name);
        if (!tag) throw new Error(`Tag not found: ${name}`);
        return tag;
      };
      switch (op.op) {
        case "add":
          s.tags.push({
            name: op.name,
            from: checkFrame(s, op.from ?? 1),
            to: checkFrame(s, op.to ?? s.frames.length),
            direction: op.direction ?? "forward",
            repeats: op.repeats ?? 0,
            color: op.color,
          });
          return;
        case "update": {
          const tag = find(op.name);
          if (op.newName !== undefined) tag.name = op.newName;
          if (op.from !== undefined) tag.from = checkFrame(s, op.from);
          if (op.to !== undefined) tag.to = checkFrame(s, op.to);
          if (op.direction !== undefined) tag.direction = op.direction;
          if (op.repeats !== undefined) tag.repeats = op.repeats;
          return;
        }
        case "delete":
          s.tags.splice(s.tags.indexOf(find(op.name)), 1);
          return;
      }
    });
  }

  // ---- IPaletteGateway --------------------------------------------------------

  async getPalette(ref: SpriteRef = {}): Promise<{ colors: string[]; transparentIndex: number }> {
    this.log("getPalette", ref);
    const s = this.sprite(ref).state;
    return { colors: [...s.palette], transparentIndex: s.transparentIndex };
  }

  async setPalette(colors: string[], ref: SpriteRef = {}): Promise<void> {
    this.log("setPalette", colors, ref);
    this.mutate(this.sprite(ref), (s) => {
      s.palette = colors.map((c) => {
        const [r, g, b, a] = parseColor(c);
        return `#${[r, g, b, a].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
      });
    });
  }

  // ---- internals --------------------------------------------------------------

  private log(method: string, ...args: unknown[]): void {
    if (!this.connected) {
      throw new Error("Aseprite is not connected. Open Aseprite with the Claude Pixel Bridge extension installed.");
    }
    this.calls.push({ method, args });
  }

  private sprite(ref: SpriteRef = {}): FakeSprite {
    if (ref.sprite !== undefined) {
      const sprite = this.sprites.get(ref.sprite);
      if (!sprite) throw new Error(`Sprite ${ref.sprite} is not open anymore`);
      return sprite;
    }
    const active = this.activeId === null ? undefined : this.sprites.get(this.activeId);
    if (!active) throw new Error("No sprite is open in Aseprite");
    return active;
  }

  /** Like app.transaction: one undo step, rolled back entirely when `fn` throws. */
  private mutate(sprite: FakeSprite, fn: (state: FakeSpriteState) => void): void {
    const before = structuredClone(sprite.state);
    try {
      fn(sprite.state);
    } catch (error) {
      sprite.state = before;
      throw error;
    }
    sprite.undo.push(before);
    sprite.redo = [];
  }

  private info(sprite: FakeSprite): SpriteInfo {
    const s = sprite.state;
    const layers: LayerInfo[] = this.entries(s).map(({ layer, path, parentPath, siblings }) => ({
      name: layer.name,
      path,
      isGroup: layer.isGroup,
      isVisible: layer.visible,
      isEditable: layer.editable,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      stackIndex: siblings.indexOf(layer) + 1,
      ...(parentPath ? { parent: parentPath } : {}),
    }));
    const isActive = sprite.id === this.activeId;
    const activeLayer = isActive && s.activeLayer ? this.find(s, s.activeLayer)?.layer.name : undefined;
    const selection = s.selection ? maskBoundsOf(s.selection, s.width, s.height) : undefined;
    return {
      id: sprite.id,
      filename: s.filename,
      width: s.width,
      height: s.height,
      colorMode: s.colorMode,
      frames: s.frames.map((f, i) => ({ index: i + 1, durationMs: f.durationMs })),
      layers,
      tags: s.tags.map(({ name, from, to, direction, repeats }) => ({ name, from, to, direction, repeats })),
      activeFrame: s.activeFrame,
      ...(activeLayer ? { activeLayer } : {}),
      ...(selection ? { selection } : {}),
      paletteSize: s.palette.length,
      transparentIndex: s.transparentIndex,
    };
  }

  /** Depth-first, bottom to top, groups before their children (Aseprite's listing order). */
  private entries(s: FakeSpriteState): LayerEntry[] {
    const out: LayerEntry[] = [];
    const walk = (siblings: FakeLayer[], parentPath?: string) => {
      for (const layer of siblings) {
        const path = parentPath ? `${parentPath}/${layer.name}` : layer.name;
        out.push({ layer, path, parentPath, siblings });
        if (layer.isGroup) walk(layer.children, path);
      }
    };
    walk(s.layers);
    return out;
  }

  /** Group path first, then plain name, like the Lua side. */
  private find(s: FakeSpriteState, name: string): LayerEntry | undefined {
    const all = this.entries(s);
    return all.find((e) => e.path === name) ?? all.find((e) => e.layer.name === name);
  }

  private require(s: FakeSpriteState, name: string): LayerEntry {
    const entry = this.find(s, name);
    if (!entry) throw new Error(`Layer not found: ${name}`);
    return entry;
  }

  private requireGroup(s: FakeSpriteState, name: string): FakeLayer {
    const { layer } = this.require(s, name);
    if (!layer.isGroup) throw new Error(`Not a group: ${name}`);
    return layer;
  }

  private defaultLayer(s: FakeSpriteState): FakeLayer | undefined {
    const active = s.activeLayer ? this.find(s, s.activeLayer)?.layer : undefined;
    if (active && !active.isGroup) return active;
    return this.entries(s)
      .map((e) => e.layer)
      .filter((l) => !l.isGroup)
      .at(-1);
  }

  /** The named layer, or every editable image layer (locked ones are skipped, like the extension). */
  private copyTargets(s: FakeSpriteState, name: string | undefined): FakeLayer[] {
    if (name === undefined) return this.entries(s).map((e) => e.layer).filter((l) => !l.isGroup && l.editable);
    const { layer } = this.require(s, name);
    if (layer.isGroup) throw new Error(`Layer is a group: ${layer.name}`);
    if (!layer.editable) throw new Error(`Layer is locked: ${layer.name}`);
    return [layer];
  }

  private findOrCreateLayer(s: FakeSpriteState, name: string): FakeLayer {
    const found = this.find(s, name);
    if (found) return found.layer;
    const layer = newLayer(name);
    s.layers.push(layer);
    return layer;
  }

  private celFor(s: FakeSpriteState, layer: FakeLayer, frame: number): RgbaImage {
    let cel = layer.cels.get(frame);
    if (!cel) {
      cel = createRgbaImage(s.width, s.height);
      layer.cels.set(frame, cel);
    }
    return cel;
  }
}

// ---- pure helpers ---------------------------------------------------------------

function newLayer(name: string, isGroup = false): FakeLayer {
  return { name, isGroup, visible: true, editable: true, opacity: 255, blendMode: "normal", cels: new Map(), children: [] };
}

function cloneLayer(layer: FakeLayer): FakeLayer {
  return {
    ...layer,
    cels: new Map([...layer.cels].map(([f, img]) => [f, { ...img, data: new Uint8Array(img.data) }])),
    children: layer.children.map(cloneLayer),
  };
}

function solidImage(width: number, height: number, rgba: number[]): RgbaImage {
  const img = createRgbaImage(width, height);
  for (let i = 0; i < width * height; i++) img.data.set(rgba, i * 4);
  return img;
}

function checkFrame(s: FakeSpriteState, n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > s.frames.length) {
    throw new Error(`Frame ${n} out of range (sprite has ${s.frames.length} frames)`);
  }
  return n;
}

/** `rect` of `source` (canvas-sized); outside pixels are transparent. */
function crop(source: RgbaImage, rect: Rect): RgbaImage {
  const out = createRgbaImage(rect.width, rect.height);
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const sx = rect.x + x;
      const sy = rect.y + y;
      if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;
      const o = (sy * source.width + sx) * 4;
      out.data.set(source.data.subarray(o, o + 4), (y * rect.width + x) * 4);
    }
  }
  return out;
}

/** Replaces the pixels under `image` at (x, y), clipped to the canvas. */
function paste(target: RgbaImage, image: RgbaImage, x: number, y: number): void {
  for (let iy = 0; iy < image.height; iy++) {
    for (let ix = 0; ix < image.width; ix++) {
      const tx = x + ix;
      const ty = y + iy;
      if (tx < 0 || ty < 0 || tx >= target.width || ty >= target.height) continue;
      const o = (iy * image.width + ix) * 4;
      target.data.set(image.data.subarray(o, o + 4), (ty * target.width + tx) * 4);
    }
  }
}

function withOpacity(image: RgbaImage, opacity: number): RgbaImage {
  if (opacity >= 255) return image;
  const data = new Uint8Array(image.data);
  for (let i = 3; i < data.length; i += 4) data[i] = Math.round((data[i] * opacity) / 255);
  return { width: image.width, height: image.height, data };
}

/** Visible image layers composited bottom to top (normal blend; blend modes are ignored). */
function flatten(s: FakeSpriteState, frame: number): RgbaImage {
  let out = createRgbaImage(s.width, s.height);
  const walk = (layers: FakeLayer[]) => {
    for (const layer of layers) {
      if (!layer.visible) continue;
      if (layer.isGroup) {
        walk(layer.children);
        continue;
      }
      const cel = layer.cels.get(frame);
      if (cel) out = compose(out, withOpacity(cel, layer.opacity), "over");
    }
  };
  walk(s.layers);
  return out;
}

function maskBoundsOf(mask: Uint8Array, width: number, height: number): Rect | undefined {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX < 0 ? undefined : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Moves every cel and the selection to a new canvas; `source` maps new → old coordinates. */
function remapCanvas(
  s: FakeSpriteState,
  width: number,
  height: number,
  source: (x: number, y: number) => [number, number],
): void {
  const remap = (src: Uint8Array, channels: number) => {
    const out = new Uint8Array(width * height * channels);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [sx, sy] = source(x, y);
        if (sx < 0 || sy < 0 || sx >= s.width || sy >= s.height) continue;
        const o = (sy * s.width + sx) * channels;
        out.set(src.subarray(o, o + channels), (y * width + x) * channels);
      }
    }
    return out;
  };
  const walk = (layers: FakeLayer[]) => {
    for (const layer of layers) {
      for (const [f, cel] of layer.cels) layer.cels.set(f, { width, height, data: remap(cel.data, 4) });
      walk(layer.children);
    }
  };
  walk(s.layers);
  s.selection = null;
  s.width = width;
  s.height = height;
}

function applySpriteOp(s: FakeSpriteState, op: SpriteOp): void {
  const { width: w, height: h } = s;
  switch (op.op) {
    case "resize":
      return remapCanvas(s, op.width, op.height, (x, y) => [
        Math.floor((x * w) / op.width),
        Math.floor((y * h) / op.height),
      ]);
    case "canvas": {
      const left = op.left ?? 0;
      const top = op.top ?? 0;
      const nw = w + left + (op.right ?? 0);
      const nh = h + top + (op.bottom ?? 0);
      if (nw < 1 || nh < 1) throw new Error("Canvas would be empty");
      return remapCanvas(s, nw, nh, (x, y) => [x - left, y - top]);
    }
    case "crop":
      return remapCanvas(s, op.width, op.height, (x, y) => [x + op.x, y + op.y]);
    case "color_mode":
      s.colorMode = op.mode;
      return;
    case "rotate":
      if (op.angle === 180) return remapCanvas(s, w, h, (x, y) => [w - 1 - x, h - 1 - y]);
      // Clockwise 90: new (x, y) shows old (y, h - 1 - x); 270 is the mirror of that.
      if (op.angle === 90) return remapCanvas(s, h, w, (x, y) => [y, h - 1 - x]);
      return remapCanvas(s, h, w, (x, y) => [w - 1 - y, x]);
    case "flip":
      if (op.direction === "horizontal") return remapCanvas(s, w, h, (x, y) => [w - 1 - x, y]);
      return remapCanvas(s, w, h, (x, y) => [x, h - 1 - y]);
  }
}

/** Shifts cel keys and tags so frame numbers stay consistent after inserting/removing frames. */
function shiftFrames(s: FakeSpriteState, from: number, delta: number): void {
  const walk = (layers: FakeLayer[]) => {
    for (const layer of layers) {
      const moved = new Map<number, RgbaImage>();
      for (const [f, cel] of layer.cels) {
        if (delta < 0 && f >= from && f < from - delta) continue;
        moved.set(f >= from ? f + delta : f, cel);
      }
      layer.cels = moved;
      walk(layer.children);
    }
  };
  walk(s.layers);
  const count = s.frames.length;
  // Like Aseprite: frames inserted right after a tag's last frame stretch that tag.
  const stretchesFrom = delta > 0 ? from - 1 : from;
  for (const tag of s.tags) {
    if (tag.from >= from) tag.from = Math.max(1, Math.min(count, tag.from + delta));
    if (tag.to >= stretchesFrom) tag.to = Math.max(tag.from, Math.min(count, tag.to + delta));
  }
  s.activeFrame = Math.max(1, Math.min(count, s.activeFrame));
}

/** frame_op copy_cel: the target frame becomes the source frame on those layers, optionally mirrored. */
function copyCel(s: FakeSpriteState, op: Extract<FrameOp, { op: "copy_cel" }>, layers: FakeLayer[]): void {
  const from = checkFrame(s, op.from);
  const to = checkFrame(s, op.to);
  for (const layer of layers) {
    const source = layer.cels.get(from);
    if (!source) {
      layer.cels.delete(to);
      continue;
    }
    const copy = createRgbaImage(source.width, source.height);
    for (let y = 0; y < source.height; y++) {
      for (let x = 0; x < source.width; x++) {
        const sx = op.flip === "horizontal" ? source.width - 1 - x : x;
        const sy = op.flip === "vertical" ? source.height - 1 - y : y;
        const o = (sy * source.width + sx) * 4;
        copy.data.set(source.data.subarray(o, o + 4), (y * source.width + x) * 4);
      }
    }
    layer.cels.set(to, copy);
  }
}

function applyFrameOp(s: FakeSpriteState, op: Exclude<FrameOp, { op: "activate" }>): void {
  switch (op.op) {
    case "add": {
      const after = op.after === undefined ? s.frames.length : checkFrame(s, op.after);
      const count = Math.max(1, op.count ?? 1);
      const durationMs = op.durationMs ?? s.frames[after - 1].durationMs;
      s.frames.splice(after, 0, ...Array.from({ length: count }, () => ({ durationMs })));
      shiftFrames(s, after + 1, count);
      if (op.copy) {
        const walk = (layers: FakeLayer[]) => {
          for (const layer of layers) {
            const cel = layer.cels.get(after);
            if (cel) for (let i = 1; i <= count; i++) layer.cels.set(after + i, { ...cel, data: new Uint8Array(cel.data) });
            walk(layer.children);
          }
        };
        walk(s.layers);
      }
      return;
    }
    case "delete": {
      const from = checkFrame(s, op.from);
      const to = checkFrame(s, op.to ?? op.from);
      if (to - from + 1 >= s.frames.length) throw new Error("Cannot delete every frame");
      s.frames.splice(from - 1, to - from + 1);
      shiftFrames(s, from, -(to - from + 1));
      return;
    }
    case "duration": {
      const frames = op.frames ?? s.frames.map((_, i) => i + 1);
      for (const f of frames) s.frames[checkFrame(s, f) - 1].durationMs = Math.max(1, op.durationMs);
      return;
    }
  }
}
