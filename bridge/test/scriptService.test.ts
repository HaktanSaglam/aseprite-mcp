import { describe, expect, it } from "vitest";
import type {
  FrameOp,
  ReadImageRequest,
  SelectionMask,
  SpriteInfo,
  WriteImageRequest,
} from "../src/aseprite/AsepriteGateway.js";
import { CanvasService } from "../src/canvas/CanvasService.js";
import { createRgbaImage, type RgbaImage } from "../src/pixel/RgbaImage.js";
import { DrawScriptService, type DrawScriptJob } from "../src/script/DrawScriptService.js";
import { QuickJsScriptRunner } from "../src/script/QuickJsScriptRunner.js";

/** In-memory sprite with one layer ("L") plus "BG": just enough Aseprite for draw_script. */
class FakeSprite {
  width: number;
  height: number;
  activeFrame = 1;
  durations: number[];
  cels = new Map<string, RgbaImage>();
  writeCalls: WriteImageRequest[][] = [];
  frameOps: FrameOp[] = [];
  selection?: { rect: { x: number; y: number; width: number; height: number }; mask: Uint8Array };

  constructor(width: number, height: number, frames: number) {
    this.width = width;
    this.height = height;
    this.durations = Array(frames).fill(100);
  }

  private key(frame: number, layer = "L") {
    return `${frame}/${layer}`;
  }

  cel(frame: number, layer = "L"): RgbaImage {
    let image = this.cels.get(this.key(frame, layer));
    if (!image) {
      image = createRgbaImage(this.width, this.height);
      this.cels.set(this.key(frame, layer), image);
    }
    return image;
  }

  pixel(frame: number, x: number, y: number, layer = "L"): number[] {
    const image = this.cel(frame, layer);
    const o = (y * this.width + x) * 4;
    return [...image.data.subarray(o, o + 4)];
  }

  paint(frame: number, x: number, y: number, rgba: number[], layer = "L") {
    this.cel(frame, layer).data.set(rgba, (y * this.width + x) * 4);
  }

  async getSpriteInfo(): Promise<SpriteInfo> {
    return {
      id: 1,
      filename: "test",
      width: this.width,
      height: this.height,
      colorMode: "rgb",
      frames: this.durations.map((durationMs, i) => ({ index: i + 1, durationMs })),
      layers: [],
      tags: [],
      activeFrame: this.activeFrame,
      paletteSize: 0,
      transparentIndex: 0,
    };
  }

  async readImage(request: ReadImageRequest) {
    const rect = {
      x: request.x ?? 0,
      y: request.y ?? 0,
      width: request.width ?? this.width,
      height: request.height ?? this.height,
    };
    const frame = request.frame ?? this.activeFrame;
    const out = createRgbaImage(rect.width, rect.height);
    const layers = request.flattened ? ["BG", "L"] : [request.layer ?? "L"];
    for (const layer of layers) {
      const src = this.cel(frame, layer);
      for (let y = 0; y < rect.height; y++)
        for (let x = 0; x < rect.width; x++) {
          const sx = rect.x + x;
          const sy = rect.y + y;
          if (sx < 0 || sy < 0 || sx >= this.width || sy >= this.height) continue;
          const o = (sy * this.width + sx) * 4;
          if (src.data[o + 3] > 0) out.data.set(src.data.subarray(o, o + 4), (y * rect.width + x) * 4);
        }
    }
    return { rect, image: out };
  }

  async writeImages(writes: WriteImageRequest[]) {
    this.writeCalls.push(writes);
    for (const w of writes) {
      const frame = w.frame ?? this.activeFrame;
      if (frame > this.durations.length) throw new Error(`frame ${frame} does not exist`);
      const dst = this.cel(frame, w.layer ?? "L");
      for (let y = 0; y < w.image.height; y++)
        for (let x = 0; x < w.image.width; x++) {
          const dx = w.x + x;
          const dy = w.y + y;
          if (dx < 0 || dy < 0 || dx >= this.width || dy >= this.height) continue;
          const o = (y * w.image.width + x) * 4;
          dst.data.set(w.image.data.subarray(o, o + 4), (dy * this.width + dx) * 4);
        }
    }
  }

