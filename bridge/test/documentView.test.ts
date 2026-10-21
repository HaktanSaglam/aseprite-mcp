import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerPixelTools } from "../src/mcp/tools/pixels.js";
import { FakeGateway } from "./fakes/FakeGateway.js";
import { pngSize, toolHarness, type ToolHarness } from "./fakes/toolHarness.js";

let h: ToolHarness;
let gw: FakeGateway;

beforeEach(async () => {
  gw = new FakeGateway();
  h = await toolHarness([registerPixelTools], gw);
});
afterEach(() => h.close());

describe("view_sprite: single frame (unchanged default)", () => {
  it("shows the composited sprite in one round trip", async () => {
    gw.addSprite({ width: 16, height: 16 });
    const result = await h.call("view_sprite");
    expect(result.isError).toBe(false);
    expect(result.text).toBe("16x16 sprite shown at 32x");
    expect(pngSize(result.content)).toEqual({ width: 512, height: 512 });
    expect(gw.calls.map((c) => c.method)).toEqual(["readImage"]);
    expect(gw.callsOf("readImage")[0][0]).toMatchObject({ flattened: true });
  });

  it("shows a single layer without flattening", async () => {
    gw.addSprite({ width: 8, height: 8, layers: ["Top"] });
    await h.call("view_sprite", { layer: "Top", frame: 1 });
    expect(gw.callsOf("readImage")[0][0]).toMatchObject({ layer: "Top", frame: 1, flattened: false });
  });
});

describe("view_sprite: region", () => {
  beforeEach(() => {
    gw.addSprite({ width: 64, height: 32, frames: 2 });
  });

  it("zooms into a part of the canvas", async () => {
    const result = await h.call("view_sprite", { region: { x: 8, y: 4, width: 4, height: 4 } });
    expect(gw.callsOf("readImage")[0][0]).toMatchObject({ x: 8, y: 4, width: 4, height: 4, flattened: true });
    expect(pngSize(result.content)).toEqual({ width: 512, height: 512 });
    expect(result.text).toBe("region (8, 4) 4x4 of 64x32 sprite, frame 1 shown at 128x");
  });

  it("clips the region to the canvas and refuses one fully outside", async () => {
    await h.call("view_sprite", { region: { x: 60, y: -2, width: 10, height: 6 }, frame: 2 });
    expect(gw.callsOf("readImage")[0][0]).toMatchObject({ x: 60, y: 0, width: 4, height: 4, frame: 2 });
    expect(await h.error("view_sprite", { region: { x: 64, y: 0, width: 4, height: 4 } })).toMatch(
      /region lies outside the 64x32 canvas/,
    );
  });
});

describe("view_sprite: contact sheet", () => {
  beforeEach(async () => {
    gw.addSprite({ width: 16, height: 16, frames: 4 });
    await gw.frameOp({ op: "duration", frames: [4], durationMs: 300 });
    await gw.tagOp({ op: "add", name: "walk", from: 1, to: 4, direction: "pingpong" });
  });

  it("lays out all frames left to right with durations and tags", async () => {
    const result = await h.call("view_sprite", { frames: "all" });
    expect(result.isError).toBe(false);
    // 4 frames of 16px with 1px gaps = 67x16, scaled to fit 768 → 11x
    expect(pngSize(result.content)).toEqual({ width: 67 * 11, height: 16 * 11 });
    expect(result.text).toBe(
      "Frames 1-4 of the 16x16 sprite, 4 per row (left to right, 1px gaps), shown at 11x. " +
        "Durations: 1-3: 100ms, 4: 300ms. Tags: walk 1-4 pingpong.",
    );
    expect(gw.callsOf("readImage").map((args) => (args[0] as { frame: number }).frame)).toEqual([1, 2, 3, 4]);
  });

  it("shows a chosen subset of frames, cropped to a region", async () => {
    const result = await h.call("view_sprite", { frames: [1, 3], region: { x: 0, y: 0, width: 8, height: 8 }, layer: "Layer 1" });
    expect(result.text).toMatch(/^Frames 1, 3 of the region \(0, 0\) 8x8 of 16x16 sprite, 2 per row/);
    expect(gw.callsOf("readImage")[0][0]).toMatchObject({ width: 8, height: 8, layer: "Layer 1", flattened: false });
  });

  it("treats frames: current like a single view", async () => {
    const result = await h.call("view_sprite", { frames: "current" });
    expect(result.text).toBe("16x16 sprite shown at 32x");
  });

  it("rejects frame together with frames and out-of-range frames", async () => {
    expect(await h.error("view_sprite", { frame: 1, frames: "all" })).toMatch(/either frame or frames/);
    expect(await h.error("view_sprite", { frames: [9] })).toMatch(/Frame 9 out of range \(sprite has 4 frames\)/);
  });
});

describe("view_sprite: sheet limits", () => {
  it("wraps wide sprites into rows", async () => {
    gw.addSprite({ width: 300, height: 10, frames: 5 });
    const result = await h.call("view_sprite", { frames: "all" });
    // 1024px fit 3 frames of 300px per row → 2 rows
    expect(result.text).toMatch(/3 per row/);
    expect(pngSize(result.content)).toEqual({ width: 3 * 300 + 2, height: 2 * 10 + 1 });
  });

  it("refuses sheets that would be too tall", async () => {
    gw.addSprite({ width: 600, height: 600, frames: 3 });
    expect(await h.error("view_sprite", { frames: "all" })).toMatch(/3 frames of 600x600 do not fit in one preview; pass fewer frames or a region/);
  });

  it("caps the number of frames", async () => {
    gw.addSprite({ width: 2, height: 2, frames: 65 });
    expect(await h.error("view_sprite", { frames: "all" })).toMatch(/65 frames at once is too many/);
  });
});
