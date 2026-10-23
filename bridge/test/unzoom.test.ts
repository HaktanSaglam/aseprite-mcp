import { describe, expect, it } from "vitest";
import { normalizePixelArt } from "../src/pixel/normalize.js";
import { detectGrid, unzoom } from "../src/pixel/unzoom.js";
import { cellStarts, gridSize } from "../src/pixel/upscaleGrid.js";
import { addJpegNoise, addNoise, crop, differingPixels, gridImage, placeOn, randomArt, upscale } from "./fixtures/pixelArt.js";

const SCALES = [2, 3, 4, 7];

/** Upscaled art as a screenshot crop would cut it: the first block columns/rows lose `cut` pixels. */
function cutUpscale(art: ReturnType<typeof randomArt>, scale: number, cutX: number, cutY: number) {
  const big = upscale(art, scale);
  // The far edge is cut too, so both edges have partial blocks.
  return crop(big, cutX, cutY, big.width - cutX - Math.min(scale - 1, 2), big.height - cutY - 1);
}

describe("detectGrid", () => {
  it("finds no grid in detailed 1x art", () => {
    expect(detectGrid([randomArt(40, 30, 1)]).scale).toBe(1);
    expect(detectGrid([randomArt(24, 24, 2, { background: "#1a1c2c" })]).scale).toBe(1);
  });

  it.each(SCALES)("finds scale %i and the offset of a cut-off upscale", (scale) => {
    const art = randomArt(24, 18, 10 + scale);
    for (const [cutX, cutY] of [[0, 0], [1, 0], [0, scale - 1], [scale - 1, 1]]) {
      const grid = detectGrid([cutUpscale(art, scale, cutX, cutY)]);
      expect({ scale: grid.scale, x: grid.offsetX, y: grid.offsetY }).toEqual({
        scale,
        x: (scale - cutX) % scale,
        y: (scale - cutY) % scale,
      });
      expect(grid.fit).toBe(1);
    }
  });

  it("only searches the offset when the scale is forced", () => {
    const image = cutUpscale(randomArt(10, 10, 3), 4, 1, 2);
    expect(detectGrid([image], 4)).toMatchObject({ scale: 4, offsetX: 3, offsetY: 2, fit: 1 });
    expect(detectGrid([image], 1)).toEqual({ scale: 1, offsetX: 0, offsetY: 0, fit: 1 });
  });

  it("combines frames into one grid", () => {
    const frames = [1, 2, 3].map((seed) => upscale(randomArt(12, 12, seed), 3));
    expect(detectGrid(frames).scale).toBe(3);
  });

  it("gives up on an empty or single-color image", () => {
    expect(detectGrid([upscale(gridImage(["...."], {}), 4)]).scale).toBe(1);
    expect(detectGrid([upscale(gridImage(["aaaa", "aaaa"], { a: "#ff0000" }), 4)]).scale).toBe(1);
  });
});

describe("cellStarts / gridSize", () => {
  it("counts partial blocks at both edges", () => {
    expect(cellStarts(10, 4, 0)).toEqual([0, 4, 8, 10]);
    expect(cellStarts(10, 4, 3)).toEqual([0, 3, 7, 10]);
    expect(gridSize(10, 8, { scale: 4, offsetX: 3, offsetY: 0, fit: 1 })).toEqual({ width: 3, height: 2 });
  });
});

