import { describe, expect, it } from "vitest";
import { analyzeImage } from "../src/pixel/analyze.js";
import { parseHex } from "../src/pixel/color.js";
import { createRgbaImage, type RgbaImage } from "../src/pixel/RgbaImage.js";

const LEGEND: Record<string, string> = {
  W: "#ffffff",
  K: "#000000",
  R: "#ff0000",
  r: "#fe0101",
  h: "#ff000080",
  G: "#00ff00",
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

describe("analyzeImage", () => {
  it("reports an empty image", () => {
    const a = analyzeImage(createRgbaImage(4, 4));
    expect(a.bounds).toBeNull();
    expect(a.visiblePixels).toBe(0);
    expect(a.uniqueColors).toBe(0);
    expect(a.suggestions).toEqual(["Nothing is drawn here: this layer/frame is empty."]);
  });

  it("measures bounds, colors and top colors", () => {
    const a = analyzeImage(grid(["......", ".RRK..", ".RR...", "......"]));
    expect(a.bounds).toEqual({ x: 1, y: 1, width: 3, height: 2 });
    expect(a.visiblePixels).toBe(5);
    expect(a.uniqueColors).toBe(2);
    expect(a.topColors).toEqual([
      { color: "#ff0000", count: 4 },
      { color: "#000000", count: 1 },
    ]);
    expect(a.suggestions).toEqual(["No obvious pixel-art problems found."]);
  });

  it("finds orphans, noise, partial alpha and near-duplicate colors with matching suggestions", () => {
    const a = analyzeImage(grid(["K......", "..RRR..", "..RrR..", "..RRR..", "......h"]));
    expect(a.orphanPixels).toBe(2);
    expect(a.noisePixels).toBe(1);
    expect(a.partialAlphaPixels).toBe(1);
    expect(a.nearDuplicateColors).toContainEqual(["#ff0000", "#fe0101"]);
    const text = a.suggestions.join("\n");
    expect(text).toMatch(/cleanup_pixels removes/);
    expect(text).toMatch(/cleanup_pixels recolors/);
    expect(text).toMatch(/semi-transparent/);
    expect(text).toMatch(/replace_color or reduce_colors/);
  });

  it("counts partial-alpha variants as distinct colors", () => {
    const a = analyzeImage(grid(["Rh"]));
    expect(a.uniqueColors).toBe(2);
    expect(a.topColors.map((c) => c.color).sort()).toEqual(["#ff0000", "#ff000080"]);
  });

  it("detects a solid background along the border", () => {
    const a = analyzeImage(grid(["WWWWW", "WKKKW", "WKGKW", "WWWWW"]));
    expect(a.borderColor).toEqual({ color: "#ffffff", share: 1 });
    expect(a.suggestions.join(" ")).toMatch(/remove_background/);
  });

  it("flags too many colors for pixel art", () => {
    const image = createRgbaImage(8, 8);
    for (let i = 0; i < 64; i++) image.data.set([i * 4, 255 - i * 4, (i * 37) & 255, 255], i * 4);
    const a = analyzeImage(image);
    expect(a.uniqueColors).toBe(64);
    expect(a.suggestions[0]).toMatch(/64 colors .* reduce_colors/);
    expect(a.topColors).toHaveLength(8);
  });
});
