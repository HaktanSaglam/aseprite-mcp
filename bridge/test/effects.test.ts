import { describe, expect, it } from "vitest";
import { formatHex, parseHex, rgbToOklab } from "../src/pixel/color.js";
import { adjustColor, adjustColors, hasAdjustments } from "../src/pixel/effects/adjustColors.js";
import { dominantBorderColors, removeBackground } from "../src/pixel/effects/background.js";
import { cleanupPixels, findNoise, findOrphans } from "../src/pixel/effects/cleanup.js";
import { dropShadow } from "../src/pixel/effects/dropShadow.js";
import { outline } from "../src/pixel/effects/outline.js";
import { replaceColor } from "../src/pixel/effects/replaceColor.js";
import { transformImage } from "../src/pixel/effects/transform.js";
import { createRgbaImage, type RgbaImage } from "../src/pixel/RgbaImage.js";

// Tiny grid DSL: one character per pixel, mapped through a legend; "." is transparent.
const LEGEND: Record<string, string> = {
  W: "#ffffff",
  K: "#000000",
  R: "#ff0000",
  r: "#f80404", // a near-identical red
  G: "#00ff00",
  B: "#0000ff",
  g: "#c0c0c0",
  O: "#ff8800",
};

function grid(rows: string[]): RgbaImage {
  const image = createRgbaImage(rows[0].length, rows.length);
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch !== ".") image.data.set(parseHex(LEGEND[ch]), (y * image.width + x) * 4);
    }),
  );
  return image;
}

/** Back to the DSL; unknown colors become "?" so tests can assert them separately. */
function rows(image: RgbaImage): string[] {
  const byHex = new Map(Object.entries(LEGEND).map(([k, v]) => [v, k]));
  const out: string[] = [];
  for (let y = 0; y < image.height; y++) {
    let row = "";
    for (let x = 0; x < image.width; x++) {
      const o = (y * image.width + x) * 4;
      const d = image.data;
      row += d[o + 3] === 0 ? "." : (byHex.get(formatHex(d[o], d[o + 1], d[o + 2], d[o + 3])) ?? "?");
    }
    out.push(row);
  }
  return out;
}

function pixel(image: RgbaImage, x: number, y: number): number[] {
  const o = (y * image.width + x) * 4;
  return [...image.data.subarray(o, o + 4)];
}

describe("outline", () => {
  const dot = grid([".....", ".....", "..R..", ".....", "....."]);

  it("outside, 4-connected: a plus shape around a dot", () => {
    const { image, changed } = outline(dot, { color: parseHex("#000000") });
    expect(changed).toBe(4);
    expect(rows(image)).toEqual([".....", "..K..", ".KRK.", "..K..", "....."]);
  });

  it("outside, 8-connected: a full ring", () => {
    const { image, changed } = outline(dot, { color: parseHex("#000000"), connectivity: 8 });
    expect(changed).toBe(8);
    expect(rows(image)).toEqual([".....", ".KKK.", ".KRK.", ".KKK.", "....."]);
  });

  it("inside recolors edge pixels and keeps the size", () => {
    const block = grid([".....", ".RRR.", ".RRR.", ".RRR.", "....."]);
    const { image, changed } = outline(block, { placement: "inside", color: parseHex("#000000") });
    expect(changed).toBe(8);
    expect(rows(image)).toEqual([".....", ".KKK.", ".KRK.", ".KKK.", "....."]);
  });

  it("inside ignores the canvas edge, so cut-off art is not boxed in", () => {
    const full = grid(["RRR", "RRR"]);
    expect(outline(full, { placement: "inside", color: parseHex("#000000") }).changed).toBe(0);
  });

  it("automatic color is a darker shade of the darkest neighbour", () => {
    const art = grid(["...", "WRW", "..."]);
    const { image } = outline(art, { connectivity: 4 });
    // Above the red pixel: neighbours are only the red, so a dark red-ish shade.
    const [r, g, b, a] = pixel(image, 1, 0);
    expect(a).toBe(255);
    expect(rgbToOklab(r, g, b)[0]).toBeLessThan(rgbToOklab(255, 0, 0)[0]);
    expect(r).toBeGreaterThan(g);
    // Left of the row: the white pixel is the only neighbour → a dark gray, not red.
    const left = outline(grid([".W"]), {}).image;
    const [lr, lg, lb] = pixel(left, 0, 0);
    expect(Math.max(lr, lg, lb) - Math.min(lr, lg, lb)).toBeLessThanOrEqual(2);
    expect(lr).toBeLessThan(160);
  });

  it("does nothing on an empty image", () => {
    expect(outline(createRgbaImage(3, 3)).changed).toBe(0);
  });
});

