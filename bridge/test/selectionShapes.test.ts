import { describe, expect, it } from "vitest";
import {
  clipRect,
  colorDistance,
  colorMask,
  countSelected,
  ellipseMask,
  maskBounds,
  maskToRects,
  maskToRows,
  opaqueMask,
  type Mask,
} from "../src/canvas/selectionShapes.js";
import { Raster } from "../src/pixel/Raster.js";
import { createRgbaImage, type RgbaImage } from "../src/pixel/RgbaImage.js";

/** Builds an image from rows of single-character color keys. */
function imageFrom(rows: string[], colors: Record<string, number[]>): RgbaImage {
  const img = createRgbaImage(rows[0].length, rows.length);
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => img.data.set(colors[ch] ?? [0, 0, 0, 0], (y * img.width + x) * 4)),
  );
  return img;
}

function maskFrom(rows: string[], x = 0, y = 0): Mask {
  const width = rows[0].length;
  const data = new Uint8Array(width * rows.length);
  rows.forEach((row, ry) => [...row].forEach((ch, rx) => (data[ry * width + rx] = ch === "#" ? 1 : 0)));
  return { rect: { x, y, width, height: rows.length }, data };
}

/** Re-rasterizes rects onto a mask the size of `like` and checks they never overlap. */
function rectsToMask(rects: number[][], like: Mask): Mask {
  const { x: ox, y: oy, width, height } = like.rect;
  const data = new Uint8Array(width * height);
  for (const [x, y, w, h] of rects) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const i = (yy - oy) * width + (xx - ox);
        if (data[i]) throw new Error(`rects overlap at ${xx},${yy}`);
        data[i] = 1;
      }
    }
  }
  return { rect: like.rect, data };
}

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];

