import { describe, expect, it } from "vitest";
import {
  colorDistance,
  darkerShade,
  formatHex,
  hslToRgb,
  hsvToRgb,
  isOpaque,
  oklabCache,
  oklabInGamut,
  oklabToOklch,
  oklabToRgb,
  oklchToOklab,
  oklchToRgb,
  packRgb,
  parseHex,
  rgbToHsl,
  rgbToHsv,
  rgbToOklab,
  toleranceToDistance,
  unpackRgb,
} from "../src/pixel/color.js";

const SAMPLES: [number, number, number][] = [];
for (let r = 0; r < 256; r += 51) {
  for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) SAMPLES.push([r, g, b]);
}
SAMPLES.push([1, 2, 3], [254, 128, 7], [18, 52, 86]);

describe("hex", () => {
  it("parses #rgb, #rrggbb, #rrggbbaa, no hash and transparent", () => {
    expect(parseHex("#f00")).toEqual([255, 0, 0, 255]);
    expect(parseHex("00ff00")).toEqual([0, 255, 0, 255]);
    expect(parseHex("#0000ff80")).toEqual([0, 0, 255, 128]);
    expect(parseHex("transparent")).toEqual([0, 0, 0, 0]);
  });

  it("rejects garbage with an actionable message", () => {
    expect(() => parseHex("red")).toThrow(/#rrggbb/);
  });

  it("formats lowercase, alpha only when not opaque, clamps", () => {
    expect(formatHex(255, 171, 0)).toBe("#ffab00");
    expect(formatHex(1, 2, 3, 128)).toBe("#01020380");
    expect(formatHex(300, -5, 12.6)).toBe("#ff000d");
  });

  it("packs and unpacks 24-bit keys", () => {
    expect(unpackRgb(packRgb(18, 52, 86))).toEqual([18, 52, 86]);
  });

  it("treats alpha >= 128 as opaque", () => {
    expect(isOpaque(127)).toBe(false);
    expect(isOpaque(128)).toBe(true);
  });
});

describe("HSL / HSV", () => {
  it("knows primary colors", () => {
    expect(rgbToHsl(255, 0, 0)).toEqual([0, 1, 0.5]);
    expect(rgbToHsl(0, 255, 0)[0]).toBeCloseTo(120);
    expect(rgbToHsv(0, 0, 255)).toEqual([240, 1, 1]);
    expect(hslToRgb(240, 1, 0.5)).toEqual([0, 0, 255]);
    expect(hsvToRgb(60, 1, 1)).toEqual([255, 255, 0]);
  });

  it("round-trips through HSL and HSV", () => {
    for (const [r, g, b] of SAMPLES) {
      expect(hslToRgb(...rgbToHsl(r, g, b))).toEqual([r, g, b]);
      expect(hsvToRgb(...rgbToHsv(r, g, b))).toEqual([r, g, b]);
    }
  });

  it("wraps hue", () => {
    expect(hslToRgb(360 + 120, 1, 0.5)).toEqual([0, 255, 0]);
    expect(hslToRgb(-120, 1, 0.5)).toEqual([0, 0, 255]);
  });
});

describe("OKLab", () => {
  it("matches reference values", () => {
    const [L, a, b] = rgbToOklab(255, 0, 0);
    expect(L).toBeCloseTo(0.62796, 4);
    expect(a).toBeCloseTo(0.22486, 4);
    expect(b).toBeCloseTo(0.12585, 4);
    expect(rgbToOklab(255, 255, 255)[0]).toBeCloseTo(1, 4);
    expect(rgbToOklab(0, 0, 0)).toEqual([0, 0, 0]);
  });

  it("round-trips through OKLab and OKLCH", () => {
    for (const [r, g, b] of SAMPLES) {
      const lab = rgbToOklab(r, g, b);
      expect(oklabToRgb(...lab)).toEqual([r, g, b]);
      expect(oklabToRgb(...oklchToOklab(oklabToOklch(lab)))).toEqual([r, g, b]);
      expect(oklabInGamut(...lab)).toBe(true);
    }
  });

  it("detects out-of-gamut colors and maps them by lowering chroma", () => {
    expect(oklabInGamut(0.5, 0.4, 0.4)).toBe(false);
    const rgb = oklchToRgb([0.5, 0.5, 30]);
    expect(rgb.every((c) => c >= 0 && c <= 255 && Number.isInteger(c))).toBe(true);
    // Lightness is kept rather than clipped away.
    expect(rgbToOklab(...rgb)[0]).toBeCloseTo(0.5, 1);
  });

  it("measures perceptual distance: black↔white is 1, identical is 0", () => {
    expect(colorDistance([0, 0, 0], [255, 255, 255])).toBeCloseTo(1, 3);
    expect(colorDistance([10, 20, 30], [10, 20, 30, 255])).toBe(0);
    expect(colorDistance([200, 0, 0], [210, 0, 0])).toBeLessThan(colorDistance([200, 0, 0], [0, 200, 0]));
  });

  it("memoizes conversions", () => {
    const lab = oklabCache();
    const first = lab(1, 2, 3);
    expect(lab(1, 2, 3)).toBe(first);
    expect(first).toEqual(rgbToOklab(1, 2, 3));
  });
});

describe("toleranceToDistance", () => {
  it("is 0 at 0, everything at 100, and monotonic in between", () => {
    expect(toleranceToDistance(0)).toBe(0);
    expect(toleranceToDistance(-5)).toBe(0);
    expect(toleranceToDistance(100)).toBe(Number.POSITIVE_INFINITY);
    let previous = 0;
    for (let t = 1; t < 100; t++) {
      const d = toleranceToDistance(t);
      expect(d).toBeGreaterThan(previous);
      previous = d;
    }
    expect(toleranceToDistance(99)).toBeLessThan(1);
  });
});

describe("darkerShade", () => {
  it("is darker and stays in gamut", () => {
    for (const [r, g, b] of SAMPLES) {
      const shade = darkerShade([r, g, b]);
      expect(shade.every((c) => c >= 0 && c <= 255)).toBe(true);
      if (r + g + b > 0) expect(rgbToOklab(...shade)[0]).toBeLessThan(rgbToOklab(r, g, b)[0]);
    }
  });

  it("keeps grays neutral", () => {
    const [r, g, b] = darkerShade([180, 180, 180]);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(2);
  });

  it("shifts warm hues toward blue-violet, like hand-picked shadows", () => {
    const base = oklabToOklch(rgbToOklab(230, 160, 60));
    const shade = oklabToOklch(rgbToOklab(...darkerShade([230, 160, 60])));
    // Orange (~70°) moves away from yellow, toward red/purple: hue decreases.
    expect(shade[2]).toBeLessThan(base[2]);
  });
});