describe("removeBackground", () => {
  it("edges: removes the border-connected background but keeps enclosed same-colored pixels", () => {
    const art = grid(["WWWWW", "WKKKW", "WKWKW", "WKKKW", "WWWWW"]);
    const { image, removed, colors } = removeBackground(art, { tolerance: 0 });
    expect(colors).toEqual(["#ffffff"]);
    expect(removed).toBe(16);
    expect(rows(image)).toEqual([".....", ".KKK.", ".KWK.", ".KKK.", "....."]);
  });

  it("edges: removes a two-tone fake-transparency checkerboard", () => {
    const art = grid(["WgWgWg", "gWgWgW", "WgRRWg", "gWRRgW", "WgWgWg", "gWgWgW"]);
    const { image, colors } = removeBackground(art, { tolerance: 0 });
    expect(colors.sort()).toEqual(["#c0c0c0", "#ffffff"]);
    expect(rows(image)).toEqual(["......", "......", "..RR..", "..RR..", "......", "......"]);
  });

  it("edges: tolerance absorbs noisy backgrounds", () => {
    const art = grid(["RRRRR", "RKKKR", "RKKKR", "RKKKR", "RRRRR"]);
    // Four border pixels in slightly different reds, each too rare to count on its own.
    [1, 3, 21, 23].forEach((i, n) => art.data.set([250 - n, n * 2, n, 255], i * 4));
    expect(removeBackground(art, { tolerance: 0 }).removed).toBe(12);
    const { image, removed } = removeBackground(art, { tolerance: 10 });
    expect(removed).toBe(16);
    expect(rows(image)).toEqual([".....", ".KKK.", ".KKK.", ".KKK.", "....."]);
  });

  it("edges: leaves a sprite that merely touches the edge of a transparent canvas", () => {
    const art = grid(["......", "......", "..RR..", "..RRRR", "......", "......"]);
    expect(removeBackground(art).removed).toBe(0);
  });

  it("edges: a border of many unrelated colors has no background", () => {
    const art = createRgbaImage(6, 6);
    for (let i = 0; i < 36; i++) art.data.set([i * 7, 255 - i * 7, (i * 50) & 255, 255], i * 4);
    expect(dominantBorderColors(art, 0)).toEqual([]);
    expect(removeBackground(art, { tolerance: 0 }).removed).toBe(0);
  });

  it("edges: an outline touching the edge of a transparent canvas is not background", () => {
    expect(removeBackground(grid(["..K..", "..K..", "KK.WK", "..K.."])).removed).toBe(0);
  });

  it("edges: keeps a subject touching a solid background's border, passes through erased areas", () => {
    const bg = grid(["WWKWW", "W.K.W", "KK.WK", "WWKWW"]);
    const result = removeBackground(bg, { tolerance: 0 });
    expect(rows(result.image)).toEqual(["..K..", "..K..", "KK..K", "..K.."]);
  });

  it("color: removes the color everywhere, enclosed or not", () => {
    const art = grid(["WWWWW", "WKKKW", "WKWKW", "WKKKW", "WWWWW"]);
    const { image, removed } = removeBackground(art, { mode: "color", color: parseHex("#ffffff") });
    expect(removed).toBe(17);
    expect(rows(image)[2]).toBe(".K.K.");
  });

  it("color: requires an opaque color", () => {
    expect(() => removeBackground(grid(["W"]), { mode: "color" })).toThrow(/needs a color/);
    expect(() => removeBackground(grid(["W"]), { mode: "color", color: [0, 0, 0, 0] })).toThrow(/opaque/);
  });

  it("dominantBorderColors groups similar colors and reports shares", () => {
    const art = grid(["RRRR", "R..R", "rrrr"]);
    const exact = dominantBorderColors(art, 0);
    expect(exact.map((g) => formatHex(...g.color))).toEqual(["#ff0000", "#f80404"]);
    const grouped = dominantBorderColors(art, 0.05);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].share).toBeCloseTo(1);
  });
});

