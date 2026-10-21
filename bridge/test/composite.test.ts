import { describe, expect, it } from "vitest";
import { compose, maskFilter } from "../src/pixel/composite.js";
import { createRgbaImage } from "../src/pixel/RgbaImage.js";

function image(pixels: number[][], width: number) {
  const img = createRgbaImage(width, pixels.length / width);
  pixels.forEach((p, i) => img.data.set(p, i * 4));
  return img;
}

describe("compose", () => {
  const base = image([[10, 10, 10, 255], [20, 20, 20, 255]], 2);

  it("over keeps old pixels under transparent ones", () => {
    const top = image([[0, 0, 0, 0], [255, 0, 0, 255]], 2);
    expect([...compose(base, top, "over").data]).toEqual([10, 10, 10, 255, 255, 0, 0, 255]);
  });

  it("replace erases with transparent pixels", () => {
    const top = image([[0, 0, 0, 0], [255, 0, 0, 255]], 2);
    expect([...compose(base, top, "replace").data]).toEqual([0, 0, 0, 0, 255, 0, 0, 255]);
  });

  it("over blends partial alpha", () => {
    const top = image([[255, 255, 255, 128], [0, 0, 0, 0]], 2);
    const out = compose(base, top, "over").data;
    expect(out[0]).toBeGreaterThan(120);
    expect(out[0]).toBeLessThan(140);
    expect(out[3]).toBe(255);
  });

  it("filter limits changes to the mask, in canvas coordinates", () => {
    const top = image([[255, 0, 0, 255], [255, 0, 0, 255]], 2);
    // mask covers only canvas pixel (6, 3); images sit at (5, 3)
    const filter = maskFilter({ x: 6, y: 3, width: 1, height: 1 }, new Uint8Array([1]));
    const out = compose(base, top, "replace", { x: 5, y: 3 }, filter);
    expect([...out.data]).toEqual([10, 10, 10, 255, 255, 0, 0, 255]);
  });
});
