// Test doubles shared by the chat/scoped/instant tests (not a test file itself).
import type {
  IAsepriteGateway,
  ReadImageRequest,
  SelectionMask,
  WriteImageRequest,
} from "../src/aseprite/AsepriteGateway.js";
import type { AsepriteEvent, IAsepriteEvents } from "../src/aseprite/AsepriteSocket.js";
import type {
  CreateSpriteOptions,
  FrameOp,
  Rect,
  SpriteInfo,
  SpriteRef,
  TagOp,
} from "../src/aseprite/protocol.js";
import type { ILlmRunner, IProviderRegistry, LlmEvent, LlmRunRequest, ProviderInfo } from "../src/llm/LlmRunner.js";
import { createRgbaImage, type RgbaImage } from "../src/pixel/RgbaImage.js";

export interface Call {
  method: string;
  args: unknown[];
}

interface FakeSprite {
  info: SpriteInfo;
  frames: RgbaImage[];
}

export function spriteInfo(id: number, overrides: Partial<SpriteInfo> = {}): SpriteInfo {
  return {
    id,
    filename: `Sprite-${String(id).padStart(4, "0")}`,
    width: 32,
    height: 32,
    colorMode: "rgb",
    frames: [{ index: 1, durationMs: 100 }],
    layers: [
      {
        name: "Layer 1",
        path: "Layer 1",
        isGroup: false,
        isVisible: true,
        isEditable: true,
        opacity: 255,
        blendMode: "normal",
        stackIndex: 0,
      },
    ],
    tags: [],
    activeFrame: 1,
    activeLayer: "Layer 1",
    paletteSize: 32,
    transparentIndex: 0,
    ...overrides,
  };
}

/** In-memory Aseprite: enough behaviour for the chat services, and a log of every call. */
export class FakeGateway implements IAsepriteGateway {
  readonly calls: Call[] = [];
  readonly sprites = new Map<number, FakeSprite>();
  active?: number;
  private nextId = 1;
  selection: SelectionMask = { isEmpty: true, rect: { x: 0, y: 0, width: 0, height: 0 }, mask: new Uint8Array(0) };

  addSprite(overrides: Partial<SpriteInfo> = {}, paint = false): SpriteInfo {
    const id = overrides.id ?? this.nextId;
    this.nextId = Math.max(this.nextId, id + 1);
    const info = spriteInfo(id, overrides);
    const frames = info.frames.map(() => createRgbaImage(info.width, info.height));
    if (paint) {
      // A 2x2 red block at (3, 4) and one blue pixel at (10, 10).
      for (const [x, y, c] of [[3, 4, [255, 0, 0]], [4, 4, [255, 0, 0]], [3, 5, [255, 0, 0]], [4, 5, [255, 0, 0]], [10, 10, [0, 0, 255]]] as const) {
        for (const frame of frames) frame.data.set([...c, 255], (y * info.width + x) * 4);
      }
    }
    this.sprites.set(id, { info, frames });
    this.active = id;
    return info;
  }

