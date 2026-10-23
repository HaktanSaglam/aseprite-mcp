import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { analyzeImage, captureCanvas, describeCanvas, freshSnapshot } from "../src/chat/canvasContext.js";
import { createRgbaImage } from "../src/pixel/RgbaImage.js";
import { FakeGateway, spriteInfo } from "./chatFakes.js";

describe("analyzeImage", () => {
  it("reports an empty image", () => {
    expect(analyzeImage(createRgbaImage(4, 4))).toEqual({ isEmpty: true, colors: [], totalColors: 0 });
  });

  it("finds the content bounds and colors, most used first", () => {
    const image = createRgbaImage(8, 8);
    const put = (x: number, y: number, rgba: number[]) => image.data.set(rgba, (y * 8 + x) * 4);
    put(2, 1, [255, 0, 0, 255]);
    put(3, 1, [255, 0, 0, 255]);
    put(5, 6, [0, 128, 255, 128]); // partially transparent still counts
    put(0, 0, [9, 9, 9, 0]); // fully transparent is ignored
    expect(analyzeImage(image)).toEqual({
      isEmpty: false,
      bounds: { x: 2, y: 1, width: 4, height: 6 },
      colors: ["#ff0000", "#0080ff"],
      totalColors: 2,
    });
  });

  it("caps the listed colors but counts all of them", () => {
    const image = createRgbaImage(40, 1);
    for (let x = 0; x < 40; x++) image.data.set([x, 0, 0, 255], x * 4);
    const summary = analyzeImage(image);
    expect(summary.totalColors).toBe(40);
    expect(summary.colors).toHaveLength(24);
  });
});

describe("captureCanvas", () => {
  it("describes content and attaches a preview when asked", async () => {
    const gateway = new FakeGateway();
    const info = gateway.addSprite({ id: 2 }, true);
    const snapshot = await captureCanvas(gateway, info.id, { preview: "always" });
    expect(snapshot.content).toMatchObject({ isEmpty: false, bounds: { x: 3, y: 4, width: 8, height: 7 } });
    expect(snapshot.content?.colors).toEqual(["#ff0000", "#0000ff"]);
    const png = PNG.sync.read(Buffer.from(snapshot.preview!.image.base64, "base64"));
    expect(png.width).toBe(512); // 32 px upscaled 16x
    expect(snapshot.preview!.note).toMatch(/frame 1 is attached \(upscaled 16x/);
    expect(gateway.callsOf("readImage")[0].args[0]).toMatchObject({ sprite: 2, flattened: true, frame: 1 });
  });

  it("skips the preview of an empty canvas in if_content mode", async () => {
    const gateway = new FakeGateway();
    gateway.addSprite({ id: 2 });
    const snapshot = await captureCanvas(gateway, 2, { preview: "if_content" });
    expect(snapshot.content?.isEmpty).toBe(true);
    expect(snapshot.preview).toBeUndefined();
  });

  it("shows every frame side by side for animations", async () => {
    const gateway = new FakeGateway();
    const frames = [1, 2, 3].map((index) => ({ index, durationMs: 100 }));
    gateway.addSprite({ id: 2, frames, activeFrame: 2 }, true);
    const snapshot = await captureCanvas(gateway, 2, { preview: "always", allFrames: true });
    expect(snapshot.preview!.note).toMatch(/frames 1-3/);
    expect(gateway.callsOf("readImage").map((c) => (c.args[0] as { frame: number }).frame)).toEqual([2, 1, 3]);
  });

  it("does not read huge canvases", async () => {
    const gateway = new FakeGateway();
    gateway.addSprite({ id: 2, width: 1024, height: 1024 });
    const snapshot = await captureCanvas(gateway, 2, { preview: "always" });
    expect(snapshot.content).toBeUndefined();
    expect(gateway.callsOf("readImage")).toHaveLength(0);
    expect(describeCanvas(snapshot)).toMatch(/not analysed \(large canvas\)/);
  });

  it("includes the sprite palette only on request", async () => {
    const gateway = new FakeGateway();
    gateway.addSprite({ id: 2 });
    expect((await captureCanvas(gateway, 2, { preview: "never" })).palette).toBeUndefined();
    const snapshot = await captureCanvas(gateway, 2, { preview: "never", palette: true });
    expect(describeCanvas(snapshot)).toMatch(/sprite palette \(3\): #000000 #ffffff #ff0000/);
  });
});

describe("describeCanvas", () => {
  it("summarises everything the model would otherwise ask get_sprite_info for", () => {
    const info = spriteInfo(9, {
      filename: "/Users/me/art/hero.aseprite",
      width: 64,
      height: 48,
      frames: [
        { index: 1, durationMs: 80 },
        { index: 2, durationMs: 120 },
      ],
      layers: [
        { ...spriteInfo(1).layers[0], name: "Background", path: "Background" },
        { ...spriteInfo(1).layers[0], name: "Body", path: "Body", isVisible: false, isEditable: false },
      ],
      activeLayer: "Background",
      activeFrame: 2,
      tags: [{ name: "walk", from: 1, to: 2, direction: "pingpong", repeats: 0 }],
      selection: { x: 1, y: 2, width: 3, height: 4 },
    });
    const text = describeCanvas({ info, content: { isEmpty: false, bounds: { x: 2, y: 3, width: 10, height: 5 }, colors: ["#112233"], totalColors: 30 } });
    expect(text).toMatch(/sprite #9 "hero\.aseprite"/);
    expect(text).toMatch(/don't need get_sprite_info/);
    expect(text).toMatch(/size 64x48 px, rgb color mode, palette of 32 colors/);
    expect(text).toMatch(/frames: 2 \(80-120 ms\), active frame 2/);
    expect(text).toMatch(/"Background" \(active\), "Body" \(hidden, locked\)/);
    expect(text).toMatch(/tags: "walk" 1-2 pingpong/);
    expect(text).toMatch(/selection: x=1 y=2 3x4/);
    expect(text).toMatch(/frame 2 has pixels within x=2-11, y=3-7; 30 colors, most used first: #112233 \.\.\./);
  });

  it("calls an empty fresh sprite empty", () => {
    expect(describeCanvas(freshSnapshot(spriteInfo(1)))).toMatch(/frame 1 is empty \(fully transparent\)/);
  });
});