  async readSelection(): Promise<SelectionMask> {
    if (!this.selection) return { isEmpty: true, rect: { x: 0, y: 0, width: 0, height: 0 }, mask: new Uint8Array(0) };
    return { isEmpty: false, bounds: this.selection.rect, ...this.selection };
  }

  async setSelection() {
    return { isEmpty: true };
  }

  async frameOp(op: FrameOp) {
    this.frameOps.push(op);
    if (op.op === "add") {
      const after = op.after ?? this.durations.length;
      for (let k = 0; k < (op.count ?? 1); k++) {
        this.durations.push(op.durationMs ?? 100);
        const frame = this.durations.length;
        for (const layer of ["BG", "L"]) {
          if (op.copy) this.cels.set(this.key(frame, layer), { ...this.cel(after, layer), data: new Uint8Array(this.cel(after, layer).data) });
        }
      }
    } else if (op.op === "duration") {
      for (const f of op.frames ?? []) this.durations[f - 1] = op.durationMs;
    }
    return { frames: this.durations.length };
  }
}

const runner = new QuickJsScriptRunner();

function setup(width = 8, height = 8, frames = 1) {
  const sprite = new FakeSprite(width, height, frames);
  const service = new DrawScriptService(sprite, new CanvasService(sprite), runner);
  const draw = (job: Partial<DrawScriptJob> & { code: string }) =>
    service.draw({ x: 0, y: 0, base: "empty", seed: 1, selectionOnly: false, preview: false, ...job });
  return { sprite, draw };
}

const WHITE = [255, 255, 255, 255];
const RED = [255, 0, 0, 255];
const CLEAR = [0, 0, 0, 0];