describe("normalizePixelArt: exact round trip", () => {
  it.each(SCALES)("brings x%i art back pixel for pixel, cut at any offset", (scale) => {
    const art = randomArt(20, 16, 100 + scale);
    for (const [cutX, cutY] of [[0, 0], [1, 1], [scale - 1, 0]]) {
      const result = normalizePixelArt([cutUpscale(art, scale, cutX, cutY)], { cleanup: false });
      expect(result.grid.scale).toBe(scale);
      expect(result.denoised).toBe(false);
      // The cut edges still hold part of every art pixel, so nothing is lost.
      expect({ width: result.width, height: result.height }).toEqual({ width: art.width, height: art.height });
      expect(differingPixels(result.images[0], art)).toBe(0);
    }
  });

  it.each(SCALES)("brings noisy (JPEG-like) x%i art back exactly", (scale) => {
    const art = randomArt(24, 16, 200 + scale, { background: "#29366f" });
    const noisy = addNoise(cutUpscale(art, scale, 1, scale - 1), 300 + scale);
    const result = normalizePixelArt([noisy], { cleanup: false });
    expect(result.grid).toMatchObject({ scale, offsetX: scale - 1, offsetY: 1 });
    expect(result.denoised).toBe(true);
    expect(differingPixels(result.images[0], art)).toBe(0);
    expect(result.colorsAfter).toBe(result.colorsBefore);
  });

  it.each(SCALES)("brings x%i art saved as a JPEG back exactly", (scale) => {
    const art = randomArt(20, 14, 400 + scale, { background: "#f4f4f4" });
    const result = normalizePixelArt([addJpegNoise(cutUpscale(art, scale, scale - 1, 1), 500 + scale)], { cleanup: false });
    expect(result.grid.scale).toBe(scale);
    expect(differingPixels(result.images[0], art)).toBe(0);
  });

  it("brings noisy art with transparency back exactly", () => {
    const art = randomArt(20, 20, 7);
    const noisy = addNoise(upscale(art, 5), 8, 2.5);
    const result = normalizePixelArt([noisy], { cleanup: false });
    expect(result.grid.scale).toBe(5);
    expect(differingPixels(result.images[0], art)).toBe(0);
  });

  it("keeps a transparent margin around art placed off the grid", () => {
    const art = randomArt(10, 8, 11);
    const canvas = placeOn(upscale(art, 4), 60, 50, 6, 5);
    const result = normalizePixelArt([canvas], { cleanup: false });
    expect(result.grid).toMatchObject({ scale: 4, offsetX: 2, offsetY: 1 });
    // Before the art: a partial block and a whole one on x (6 = 2 + 4), on y (5 = 1 + 4) too.
    expect(differingPixels(crop(result.images[0], 2, 2, 10, 8), art)).toBe(0);
  });

  it("leaves 1x art alone", () => {
    const art = randomArt(32, 24, 5);
    const result = normalizePixelArt([art], { cleanup: false });
    expect(result.grid.scale).toBe(1);
    expect(differingPixels(result.images[0], art)).toBe(0);
  });
});

describe("normalizePixelArt: clean-up steps", () => {
  const legend = { a: "#ff0000", b: "#00ff00", h: "#0000ff60", k: "#000000" };

  it("snaps semi-transparent pixels unless binaryAlpha is false", () => {
    const art = upscale(gridImage(["aab.", "aahb", "kkkk"], legend), 3);
    const snapped = normalizePixelArt([art], { scale: 3, cleanup: false });
    expect(snapped.alphaSnapped).toBe(1);
    expect([...snapped.images[0].data.subarray(4 * 6, 4 * 6 + 4)]).toEqual([0, 0, 0, 0]);
    const kept = normalizePixelArt([art], { scale: 3, cleanup: false, binaryAlpha: false });
    expect([...kept.images[0].data.subarray(4 * 6, 4 * 6 + 4)]).toEqual([0, 0, 255, 0x60]);
  });

  it("does not believe a grid that a few edges fit by chance", () => {
    // 1x art whose only edges happen to sit on odd columns and rows.
    const icon = gridImage(["kkkk", "kaak", "kaak", "kkkk"], legend);
    expect(normalizePixelArt([icon]).grid.scale).toBe(1);
  });

  it("limits colors with one palette for all frames and removes stray pixels", () => {
    const frames = [1, 2].map((seed) => upscale(randomArt(16, 16, seed, { colors: 10 }), 2));
    const result = normalizePixelArt(frames, { maxColors: 4, cleanup: false });
    expect(result.colorsBefore).toBe(10);
    expect(result.colorsAfter).toBeLessThanOrEqual(4);
    expect(result.palette).toHaveLength(4);

    const stray = upscale(gridImage(["k...", "....", "..aa", "..aa"], legend), 3);
    const cleaned = normalizePixelArt([stray], { scale: 3 });
    expect(cleaned.removed).toBe(1);
    expect(cleaned.images[0].data[3]).toBe(0);
  });

  it("validates its options", () => {
    const art = randomArt(4, 4, 1);
    expect(() => normalizePixelArt([art], { scale: 2.5 })).toThrow(/positive integer/);
    expect(() => normalizePixelArt([art], { maxColors: 0 })).toThrow(/positive integer/);
  });
});

describe("unzoom", () => {
  it("copies the images for scale 1", () => {
    const art = randomArt(4, 4, 1);
    const { images } = unzoom([art], { scale: 1, offsetX: 0, offsetY: 0, fit: 1 });
    expect(images[0].data).not.toBe(art.data);
    expect(differingPixels(images[0], art)).toBe(0);
  });

  it("is fast enough for a 512x512 import", () => {
    const big = addNoise(upscale(randomArt(64, 64, 9), 8), 1);
    const started = performance.now();
    const result = normalizePixelArt([big]);
    expect(result.grid.scale).toBe(8);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
