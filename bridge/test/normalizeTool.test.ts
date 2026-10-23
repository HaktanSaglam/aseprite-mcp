import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerEffectTools } from "../src/mcp/tools/effects.js";
import type { RgbaImage } from "../src/pixel/RgbaImage.js";
import { FakeGateway } from "./fakes/FakeGateway.js";
import { toolHarness, type ToolHarness } from "./fakes/toolHarness.js";
import { addJpegNoise, crop, differingPixels, gridImage, placeOn, randomArt, upscale } from "./fixtures/pixelArt.js";

let h: ToolHarness;
let gw: FakeGateway;

beforeEach(async () => {
  gw = new FakeGateway();
  h = await toolHarness([registerEffectTools], gw);
});
afterEach(() => h.close());

async function put(image: RgbaImage, frame = 1, layer = "Layer 1"): Promise<void> {
  await gw.writeImages([{ x: 0, y: 0, image, frame, layer }]);
  gw.calls.length = 0;
}

const writes = () => gw.callsOf("writeImages").length;

describe("normalize_pixel_art", () => {
  it("shrinks upscaled art to 1x at the top-left and names the crop that finishes it", async () => {
    const art = randomArt(10, 8, 1);
    gw.addSprite({ width: 44, height: 36 });
    await put(placeOn(upscale(art, 4), 44, 36, 0, 0));

    const result = await h.call("normalize_pixel_art", { cleanup: false });
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/^Detected 4x upscaling \(grid offset 0, 0; 100% of the color edges on the grid\): 44x36 became 11x9 at \(0, 0\) on the active layer, frame 1\./);
    expect(result.text).toMatch(/crop it with edit_sprite \{action: "crop", x: 0, y: 0, width: 11, height: 9\}/);
    const layer = gw.layerImage("Layer 1");
    expect(differingPixels(crop(layer, 0, 0, 10, 8), art)).toBe(0);
    expect(differingPixels(crop(layer, 11, 0, 33, 36), crop(layer, 100, 100, 33, 36))).toBe(0);
    expect(writes()).toBe(1);

    await gw.undo(1);
    expect(differingPixels(gw.layerImage("Layer 1"), placeOn(upscale(art, 4), 44, 36, 0, 0))).toBe(0);
  });

  it("recovers a noisy JPEG-like import and limits its colors", async () => {
    const art = randomArt(16, 12, 4, { background: "#f4f4f4" });
    gw.addSprite({ width: 50, height: 37 });
    await put(addJpegNoise(crop(upscale(art, 3), 1, 0, 50, 37), 9));

    const exact = await h.call("normalize_pixel_art", { cleanup: false });
    expect(exact.text).toMatch(/Detected 3x upscaling \(grid offset 2, 0;/);
    expect(exact.text).toMatch(/noisy source \(JPEG-like\)/i);
    expect(differingPixels(crop(gw.layerImage("Layer 1"), 0, 0, 16, 12), art)).toBe(0);

    await gw.undo(1);
    const limited = await h.call("normalize_pixel_art", { maxColors: 4 });
    expect(limited.text).toMatch(/colors limited from 9 to 4/);
  });

  it("uses one grid for every frame in a single undo step", async () => {
    gw.addSprite({ width: 24, height: 24, frames: 2 });
    const frames = [randomArt(8, 8, 1), randomArt(8, 8, 2)];
    await put(upscale(frames[0], 3), 1);
    await put(upscale(frames[1], 3), 2);
    const result = await h.call("normalize_pixel_art", { frames: "all", cleanup: false });
    expect(result.text).toMatch(/frames 1-2/);
    expect(writes()).toBe(1);
    for (const f of [1, 2]) expect(differingPixels(crop(gw.layerImage("Layer 1", f), 0, 0, 8, 8), frames[f - 1])).toBe(0);
  });

  it("with selectionOnly works on the selection and writes at its top-left", async () => {
    const art = randomArt(10, 8, 3);
    gw.addSprite({ width: 40, height: 40 });
    await put(placeOn(upscale(art, 2), 40, 40, 10, 12));
    gw.fillRect({ x: 0, y: 0, width: 2, height: 2, color: "#ff0000" });
    await gw.setSelection("replace", [[10, 12, 20, 16]]);
    gw.calls.length = 0;

    const result = await h.call("normalize_pixel_art", { selectionOnly: true, cleanup: false });
    expect(result.text).toMatch(/20x16 became 10x8 at \(10, 12\)/);
    expect(result.text).not.toMatch(/crop it/);
    const layer = gw.layerImage("Layer 1");
    expect(differingPixels(crop(layer, 10, 12, 10, 8), art)).toBe(0);
    expect(gw.pixel("Layer 1", 0, 0)).toEqual([255, 0, 0, 255]);
    expect(gw.pixel("Layer 1", 25, 25)).toEqual([0, 0, 0, 0]);
  });

  it("only cleans up art that is already 1x", async () => {
    gw.addSprite({ width: 8, height: 8 });
    await put(gridImage(["k.......", "........", "..aaa...", "..aaa...", "..aab...", "........", "........", "........"], { k: "#000000", a: "#ff0000", b: "#00ff00" }));
    const result = await h.call("normalize_pixel_art");
    expect(result.text).toMatch(/^No integer upscaling found on the active layer, frame 1/);
    expect(result.text).toMatch(/1 isolated pixel removed/);
    expect(gw.pixel("Layer 1", 0, 0)).toEqual([0, 0, 0, 0]);
    expect(gw.pixel("Layer 1", 2, 2)).toEqual([255, 0, 0, 255]);
  });

  it("warns when a forced scale does not fit the art", async () => {
    gw.addSprite({ width: 30, height: 30 });
    await put(placeOn(upscale(randomArt(10, 10, 6), 3), 30, 30, 0, 0));
    const result = await h.call("normalize_pixel_art", { scale: 4, cleanup: false });
    expect(result.text).toMatch(/^Downscaled 4x/);
    expect(result.text).toMatch(/Only \d+% of the edges line up with a 4px grid/);
  });

  it("reports an empty layer without writing", async () => {
    gw.addSprite({ width: 8, height: 8 });
    expect((await h.call("normalize_pixel_art")).text).toBe("Nothing to normalize: the active layer, frame 1 is empty.");
    expect(writes()).toBe(0);
  });

  it("accepts the params the Tools tab sends and rejects bad ones", async () => {
    gw.addSprite({ width: 16, height: 16 });
    await put(upscale(randomArt(8, 8, 2), 2));
    const ok = await h.call("normalize_pixel_art", {
      scale: "auto",
      maxColors: 16,
      binaryAlpha: true,
      cleanup: true,
      layer: "Layer 1",
      frames: "current",
      selectionOnly: false,
    });
    expect(ok.isError).toBe(false);
    expect(await h.error("normalize_pixel_art", { scale: 0 })).toMatch(/scale/);
    expect(await h.error("normalize_pixel_art", { scale: "big" })).toMatch(/scale/);
    expect(await h.error("normalize_pixel_art", { maxColors: 1 })).toMatch(/maxColors/);
  });
});