describe("replaceColor", () => {
  const art = grid(["RrG", "R.B"]);

  it("replaces an exact color", () => {
    const { image, replaced } = replaceColor(art, parseHex("#ff0000"), parseHex("#0000ff"));
    expect(replaced).toBe(2);
    expect(rows(image)).toEqual(["BrG", "B.B"]);
  });

  it("tolerance catches near shades and makes them exactly the new color", () => {
    const { image, replaced } = replaceColor(art, parseHex("#ff0000"), parseHex("#000000"), 10);
    expect(replaced).toBe(3);
    expect(rows(image)).toEqual(["KKG", "K.B"]);
  });

  it("transparent `to` erases, transparent `from` fills", () => {
    expect(rows(replaceColor(art, parseHex("#00ff00"), [0, 0, 0, 0]).image)).toEqual(["Rr.", "R.B"]);
    expect(rows(replaceColor(art, [0, 0, 0, 0], parseHex("#ffffff")).image)).toEqual(["RrG", "RWB"]);
  });

  it("does not count pixels that already have the new color", () => {
    expect(replaceColor(art, parseHex("#0000ff"), parseHex("#0000ff")).replaced).toBe(0);
  });
});

describe("adjustColors", () => {
  it("inverts, grayscales and keeps alpha", () => {
    expect(adjustColor(255, 0, 0, { invert: true })).toEqual([0, 255, 255]);
    expect(adjustColor(255, 0, 0, { grayscale: true })).toEqual([76, 76, 76]);
    const image = createRgbaImage(2, 1);
    image.data.set([255, 0, 0, 200, 9, 9, 9, 0]);
    const { image: out, changed } = adjustColors(image, { invert: true });
    expect(changed).toBe(1);
    expect([...out.data]).toEqual([0, 255, 255, 200, 9, 9, 9, 0]);
  });

  it("rotates hue", () => {
    expect(adjustColor(255, 0, 0, { hue: 120 })).toEqual([0, 255, 0]);
    expect(adjustColor(255, 0, 0, { hue: -120 })).toEqual([0, 0, 255]);
  });

  it("scales saturation and lightness toward their ends", () => {
    expect(adjustColor(255, 0, 0, { saturation: -100 })).toEqual([128, 128, 128]);
    expect(adjustColor(200, 100, 100, { lightness: 100 })).toEqual([255, 255, 255]);
    expect(adjustColor(200, 100, 100, { lightness: -100 })).toEqual([0, 0, 0]);
  });

  it("brightness offsets, contrast spreads around mid gray", () => {
    expect(adjustColor(100, 100, 100, { brightness: 20 })).toEqual([151, 151, 151]);
    const [lo] = adjustColor(100, 100, 100, { contrast: 50 });
    const [hi] = adjustColor(160, 160, 160, { contrast: 50 });
    expect(lo).toBeLessThan(100);
    expect(hi).toBeGreaterThan(160);
    expect(adjustColor(10, 200, 90, { contrast: -100 })).toEqual([128, 128, 128]);
  });

  it("no-op adjustments change nothing", () => {
    expect(hasAdjustments({ hue: 0, invert: false })).toBe(false);
    expect(hasAdjustments({ contrast: 5 })).toBe(true);
    expect(adjustColors(grid(["RGB"]), { hue: 0 }).changed).toBe(0);
  });
});