  private log(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  callsOf(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  private sprite(ref: SpriteRef = {}): FakeSprite {
    const id = ref.sprite ?? this.active;
    if (id === undefined) throw new Error("No sprite is open in Aseprite");
    const sprite = this.sprites.get(id);
    if (!sprite) throw new Error(`Sprite ${id} is not open anymore`);
    return sprite;
  }

  isConnected(): boolean {
    return true;
  }

  async listSprites() {
    this.log("listSprites");
    return [...this.sprites.values()].map(({ info }) => ({
      id: info.id,
      filename: info.filename,
      width: info.width,
      height: info.height,
      colorMode: info.colorMode,
      frames: info.frames.length,
      isActive: info.id === this.active,
    }));
  }

  async activateSprite(sprite: number) {
    this.log("activateSprite", sprite);
    this.active = sprite;
  }

  async getSpriteInfo(ref?: SpriteRef) {
    this.log("getSpriteInfo", ref);
    return structuredClone(this.sprite(ref).info);
  }

  async createSprite(options: CreateSpriteOptions) {
    this.log("createSprite", options);
    const frames = Array.from({ length: options.frames ?? 1 }, (_, i) => ({ index: i + 1, durationMs: 100 }));
    return structuredClone(this.addSprite({ width: options.width, height: options.height, frames }));
  }

  async spriteOp(op: unknown, ref?: SpriteRef) {
    this.log("spriteOp", op, ref);
    return structuredClone(this.sprite(ref).info);
  }

  async undo(steps: number, ref?: SpriteRef) {
    this.log("undo", steps, ref);
  }

  async redo(steps: number, ref?: SpriteRef) {
    this.log("redo", steps, ref);
  }

  async saveSprite(options: { path?: string }, ref?: SpriteRef) {
    this.log("saveSprite", options, ref);
    return options.path ?? "/tmp/sprite.aseprite";
  }

  async exportSprite(options: { path: string }, ref?: SpriteRef) {
    this.log("exportSprite", options, ref);
    return options.path;
  }

  async readImage(request: ReadImageRequest) {
    this.log("readImage", request);
    const sprite = this.sprite(request);
    const frame = sprite.frames[(request.frame ?? sprite.info.activeFrame) - 1];
    const rect: Rect = {
      x: request.x ?? 0,
      y: request.y ?? 0,
      width: request.width ?? sprite.info.width,
      height: request.height ?? sprite.info.height,
    };
    const image = createRgbaImage(rect.width, rect.height);
    for (let y = 0; y < rect.height; y++) {
      for (let x = 0; x < rect.width; x++) {
        const sx = rect.x + x;
        const sy = rect.y + y;
        if (sx < 0 || sy < 0 || sx >= frame.width || sy >= frame.height) continue;
        image.data.set(frame.data.subarray((sy * frame.width + sx) * 4, (sy * frame.width + sx) * 4 + 4), (y * rect.width + x) * 4);
      }
    }
    return { rect, image };
  }

  async writeImages(writes: WriteImageRequest[], ref?: SpriteRef) {
    this.log("writeImages", writes, ref);
  }

  async readSelection(request: Partial<Rect> & SpriteRef) {
    this.log("readSelection", request);
    return this.selection;
  }

  async setSelection(op: string, rects: number[][], ref?: SpriteRef) {
    this.log("setSelection", op, rects, ref);
    return { isEmpty: op === "none" };
  }

  async layerOp(op: unknown, ref?: SpriteRef) {
    this.log("layerOp", op, ref);
    return {};
  }

  async frameOp(op: FrameOp, ref?: SpriteRef) {
    this.log("frameOp", op, ref);
    const sprite = this.sprite(ref);
    if (op.op === "add") {
      const count = op.count ?? 1;
      for (let i = 0; i < count; i++) {
        sprite.info.frames.push({ index: sprite.info.frames.length + 1, durationMs: op.durationMs ?? 100 });
        sprite.frames.push(createRgbaImage(sprite.info.width, sprite.info.height));
      }
    }
    if (op.op === "duration") for (const f of sprite.info.frames) f.durationMs = op.durationMs;
    return { frames: sprite.info.frames.length };
  }

  async tagOp(op: TagOp, ref?: SpriteRef) {
    this.log("tagOp", op, ref);
    const sprite = this.sprite(ref);
    if (op.op === "add") {
      sprite.info.tags.push({
        name: op.name,
        from: op.from ?? 1,
        to: op.to ?? sprite.info.frames.length,
        direction: op.direction ?? "forward",
        repeats: op.repeats ?? 0,
      });
    }
  }

  async getPalette(ref?: SpriteRef) {
    this.log("getPalette", ref);
    return { colors: ["#000000ff", "#ffffffff", "#ff0000ff"], transparentIndex: 0 };
  }

  async setPalette(colors: string[], ref?: SpriteRef) {
    this.log("setPalette", colors, ref);
  }
}

/** Captures what the bridge sends back to Aseprite. */
export class FakeEvents implements IAsepriteEvents {
  readonly sent: AsepriteEvent[] = [];
  private handler?: (event: AsepriteEvent) => void;
  private connectionHandler?: (connected: boolean) => void;

  onEvent(handler: (event: AsepriteEvent) => void): void {
    this.handler = handler;
  }

  onConnectionChange(handler: (connected: boolean) => void): void {
    this.connectionHandler = handler;
  }

  notify(event: AsepriteEvent): void {
    this.sent.push(event);
  }

  emit(event: AsepriteEvent): void {
    this.handler?.(event);
  }

  setConnected(connected: boolean): void {
    this.connectionHandler?.(connected);
  }

  chat(kind?: string): AsepriteEvent[] {
    return this.sent.filter((e) => e.event === "chat" && (kind === undefined || e.kind === kind));
  }
}

export type Script = (request: LlmRunRequest) => AsyncIterable<LlmEvent>;

/** A runner whose behaviour per run is a script; records every request it gets. */
export class FakeRunner implements ILlmRunner {
  readonly requests: LlmRunRequest[] = [];
  constructor(public script: Script = defaultScript()) {}

  run(request: LlmRunRequest): AsyncIterable<LlmEvent> {
    this.requests.push(request);
    return this.script(request);
  }
}

export function defaultScript(sessionId = "s-1", text = "Done."): Script {
  return async function* () {
    yield { type: "session", sessionId };
    yield { type: "tool", name: "draw_script" };
    yield { type: "text", text };
    yield { type: "done", ok: true, stats: { durationMs: 5, turns: 3, costUsd: 0.01 } };
  };
}

/** Runs until the request's signal aborts, then reports the kill like a real CLI does. */
export function hangingScript(started?: () => void): Script {
  return async function* (request) {
    yield { type: "session", sessionId: "s-hang" };
    started?.();
    await new Promise<void>((resolve) => {
      if (request.signal?.aborted) return resolve();
      request.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    yield { type: "done", ok: false, error: "Stopped." };
  };
}

export const CLAUDE_INFO: ProviderInfo = {
  id: "claude-code",
  label: "Claude Code",
  models: [
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
  ],
  efforts: ["low", "medium", "high", "xhigh", "max"],
  available: true,
  supportsImages: true,
};

export class FakeRegistry implements IProviderRegistry {
  readonly defaultId = "claude-code";
  constructor(
    public providers: ProviderInfo[] = [CLAUDE_INFO],
    public runners: Record<string, ILlmRunner> = { "claude-code": new FakeRunner() },
  ) {}

  async list(): Promise<ProviderInfo[]> {
    return this.providers;
  }

  runner(id: string): ILlmRunner {
    const runner = this.runners[id];
    if (!runner) throw new Error(`Unknown AI provider "${id}"`);
    return runner;
  }
}

/** Resolves once `predicate` holds, polling the event loop (tests only). */
export async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("until: timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
