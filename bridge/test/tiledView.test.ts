import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerPixelTools } from "../src/mcp/tools/pixels.js";
import { seamReport, seamVisible, tileImage } from "../src/pixel/tiling.js";
import { FakeGateway } from "./fakes/FakeGateway.js";
import { pngSize, toolHarness, type ToolHarness } from "./fakes/toolHarness.js";
import { gridImage } from "./fixtures/pixelArt.js";

const LEGEND = { a: "#38b764", b: "#257179", c: "#1a1c2c", d: "#f4f4f4", e: "#a7f070", f: "#29366f" };
// Stripes that wrap: the last column continues into the first like any two neighbours.
const SEAMLESS = ["abab", "baba", "abab", "baba"];
// Dark on the left, light on the right: the wrap puts the lightest next to the darkest.
const GRADIENT = ["cfbe", "cfbe", "cfbe", "cfbe"];

describe("tileImage", () => {
  it("repeats the image edge to edge", () => {
    const tiled = tileImage(gridImage(["ab"], LEGEND), 3, 2);
    expect([tiled.width, tiled.height]).toEqual([6, 2]);
    const row = (y: number) => Array.from({ length: 6 }, (_, x) => tiled.data[(y * 6 + x) * 4 + 1]);
    expect(row(0)).toEqual(row(1));
    expect(row(0)).toEqual([0xb7, 0x71, 0xb7, 0x71, 0xb7, 0x71]);
  });
});

describe("seamReport", () => {
  it("scores a wrapping pattern as seamless on both axes", () => {
    const report = seamReport(gridImage(SEAMLESS, LEGEND));
    expect(report.horizontal.seam).toBeCloseTo(report.horizontal.interior, 5);
    expect(seamVisible(report.horizontal)).toBe(false);
    expect(seamVisible(report.vertical)).toBe(false);
  });

  it("finds the seam of a gradient only across its direction", () => {
    const report = seamReport(gridImage(GRADIENT, LEGEND));
    expect(seamVisible(report.horizontal)).toBe(true);
    expect(report.horizontal.seam).toBeGreaterThan(report.horizontal.interior * 2);
    expect(report.vertical).toEqual({ seam: 0, interior: 0 });
    expect(seamVisible(report.vertical)).toBe(false);
  });

  it("counts transparent against opaque as a full jump", () => {
    const report = seamReport(gridImage(["a..", "a.."], LEGEND));
    expect(report.horizontal).toEqual({ seam: 1, interior: 0.5 });
    expect(report.vertical).toEqual({ seam: 0, interior: 0 });
  });
});

describe("view_sprite tiled", () => {
  let h: ToolHarness;
  let gw: FakeGateway;
  beforeEach(async () => {
    gw = new FakeGateway();
    h = await toolHarness([registerPixelTools], gw);
  });
  afterEach(() => h.close());

  function paint(rows: string[], frame = 1): void {
    rows.forEach((row, y) =>
      [...row].forEach((ch, x) => {
        if (ch !== ".") gw.fillRect({ x, y, width: 1, height: 1, color: LEGEND[ch as keyof typeof LEGEND], frame });
      }),
    );
  }

  it("shows the tile 3x3 and calls a wrapping tile seamless", async () => {
    gw.addSprite({ width: 4, height: 4 });
    paint(SEAMLESS);
    const result = await h.call("view_sprite", { tiled: true });
    expect(pngSize(result.content)).toEqual({ width: 12 * 64, height: 12 * 64 });
    expect(result.text).toMatch(/^4x4 sprite tiled 3x3, shown at 64x\. Seam score/);
    expect(result.text).toMatch(/left\/right [\d.]+ \(inside [\d.]+\): seamless, top\/bottom [\d.]+ \(inside [\d.]+\): seamless\.$/);
    expect(gw.calls.map((c) => c.method)).toEqual(["readImage"]);
  });

  it("names a visible seam and how to fix it", async () => {
    gw.addSprite({ width: 4, height: 4, frames: 2 });
    paint(GRADIENT, 2);
    const result = await h.call("view_sprite", { tiled: true, frame: 2, region: { x: 0, y: 0, width: 4, height: 4 } });
    expect(result.text).toMatch(/^region \(0, 0\) 4x4 of 4x4 sprite, frame 2 tiled 3x3/);
    expect(result.text).toMatch(/left\/right [\d.]+ \(inside [\d.]+\): visible seam/);
    expect(result.text).toMatch(/transform_layer \{op: "shift", dx: 2, dy: 2, wrap: true\}/);
  });

  it("refuses an animation sheet and images too big to tile", async () => {
    gw.addSprite({ width: 400, height: 8, frames: 2 });
    expect(await h.error("view_sprite", { tiled: true, frames: "all" })).toMatch(/tiled shows one frame/);
    expect(await h.error("view_sprite", { tiled: true })).toMatch(/too big to show 3x3; pass a region/);
  });
});

describe("write_pixels preview", () => {
  let h: ToolHarness;
  let gw: FakeGateway;
  beforeEach(async () => {
    gw = new FakeGateway();
    gw.addSprite({ width: 16, height: 8, frames: 2, layers: ["Top"] });
    h = await toolHarness([registerPixelTools], gw);
  });
  afterEach(() => h.close());

  it("returns the whole composited frame as an image, like draw_script", async () => {
    const result = await h.call("write_pixels", { palette: { k: "#000000" }, rows: ["kk"], frame: 2, x: 3 });
    expect(JSON.parse(result.content[0].text!)).toEqual({ ok: true, width: 2, height: 1 });
    expect(pngSize(result.content)).toEqual({ width: 16 * 32, height: 8 * 32 });
    const read = gw.callsOf("readImage").at(-1)![0];
    expect(read).toMatchObject({ frame: 2, flattened: true, sprite: 1 });
    expect(gw.callsOf("writeImages")).toHaveLength(1);
  });

  it("skips the image with preview: false", async () => {
    const result = await h.call("write_pixels", { palette: { k: "#000000" }, rows: ["k"], preview: false });
    expect(result.content.map((c) => c.type)).toEqual(["text"]);
    expect(gw.callsOf("readImage").some((args) => (args[0] as { flattened?: boolean }).flattened)).toBe(false);
  });
});