describe("DrawScriptService", () => {
  it("draws the active frame over existing art by default (empty base keeps what is around)", async () => {
    const { sprite, draw } = setup();
    sprite.activeFrame = 1;
    sprite.paint(1, 7, 7, RED);
    const outcome = await draw({ code: 'set(0, 0, "#ffffff");' });
    expect(outcome.frames).toEqual([1]);
    expect(outcome.created).toEqual([]);
    expect(sprite.pixel(1, 0, 0)).toEqual(WHITE);
    expect(sprite.pixel(1, 7, 7)).toEqual(RED);
    expect(sprite.writeCalls).toHaveLength(1);
  });

  it("draws an animation in ONE write, creating missing frames after the script succeeded", async () => {
    const { sprite, draw } = setup(8, 8, 1);
    sprite.paint(1, 5, 5, RED, "BG");
    sprite.paint(1, 3, 3, RED); // target-layer art in frame 1 must not ghost into new frames
    const outcome = await draw({ code: 'set(i, 0, "#ffffff");', frames: [1, 2, 3, 4], frameMs: 120 });

    expect(outcome.frames).toEqual([1, 2, 3, 4]);
    expect(outcome.created).toEqual([2, 3, 4]);
    expect(sprite.frameOps[0]).toEqual({ op: "add", after: 1, count: 3, copy: true });
    expect(sprite.frameOps[1]).toEqual({ op: "duration", frames: [1, 2, 3, 4], durationMs: 120 });
    expect(sprite.writeCalls).toHaveLength(1);
    expect(sprite.writeCalls[0]).toHaveLength(4);
    expect(sprite.durations).toEqual([120, 120, 120, 120]);

    for (const f of [1, 2, 3, 4]) expect(sprite.pixel(f, f - 1, 0)).toEqual(WHITE);
    expect(sprite.pixel(2, 0, 0)).toEqual(CLEAR);
    // New frames: other layers were copied, the target layer was cleared before drawing.
    expect(sprite.pixel(3, 5, 5, "BG")).toEqual(RED);
    expect(sprite.pixel(3, 3, 3)).toEqual(CLEAR);
    // Existing frame keeps its art (empty base composes over it).
    expect(sprite.pixel(1, 3, 3)).toEqual(RED);
  });

  it("base 'current' starts each frame from its own pixels and the script owns the region", async () => {
    const { sprite, draw } = setup(4, 4, 2);
    sprite.paint(1, 0, 0, RED);
    sprite.paint(2, 1, 0, RED);
    await draw({
      code: 'replace("#ff0000", "#ffffff"); set(3, 3, "transparent");',
      frames: [1, 2],
      base: "current",
    });
    expect(sprite.pixel(1, 0, 0)).toEqual(WHITE);
    expect(sprite.pixel(1, 1, 0)).toEqual(CLEAR);
    expect(sprite.pixel(2, 1, 0)).toEqual(WHITE);
  });

  it("base <frame> starts every frame from that frame (animating finished art)", async () => {
    const { sprite, draw } = setup(4, 4, 1);
    sprite.paint(1, 0, 0, RED);
    await draw({ code: "move(0, 0, W, H, i, 0);", frames: [1, 2, 3], base: 1 });
    expect(sprite.pixel(1, 0, 0)).toEqual(RED);
    expect(sprite.pixel(2, 1, 0)).toEqual(RED);
    expect(sprite.pixel(2, 0, 0)).toEqual(CLEAR);
    expect(sprite.pixel(3, 2, 0)).toEqual(RED);
  });

  it("draws into a sub-region with region-relative coordinates", async () => {
    const { sprite, draw } = setup(8, 8, 1);
    const outcome = await draw({ code: 'console.log(W, H); set(0, 0, "#fff");', x: 4, y: 2, width: 3, height: 2 });
    expect(outcome.width).toBe(3);
    expect(outcome.logs).toEqual(["3 2"]);
    expect(sprite.pixel(1, 4, 2)).toEqual(WHITE);
  });

  it("selectionOnly limits the write to the user's selection", async () => {
    const { sprite, draw } = setup(4, 1, 1);
    sprite.selection = { rect: { x: 1, y: 0, width: 2, height: 1 }, mask: new Uint8Array([1, 1]) };
    await draw({ code: 'rect(0, 0, W, H, "#fff");', selectionOnly: true });
    expect([0, 1, 2, 3].map((x) => sprite.pixel(1, x, 0)[3])).toEqual([0, 255, 255, 0]);
  });

  it("returns a single preview or a filmstrip for several frames", async () => {
    const { draw } = setup(8, 6, 1);
    const single = await draw({ code: 'set(0, 0, "#fff");', preview: true });
    expect(single.preview).toMatchObject({ width: 8, height: 6 });
    const strip = await draw({ code: 'set(0, 0, "#fff");', frames: [1, 2, 3, 4, 5], preview: true });
    // 4 columns x 2 rows with 1px gaps.
    expect(strip.preview).toMatchObject({ width: 4 * 8 + 3, height: 2 * 6 + 1 });
  });

  it("leaves the sprite untouched when the script fails", async () => {
    const { sprite, draw } = setup(4, 4, 1);
    await expect(draw({ code: "nope();", frames: [1, 2, 3] })).rejects.toThrow(/nope/);
    expect(sprite.frameOps).toEqual([]);
    expect(sprite.writeCalls).toEqual([]);
  });

  it("rejects bad requests with actionable messages", async () => {
    const { draw } = setup(8, 8, 2);
    await expect(draw({ code: "", x: 8 })).rejects.toThrow(/outside the 8x8 canvas/);
    await expect(draw({ code: "", frames: [0] })).rejects.toThrow(/1-based/);
    await expect(draw({ code: "", base: 5 })).rejects.toThrow(/base frame 5 does not exist \(sprite has 2 frames\)/);
    await expect(draw({ code: "", frames: [100] })).rejects.toThrow(/would create 98 frames/);
    await expect(draw({ code: "", frames: Array.from({ length: 33 }, (_, k) => k + 1) })).rejects.toThrow(/At most 32/);
  });
});
