import { describe, expect, it } from "vitest";
import { parseColor } from "../src/pixel/PixelGridCodec.js";
import { luminance, mix, ramp, rgbToHsv, shade } from "../src/script/colorMath.js";
import { createValueNoise, seededRandom } from "../src/script/noise.js";

const hue = (c: string) => {
  const [r, g, b] = parseColor(c);
  return rgbToHsv(r, g, b)[0];
};
const sat = (c: string) => {
  const [r, g, b] = parseColor(c);
  return rgbToHsv(r, g, b)[1];
};
/** Signed shortest angular distance a -> b in degrees. */
const hueDelta = (a: number, b: number) => ((b - a + 540) % 360) - 180;

const BASES = ["#b13e53", "#3b7d4f", "#3b5dc9", "#e8b84a", "#8a5432", "#a8508f", "#f2b38a", "#5ac8c8"];

describe("ramp", () => {
  it("returns `steps` colors strictly increasing in luminance", () => {
    for (const base of BASES) {
      for (const steps of [3, 4, 5, 6, 8]) {
        const colors = ramp(base, steps);
        expect(colors).toHaveLength(steps);
        const lum = colors.map(luminance);
        for (let k = 1; k < lum.length; k++) expect(lum[k], `${base} x${steps} @${k}`).toBeGreaterThan(lum[k - 1]);
      }
    }
  });

  it("keeps the base color at index floor((steps-1)/2)", () => {
    expect(ramp("#b13e53", 5)[2]).toBe("#b13e53");
    expect(ramp("#b13e53", 4)[1]).toBe("#b13e53");
    expect(ramp("#3b7d4f", 3)[1]).toBe("#3b7d4f");
  });

  it("shifts shadows toward blue-violet and highlights toward yellow", () => {
    const SHADOW = 250;
    const LIGHT = 60;
    for (const base of BASES) {
      const colors = ramp(base, 5);
      const h = hue(base);
      // Moving toward a target hue = the remaining distance shrinks.
      expect(Math.abs(hueDelta(hue(colors[0]), SHADOW)), base).toBeLessThan(Math.abs(hueDelta(h, SHADOW)) + 0.5);
      expect(Math.abs(hueDelta(hue(colors[4]), LIGHT)), base).toBeLessThan(Math.abs(hueDelta(h, LIGHT)) + 0.5);
    }
    // A red ramp: shadows turn magenta (hue decreasing past 360), lights turn orange.
    const red = ramp("#d03030", 5);
    expect(hueDelta(hue("#d03030"), hue(red[0]))).toBeLessThan(-5);
    expect(hueDelta(hue("#d03030"), hue(red[4]))).toBeGreaterThan(5);
  });

  it("lowers saturation at the light end", () => {
    for (const base of BASES) {
      const colors = ramp(base, 5);
      expect(sat(colors[4]), base).toBeLessThan(sat(base));
    }
  });

  it("hueShift 0 keeps the hue", () => {
    const colors = ramp("#3b5dc9", 5, { hueShift: 0 });
    for (const c of colors) expect(Math.abs(hueDelta(hue(c), hue("#3b5dc9")))).toBeLessThan(3);
  });

  it("tints neutral grays cool in the shadows and warm in the lights", () => {
    const colors = ramp("#808080", 5);
    const [r0, , b0] = parseColor(colors[0]);
    const [r4, , b4] = parseColor(colors[4]);
    expect(b0).toBeGreaterThan(r0);
    expect(r4).toBeGreaterThan(b4);
    const pure = ramp("#808080", 5, { hueShift: 0 });
    for (const c of pure) {
      const [r, g, b] = parseColor(c);
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(1);
    }
  });

  it("very light and very dark bases move to the matching end instead of repeating white/black", () => {
    const white = ramp("#ffffff", 5);
    expect(white[4]).toBe("#ffffff");
    expect(new Set(white).size).toBe(5);
    const black = ramp("#000000", 5);
    expect(black[0]).toBe("#000000");
    expect(new Set(black).size).toBe(5);
  });

  it("short ramps stay usable: a 3-color shadow is not near-black", () => {
    const [dark] = ramp("#f2b38a", 3);
    expect(luminance(dark)).toBeGreaterThan(luminance("#f2b38a") * 0.35);
  });

  it("clamps steps and keeps alpha", () => {
    expect(ramp("#ff000080", 1)).toEqual(["#ff000080"]);
    expect(ramp("#ff0000", 100)).toHaveLength(32);
    expect(ramp("#ff000080", 3).every((c) => c.endsWith("80"))).toBe(true);
  });
});

describe("shade and mix", () => {
  it("shade darkens/lightens with the ramp's hue shift and 0 is identity", () => {
    expect(shade("#3b7d4f", 0)).toBe("#3b7d4f");
    expect(luminance(shade("#3b7d4f", -0.5))).toBeLessThan(luminance("#3b7d4f"));
    expect(luminance(shade("#3b7d4f", 0.5))).toBeGreaterThan(luminance("#3b7d4f"));
    expect(shade("#3b7d4f", -5)).toBe(shade("#3b7d4f", -1));
  });

  it("mix interpolates RGBA and clamps t", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("#ff0000", "#0000ff", 2)).toBe("#0000ff");
    expect(mix("#00000000", "#000000", 0.5)).toBe("#00000080");
  });

  it("invalid colors fail with the accepted formats", () => {
    expect(() => ramp("red", 3)).toThrow(/#rrggbb/);
  });
});

describe("noise and random", () => {
  it("noise is deterministic per seed, smooth and within 0..1", () => {
    const a = createValueNoise(7);
    const b = createValueNoise(7);
    const c = createValueNoise(8);
    let differs = false;
    for (let x = 0; x < 64; x++) {
      const v = a(x, 3, 8, 3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(v).toBe(b(x, 3, 8, 3));
      if (Math.abs(v - c(x, 3, 8, 3)) > 1e-9) differs = true;
      // Smooth: neighbouring pixels at scale 8 change little.
      expect(Math.abs(a(x, 3, 8) - a(x + 1, 3, 8))).toBeLessThan(0.35);
    }
    expect(differs).toBe(true);
  });

  it("seededRandom repeats its sequence for the same seed", () => {
    const a = seededRandom(3);
    const b = seededRandom(3);
    for (let k = 0; k < 10; k++) expect(a()).toBe(b());
  });
});
