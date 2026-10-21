import { describe, expect, it } from "vitest";
import { formatHex, parseHex } from "../src/pixel/color.js";
import { binarizeAlpha, extractPalette, mapToPalette, reduceColors } from "../src/pixel/quantize.js";
import { createRgbaImage, type RgbaImage } from "../src/pixel/RgbaImage.js";

/** Builds an image from rows of space-separated colors; "." is transparent. */
function img(rows: string[]): RgbaImage {
  const cells = rows.map((r) => r.trim().split(/\s+/));
  const image = createRgbaImage(cells[0].length, cells.length);
  cells.forEach((row, y) =>
    row.forEach((c, x) => image.data.set(c === "." ? [0, 0, 0, 0] : parseHex(c), (y * image.width + x) * 4)),
  );
  return image;
}

function colorsOf(image: RgbaImage): Set<string> {
  const set = new Set<string>();
  for (let o = 0; o < image.data.length; o += 4) {
    if (image.data[o + 3] > 0) set.add(formatHex(image.data[o], image.data[o + 1], image.data[o + 2], image.data[o + 3]));
  }
  return set;
}

function gradient(width: number): RgbaImage {
  const image = createRgbaImage(width, 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < width; x++) image.data.set([x, x, 255 - x, 255], (y * width + x) * 4);
  }
  return image;
}

describe("binarizeAlpha", () => {
  it("snaps alpha to 0 or 255 and clears hidden color", () => {
    const image = createRgbaImage(3, 1);
    image.data.set([10, 20, 30, 127, 40, 50, 60, 128, 70, 80, 90, 0]);
    expect([...binarizeAlpha(image).data]).toEqual([0, 0, 0, 0, 40, 50, 60, 255, 0, 0, 0, 0]);
  });
});

describe("extractPalette", () => {
  it("returns the exact colors when there are few enough, darkest first", () => {
    const image = img(["#ffffff #ff0000 .", "#000000 #ff0000 #ff0000"]);
    expect(extractPalette([image], 8)).toEqual(["#000000", "#ff0000", "#ffffff"]);
  });

  it("returns an empty palette for an empty image", () => {
    expect(extractPalette([createRgbaImage(4, 4)], 4)).toEqual([]);
  });

  it("respects maxColors and only picks colors that exist in the image", () => {
    const image = gradient(256);
    const palette = extractPalette([image], 6);
    expect(palette).toHaveLength(6);
    const existing = colorsOf(image);
    for (const c of palette) expect(existing.has(c)).toBe(true);
  });

  it("is deterministic", () => {
    const image = gradient(200);
    expect(extractPalette([image], 5)).toEqual(extractPalette([image], 5));
  });

  it("keeps a small but distinct color instead of averaging it away", () => {
    // 60 pixels of near-identical blues and 4 red pixels: red must survive a 2-color reduction.
    const rows = [];
    for (let y = 0; y < 8; y++) {
      const row = [];
      for (let x = 0; x < 8; x++) row.push(y === 0 && x < 4 ? "#ff0000" : `#0000${(200 + x + y).toString(16)}`);
      rows.push(row.join(" "));
    }
    const palette = extractPalette([img(rows)], 2);
    expect(palette).toContain("#ff0000");
  });

  it("builds one palette across several images", () => {
    const a = img(["#ff0000 #ff0000"]);
    const b = img(["#0000ff #0000ff"]);
    expect(extractPalette([a, b], 4).sort()).toEqual(["#0000ff", "#ff0000"]);
  });

  it("only counts included pixels", () => {
    const image = img(["#ff0000 #00ff00"]);
    expect(extractPalette([image], 4, (x) => x === 1)).toEqual(["#00ff00"]);
  });

  it("handles photo-like images with many colors", () => {
    const image = createRgbaImage(256, 128);
    for (let i = 0; i < 256 * 128; i++) image.data.set([i & 255, (i >> 8) * 2, (i * 7) & 255, 255], i * 4);
    const palette = extractPalette([image], 16);
    expect(palette.length).toBeGreaterThan(8);
    expect(palette.length).toBeLessThanOrEqual(16);
  });
});

describe("mapToPalette", () => {
  const bw = ["#000000", "#ffffff"];

  it("maps to the perceptually nearest color, keeps transparency, snaps alpha", () => {
    const image = img(["#202020 #e0e0e0 .", "#808080c0 #10101040 #ffffff"]);
    const out = mapToPalette(image, bw);
    expect([...out.data.subarray(0, 12)]).toEqual([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0]);
    // #808080 is perceptually closer to white than black in OKLab (L≈0.6).
    expect([...out.data.subarray(12, 16)]).toEqual([255, 255, 255, 255]);
    expect([...out.data.subarray(16, 20)]).toEqual([0, 0, 0, 0]);
  });

  it("ignores fully transparent palette entries and duplicates", () => {
    const out = mapToPalette(img(["#010101"]), ["#00000000", "#ff0000", "#000000", "#000000"]);
    expect([...out.data]).toEqual([0, 0, 0, 255]);
  });

  it("refuses a palette with no opaque colors", () => {
    expect(() => mapToPalette(img(["#ffffff"]), ["#00000000"])).toThrow(/no opaque colors/);
  });

  it("ordered dither mixes the two nearest colors in a Bayer pattern", () => {
    const image = createRgbaImage(8, 8);
    for (let i = 0; i < 64; i++) image.data.set([119, 119, 119, 255], i * 4);
    const out = mapToPalette(image, bw, "ordered");
    let white = 0;
    for (let i = 0; i < 64; i++) if (out.data[i * 4] === 255) white++;
    expect(white).toBeGreaterThan(16);
    expect(white).toBeLessThan(48);
    // The pattern repeats every 4 pixels.
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) expect(out.data[(y * 8 + x) * 4]).toBe(out.data[((y + 4) * 8 + x + 4) * 4]);
    }
  });

  it("ordered dither never dithers colors that are already in the palette", () => {
    const image = img(["#000000 #ffffff #000000 #ffffff"]);
    expect([...mapToPalette(image, bw, "ordered").data]).toEqual([...image.data]);
  });

  it("floyd dither preserves average brightness and does not leak into transparent pixels", () => {
    const image = createRgbaImage(16, 16);
    for (let i = 0; i < 256; i++) image.data.set(i % 16 === 0 ? [0, 0, 0, 0] : [119, 119, 119, 255], i * 4);
    const out = mapToPalette(image, bw, "floyd");
    let white = 0;
    let opaque = 0;
    for (let i = 0; i < 256; i++) {
      if (i % 16 === 0) {
        expect(out.data[i * 4 + 3]).toBe(0);
        continue;
      }
      opaque++;
      if (out.data[i * 4] === 255) white++;
    }
    // #777777 is L≈0.57 in OKLab, so a bit more than half the pixels end up white.
    expect(white / opaque).toBeGreaterThan(0.4);
    expect(white / opaque).toBeLessThan(0.75);
  });
});

describe("reduceColors", () => {
  it("returns the palette and an image using only it", () => {
    const { image, palette } = reduceColors(gradient(64), 4, "none");
    expect(palette).toHaveLength(4);
    expect([...colorsOf(image)].sort()).toEqual([...palette].sort());
  });

  it("passes an empty image through", () => {
    const { image, palette } = reduceColors(createRgbaImage(2, 2), 4);
    expect(palette).toEqual([]);
    expect([...image.data].every((v) => v === 0)).toBe(true);
  });
});