describe("cleanupPixels", () => {
  it("removes isolated pixels; minNeighbors 2 also removes line tips", () => {
    const art = grid(["R....", ".....", "..GGG", "....."]);
    expect(findOrphans(art)).toEqual([0]);
    const { image, removed } = cleanupPixels(art);
    expect(removed).toBe(1);
    expect(rows(image)).toEqual([".....", ".....", "..GGG", "....."]);
    expect(rows(cleanupPixels(art, { minNeighbors: 2 }).image)).toEqual([".....", ".....", "...G.", "....."]);
    expect(cleanupPixels(art, { minNeighbors: 0 }).removed).toBe(0);
  });

  it("recolors near-identical noise but keeps high-contrast 1px details by default", () => {
    const art = grid(["RRRRRRR", "RrRRRKR", "RRRRRRR"]);
    const { image, recolored } = cleanupPixels(art);
    expect(recolored).toBe(1);
    expect(rows(image)).toEqual(["RRRRRRR", "RRRRRKR", "RRRRRRR"]);
    expect(rows(cleanupPixels(art, { noise: "all" }).image)).toEqual(["RRRRRRR", "RRRRRRR", "RRRRRRR"]);
    expect(cleanupPixels(art, { noise: "off" }).recolored).toBe(0);
  });

  it("only treats pixels enclosed by one color on all 4 sides as noise", () => {
    expect(findNoise(grid(["RGR", "RrR", "RRR"]), "all")).toHaveLength(0);
    expect(findNoise(grid(["GRG", "RKR", "GRG"]), "all")).toHaveLength(1);
  });
});

describe("transformImage", () => {
  const art = grid(["RG.", "B..", "..."]);

  it("flips", () => {
    expect(rows(transformImage(art, "flip_h"))).toEqual([".GR", "..B", "..."]);
    expect(rows(transformImage(art, "flip_v"))).toEqual(["...", "B..", "RG."]);
  });

  it("rotates clockwise; four quarter turns are the identity on squares", () => {
    expect(rows(transformImage(art, "rotate_90"))).toEqual([".BR", "..G", "..."]);
    expect(rows(transformImage(art, "rotate_270"))).toEqual(["...", "G..", "RB."]);
    expect(rows(transformImage(art, "rotate_180"))).toEqual(["...", "..B", ".GR"]);
    let turned = art;
    for (let i = 0; i < 4; i++) turned = transformImage(turned, "rotate_90");
    expect(rows(turned)).toEqual(rows(art));
  });

  it("keeps the canvas size on non-square canvases and clips", () => {
    const wide = grid(["RRRG", "BBBB"]);
    const turned = transformImage(wide, "rotate_90");
    expect(turned.width).toBe(4);
    expect(turned.height).toBe(2);
    expect(rows(turned)).toEqual([".BR.", ".BR."]);
    expect(rows(transformImage(wide, "rotate_180"))).toEqual(["BBBB", "GRRR"]);
  });

  it("shifts with clipping or wrapping", () => {
    expect(rows(transformImage(art, "shift", { dx: 1, dy: 1 }))).toEqual(["...", ".RG", ".B."]);
    expect(rows(transformImage(art, "shift", { dx: -1 }))).toEqual(["G..", "...", "..."]);
    expect(rows(transformImage(art, "shift", { dx: -1, wrap: true }))).toEqual(["G.R", "..B", "..."]);
  });

  it("transforms only inside a region", () => {
    const wide = grid(["RGKK", "KKKK"]);
    expect(rows(transformImage(wide, "flip_h", {}, { x: 0, y: 0, width: 2, height: 1 }))).toEqual(["GRKK", "KKKK"]);
  });
});

describe("dropShadow", () => {
  it("casts the silhouette offset into transparent pixels only", () => {
    const art = grid(["RR..", "R...", "...."]);
    const { image, changed } = dropShadow(art, { dx: 1, dy: 1, color: parseHex("#000000") });
    expect(changed).toBe(3);
    expect(rows(image)).toEqual(["RR..", "RKK.", ".K.."]);
  });

  it("supports negative offsets", () => {
    const art = grid(["...", ".R.", "..."]);
    expect(rows(dropShadow(art, { dx: -1, dy: -1, color: parseHex("#000000") }).image)).toEqual(["K..", ".R.", "..."]);
  });
});
