import { describe, expect, it } from "vitest";
import {
  getPalettePreset,
  isPalettePresetId,
  listPalettePresets,
  PALETTE_PRESET_IDS,
  suggestRamps,
} from "../src/pixel/palettes.js";

const EXPECTED_SIZES: Record<string, number> = {
  pico8: 16,
  sweetie16: 16,
  endesga32: 32,
  endesga64: 64,
  db16: 16,
  db32: 32,
  aap64: 64,
  resurrect64: 64,
  gameboy: 4,
  nes: 55,
  "1bit": 2,
};

describe("palette presets", () => {
  it("has every id exactly once, matching the protocol's PaletteId list", () => {
    expect(new Set(PALETTE_PRESET_IDS).size).toBe(PALETTE_PRESET_IDS.length);
    expect([...PALETTE_PRESET_IDS].sort()).toEqual(Object.keys(EXPECTED_SIZES).sort());
    expect(listPalettePresets().map((p) => p.id)).toEqual([...PALETTE_PRESET_IDS]);
  });

  it.each(Object.entries(EXPECTED_SIZES))("%s has %i unique lowercase #rrggbb colors", (id, size) => {
    const preset = getPalettePreset(id);
    expect(preset.id).toBe(id);
    expect(preset.name.length).toBeGreaterThan(0);
    expect(preset.colors).toHaveLength(size);
    for (const c of preset.colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(preset.colors).size).toBe(size);
  });

  it("keeps the published colors and order", () => {
    expect(getPalettePreset("pico8").colors.slice(0, 3)).toEqual(["#000000", "#1d2b53", "#7e2553"]);
    expect(getPalettePreset("pico8").colors[8]).toBe("#ff004d");
    expect(getPalettePreset("sweetie16").colors[0]).toBe("#1a1c2c");
    expect(getPalettePreset("endesga32").colors[0]).toBe("#be4a2f");
    expect(getPalettePreset("endesga64").colors[63]).toBe("#571c27");
    expect(getPalettePreset("db16").colors[15]).toBe("#deeed6");
    expect(getPalettePreset("db32").colors[21]).toBe("#ffffff");
    expect(getPalettePreset("aap64").colors[0]).toBe("#060608");
    expect(getPalettePreset("resurrect64").colors[0]).toBe("#2e222f");
    expect(getPalettePreset("gameboy").colors).toEqual(["#081820", "#346856", "#88c070", "#e0f8d0"]);
    expect(getPalettePreset("1bit").colors).toEqual(["#000000", "#ffffff"]);
  });

  it("rejects unknown ids, listing the valid ones", () => {
    expect(isPalettePresetId("pico8")).toBe(true);
    expect(isPalettePresetId("auto")).toBe(false);
    expect(() => getPalettePreset("pico-8")).toThrow(/pico8, sweetie16/);
  });
});

describe("suggestRamps", () => {
  it("puts every color in exactly one ramp, dark to light", () => {
    for (const preset of listPalettePresets()) {
      const ramps = suggestRamps(preset.colors);
      const all = ramps.flatMap((r) => r.colors);
      expect([...all].sort()).toEqual([...preset.colors].sort());
      expect(new Set(ramps.map((r) => r.hue)).size).toBe(ramps.length);
    }
  });

  it("groups grays as neutral and hues by family", () => {
    const ramps = suggestRamps(["#ffffff", "#000000", "#808080", "#ff0000", "#800000", "#00a000", "#0000ff"]);
    const byHue = Object.fromEntries(ramps.map((r) => [r.hue, r.colors]));
    expect(byHue.neutral).toEqual(["#000000", "#808080", "#ffffff"]);
    expect(byHue.red).toEqual(["#800000", "#ff0000"]);
    expect(byHue.green).toEqual(["#00a000"]);
    expect(byHue.blue).toEqual(["#0000ff"]);
  });

  it("skips fully transparent entries", () => {
    expect(suggestRamps(["#00000000", "#ffffff"]).flatMap((r) => r.colors)).toEqual(["#ffffff"]);
  });
});