describe("clipRect", () => {
  const canvas = { width: 10, height: 8 };

  it("keeps rects inside the canvas", () => {
    expect(clipRect({ x: 1, y: 2, width: 3, height: 4 }, canvas)).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it("cuts the parts outside the canvas", () => {
    expect(clipRect({ x: -2, y: 6, width: 5, height: 5 }, canvas)).toEqual({ x: 0, y: 6, width: 3, height: 2 });
  });

  it("returns null when nothing is left", () => {
    expect(clipRect({ x: 10, y: 0, width: 3, height: 3 }, canvas)).toBeNull();
    expect(clipRect({ x: -5, y: -5, width: 5, height: 5 }, canvas)).toBeNull();
  });
});

describe("ellipseMask", () => {
  it("draws a symmetric 5x5 disc touching every side of its box", () => {
    const mask = ellipseMask({ x: 0, y: 0, width: 5, height: 5 }, { width: 5, height: 5 })!;
    expect(maskToRows(mask)).toEqual([".###.", "#####", "#####", "#####", ".###."]);
  });

  it.each([
    [1, 1],
    [2, 2],
    [3, 5],
    [4, 4],
    [7, 3],
    [8, 6],
    [16, 9],
  ])("matches Raster.ellipse for a %ix%i box", (w, h) => {
    const raster = new Raster(w, h);
    raster.ellipse((w - 1) / 2, (h - 1) / 2, (w - 1) / 2, (h - 1) / 2, "#ffffff");
    const mask = ellipseMask({ x: 0, y: 0, width: w, height: h }, { width: w, height: h })!;
    const expected = Array.from({ length: w * h }, (_, i) => (raster.image.data[i * 4 + 3] > 0 ? 1 : 0));
    expect([...mask.data]).toEqual(expected);
  });

  it("is placed in canvas coordinates and clipped to the canvas", () => {
    const mask = ellipseMask({ x: -2, y: 1, width: 5, height: 5 }, { width: 8, height: 4 })!;
    expect(mask.rect).toEqual({ x: 0, y: 1, width: 3, height: 3 });
    expect(maskToRows(mask)).toEqual(["##.", "###", "###"]);
  });

  it("returns null when the box is off the canvas", () => {
    expect(ellipseMask({ x: 20, y: 20, width: 4, height: 4 }, { width: 8, height: 8 })).toBeNull();
  });
});

describe("colorDistance", () => {
  const px = (rgba: number[]) => new Uint8Array(rgba);

  it("is 0 for identical colors and 100 for black vs white", () => {
    expect(colorDistance(px(RED), 0, [255, 0, 0, 255])).toBe(0);
    expect(colorDistance(px([0, 0, 0, 255]), 0, [255, 255, 255, 255])).toBeCloseTo(100);
  });

  it("treats all fully transparent pixels as equal", () => {
    expect(colorDistance(px([12, 200, 3, 0]), 0, [0, 0, 0, 0])).toBe(0);
  });

  it("counts alpha differences", () => {
    expect(colorDistance(px([255, 0, 0, 0]), 0, [255, 0, 0, 255])).toBe(100);
    expect(colorDistance(px([255, 0, 0, 128]), 0, [255, 0, 0, 255])).toBeCloseTo(50, 0);
  });
});

describe("colorMask", () => {
  const image = imageFrom(["rr..b", "r...b", "..rr.", "..rr."], { r: RED, b: BLUE });

  it("selects every exactly matching pixel by default", () => {
    const mask = colorMask(image, { x: 0, y: 0 }, [255, 0, 0, 255]);
    expect(maskToRows(mask)).toEqual(["##...", "#....", "..##.", "..##."]);
  });

  it("includes near colors within tolerance only", () => {
    const img = imageFrom(["abc"], { a: [200, 0, 0, 255], b: [205, 5, 0, 255], c: [100, 0, 0, 255] });
    expect(maskToRows(colorMask(img, { x: 0, y: 0 }, [200, 0, 0, 255], { tolerance: 0 }))).toEqual(["#.."]);
    expect(maskToRows(colorMask(img, { x: 0, y: 0 }, [200, 0, 0, 255], { tolerance: 3 }))).toEqual(["##."]);
    expect(maskToRows(colorMask(img, { x: 0, y: 0 }, [200, 0, 0, 255], { tolerance: 100 }))).toEqual(["###"]);
  });

  it("selects the transparent background with a transparent color", () => {
    const mask = colorMask(image, { x: 0, y: 0 }, [0, 0, 0, 0]);
    expect(countSelected(mask.data)).toBe(20 - 9);
  });

  it("magic wand: only the 4-connected region around the seed", () => {
    const mask = colorMask(image, { x: 0, y: 0 }, [255, 0, 0, 255], { seed: { x: 3, y: 3 } });
    expect(maskToRows(mask)).toEqual([".....", ".....", "..##.", "..##."]);
  });

  it("magic wand does not leak through diagonals", () => {
    const img = imageFrom(["r.", ".r"], { r: RED });
    const mask = colorMask(img, { x: 0, y: 0 }, [255, 0, 0, 255], { seed: { x: 0, y: 0 } });
    expect(maskToRows(mask)).toEqual(["#.", ".."]);
  });

  it("selects nothing when the seed pixel itself does not match", () => {
    const mask = colorMask(image, { x: 0, y: 0 }, [255, 0, 0, 255], { seed: { x: 4, y: 0 } });
    expect(countSelected(mask.data)).toBe(0);
  });

  it("respects the image origin for seeds and the mask rect", () => {
    const mask = colorMask(image, { x: 10, y: 20 }, [0, 0, 255, 255], { seed: { x: 14, y: 21 } });
    expect(mask.rect).toEqual({ x: 10, y: 20, width: 5, height: 4 });
    expect(maskBounds(mask)).toEqual({ x: 14, y: 20, width: 1, height: 2 });
  });

  it("rejects seeds outside the image", () => {
    expect(() => colorMask(image, { x: 0, y: 0 }, [255, 0, 0, 255], { seed: { x: 5, y: 0 } })).toThrow(/outside/);
  });

  it("flood fills a large area without overflowing the stack", () => {
    const big = createRgbaImage(600, 600);
    const mask = colorMask(big, { x: 0, y: 0 }, [0, 0, 0, 0], { seed: { x: 300, y: 300 } });
    expect(countSelected(mask.data)).toBe(600 * 600);
  });
});

describe("opaqueMask", () => {
  it("selects every pixel with any alpha", () => {
    const img = imageFrom(["a.b", "..c"], { a: RED, b: [1, 2, 3, 1], c: BLUE });
    expect(maskToRows(opaqueMask(img, { x: 0, y: 0 }))).toEqual(["#.#", "..#"]);
  });
});

describe("maskBounds / countSelected", () => {
  it("finds the tight bounds in canvas coordinates", () => {
    const mask = maskFrom([".....", "..#..", "...#.", "....."], 3, 7);
    expect(maskBounds(mask)).toEqual({ x: 5, y: 8, width: 2, height: 2 });
    expect(countSelected(mask.data)).toBe(2);
  });

  it("is undefined for an empty mask", () => {
    expect(maskBounds(maskFrom(["...", "..."]))).toBeUndefined();
  });
});

describe("maskToRects", () => {
  it("returns nothing for an empty mask", () => {
    expect(maskToRects(maskFrom(["...", "..."]))).toEqual([]);
  });

  it("collapses a solid block into one rect", () => {
    expect(maskToRects(maskFrom(["###", "###", "###"], 2, 3))).toEqual([[2, 3, 3, 3]]);
  });

  it("merges only vertically identical runs", () => {
    const rects = maskToRects(maskFrom(["##..", "##..", "###.", "#..#"]));
    expect(rects).toEqual([
      [0, 0, 2, 2],
      [0, 2, 3, 1],
      [0, 3, 1, 1],
      [3, 3, 1, 1],
    ]);
  });

  it("keeps the ellipse payload small", () => {
    const mask = ellipseMask({ x: 0, y: 0, width: 64, height: 64 }, { width: 64, height: 64 })!;
    const rects = maskToRects(mask);
    expect(rects.length).toBeLessThan(64);
    expect([...rectsToMask(rects, mask).data]).toEqual([...mask.data]);
  });

  it("reproduces random masks exactly, without overlaps", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let n = 0; n < 25; n++) {
      const width = 1 + Math.floor(rand() * 20);
      const height = 1 + Math.floor(rand() * 20);
      const data = new Uint8Array(width * height).map(() => (rand() < 0.5 ? 1 : 0));
      const mask: Mask = { rect: { x: 5, y: -3, width, height }, data };
      expect([...rectsToMask(maskToRects(mask), mask).data]).toEqual([...data]);
    }
  });
});

describe("maskToRows", () => {
  it("renders '#' for selected and '.' for unselected pixels", () => {
    expect(maskToRows(maskFrom(["#.", ".#"]))).toEqual(["#.", ".#"]);
  });
});
