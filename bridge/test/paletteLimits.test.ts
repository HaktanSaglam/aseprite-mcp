import { describe, expect, it } from "vitest";
import { countColors, forcedPalette, limitColors, PaletteEnforcer } from "../src/chat/paletteLimits.js";
import { getPalettePreset } from "../src/pixel/palettes.js";
import { createRgbaImage, type RgbaImage } from "../src/pixel/RgbaImage.js";
import { FakeGateway } from "./fakes/FakeGateway.js";

/** A 1-row image, one pixel per color ("" = transparent). */
function row(...colors: string[]): RgbaImage {
  const image = createRgbaImage(colors.length, 1);
  colors.forEach((c, i) => {
    if (!c) return;
    const n = parseInt(c.slice(1), 16);
    image.data.set([(n >> 16) & 255, (n >> 8) & 255, n & 255, 255], i * 4);
  });
  return image;
}

const hexAt = (image: RgbaImage, i: number) =>
  `#${[0, 1, 2].map((c) => image.data[i * 4 + c].toString(16).padStart(2, "0")).join("")}`;

describe("forcedPalette", () => {
  it("names what forcePalette snaps to, or nothing when there is nothing to snap to", () => {
    expect(forcedPalette({ palette: "endesga32" })).toBeUndefined(); // not forced
    expect(forcedPalette({ palette: "endesga32", forcePalette: true })).toEqual({
      label: "ENDESGA 32",
      colors: getPalettePreset("endesga32").colors,
    });
    expect(forcedPalette({ palette: "custom", customPalette: ["#000000", "#ffffff"], forcePalette: true })).toEqual({
      label: "custom",
      colors: ["#000000", "#ffffff"],
    });
    expect(forcedPalette({ palette: "current", forcePalette: true })).toEqual({ label: "sprite", current: true });
    expect(forcedPalette({ style: "pico8", forcePalette: true })).toMatchObject({ label: "PICO-8" });
    expect(forcedPalette({ forcePalette: true })).toBeUndefined();
  });
});

describe("limitColors", () => {
  it("merges colors over all images together, so the limit holds for the sprite", () => {
    const a = row("#ff0000", "#fe0101", "#0000ff");
    const b = row("#00ff00", "#01fe01", "#0000fe");
    expect(countColors([a, b])).toBe(6);
    const result = limitColors([a, b], { maxColors: 3 });
    expect(result.colorsBefore).toBe(6);
    expect(result.colorsAfter).toBe(3);
    expect(countColors(result.images)).toBe(3);
    // Near-duplicates collapse onto one of the existing colors, never an average.
    expect(hexAt(result.images[0], 0)).toBe(hexAt(result.images[0], 1));
    expect(["#ff0000", "#fe0101"]).toContain(hexAt(result.images[0], 0));
  });

  it("returns images that already follow the rules unchanged (same object)", () => {
    const a = row("#ff0000", "", "#0000ff");
    const result = limitColors([a], { maxColors: 2 });
    expect(result.images[0]).toBe(a);
    expect(limitColors([a], { palette: ["#ff0000", "#0000ff"] }).images[0]).toBe(a);
  });

  it("snaps to a palette first, then limits within it", () => {
    const palette = ["#000000", "#ff0000", "#00ff00", "#0000ff", "#ffffff"];
    const a = row("#f01010", "#10f010", "#1010f0", "#fafafa", "#050505");
    const snapped = limitColors([a], { palette });
    expect([0, 1, 2, 3, 4].map((i) => hexAt(snapped.images[0], i))).toEqual(["#ff0000", "#00ff00", "#0000ff", "#ffffff", "#000000"]);
    const limited = limitColors([a], { palette, maxColors: 3 });
    expect(countColors(limited.images)).toBe(3);
    for (let i = 0; i < 5; i++) expect(palette).toContain(hexAt(limited.images[0], i));
  });
});

describe("PaletteEnforcer", () => {
  function setup() {
    const gateway = new FakeGateway();
    const sprite = gateway.addSprite({ width: 4, height: 1, frames: 2, layers: ["AI", "User"] });
    gateway.fillRect({ sprite, layer: "AI", frame: 1, x: 0, y: 0, width: 1, height: 1, color: "#ff0000" });
    gateway.fillRect({ sprite, layer: "AI", frame: 1, x: 1, y: 0, width: 1, height: 1, color: "#fe0202" });
    gateway.fillRect({ sprite, layer: "AI", frame: 2, x: 0, y: 0, width: 1, height: 1, color: "#00ff00" });
    gateway.fillRect({ sprite, layer: "User", frame: 1, x: 3, y: 0, width: 1, height: 1, color: "#123456" });
    return { gateway, sprite, enforcer: new PaletteEnforcer(gateway) };
  }

  it("enforces the limit on the layers the run drew only, as one write", async () => {
    const { gateway, sprite, enforcer } = setup();
    const status = await enforcer.enforce(sprite, [{ layer: "AI", frame: 1 }, { layer: "AI", frame: 2 }], { maxColors: 2 });
    expect(status).toBe("Applied the limit of 2 colors: 1 pixel recolored (3 → 2 colors), as one undo step.");
    expect(gateway.callsOf("writeImages")).toHaveLength(1);
    expect(gateway.pixel("AI", 1, 0, 1)).toEqual(gateway.pixel("AI", 0, 0, 1));
    // The user's own layer was not drawn by the run, so it keeps its color.
    expect(gateway.pixel("User", 3, 0, 1)).toEqual([0x12, 0x34, 0x56, 255]);
  });

  it("snaps every frame of a drawn layer to a forced palette and reports when nothing had to change", async () => {
    const { gateway, sprite, enforcer } = setup();
    const options = { palette: "custom" as const, customPalette: ["#ff0000", "#00ff00"], forcePalette: true };
    // Only frame 1 is reported as drawn, but the rule holds for the whole layer (frame 2's green too).
    expect(await enforcer.enforce(sprite, [{ layer: "AI", frame: 1 }], options)).toBe(
      "Applied the custom palette: 1 pixel recolored (3 → 2 colors), as one undo step.",
    );
    expect(gateway.pixel("AI", 1, 0, 1)).toEqual([255, 0, 0, 255]);
    gateway.calls.length = 0;
    expect(await enforcer.enforce(sprite, [{ layer: "AI", frame: 1 }], options)).toBe("Colors already follow the custom palette (2 colors).");
    expect(gateway.callsOf("writeImages")).toHaveLength(0);
  });

  it("resolves default layers, every-layer copies and skips layers that are gone or locked, on all frames", async () => {
    const { gateway, sprite, enforcer } = setup();
    gateway.state(sprite).activeLayer = "AI";
    await gateway.layerOp({ op: "update", name: "User", editable: false }, { sprite });
    gateway.calls.length = 0;
    await enforcer.enforce(sprite, [{}, { everyLayer: true, frame: 2 }, { layer: "Deleted", frame: 1 }, { layer: "AI", frame: 9 }], {
      maxColors: 2,
    });
    const reads = gateway.callsOf("readImage").map(([r]) => (r as { layer: string; frame: number }));
    expect(reads.map((r) => `${r.layer}#${r.frame}`).sort()).toEqual(["AI#1", "AI#2", "Layer 1#1", "Layer 1#2"]);
  });

  it("makes a forced preset the sprite palette before the run, once, and only on RGB sprites", async () => {
    const { gateway, sprite, enforcer } = setup();
    const options = { palette: "pico8" as const, forcePalette: true };
    await enforcer.presetSpritePalette(sprite, options);
    expect(gateway.callsOf("setPalette")).toHaveLength(1);
    // Already set: no second undo step.
    await enforcer.presetSpritePalette(sprite, options);
    expect(gateway.callsOf("setPalette")).toHaveLength(1);
    // Not forced, "current" or an indexed sprite: the palette stays.
    await enforcer.presetSpritePalette(sprite, { palette: "endesga32" });
    await enforcer.presetSpritePalette(sprite, { palette: "current", forcePalette: true });
    await enforcer.presetSpritePalette(gateway.addSprite({ colorMode: "indexed" }), options);
    expect(gateway.callsOf("setPalette")).toHaveLength(1);
  });

  it("reads a forced 'current' palette from the sprite, without its transparent slot", async () => {
    const { gateway, sprite, enforcer } = setup();
    await gateway.setPalette(["#00000000", "#00ff00"], { sprite });
    await enforcer.enforce(sprite, [{ layer: "AI", frame: 1 }], { palette: "current", forcePalette: true });
    expect(gateway.pixel("AI", 0, 0, 1)).toEqual([0, 255, 0, 255]);
  });

  it("does nothing without rules and leaves indexed sprites to their own palette", async () => {
    const { gateway, sprite, enforcer } = setup();
    expect(await enforcer.enforce(sprite, [{ layer: "AI", frame: 1 }], {})).toBeUndefined();
    const indexed = gateway.addSprite({ colorMode: "indexed" });
    expect(await enforcer.enforce(indexed, [{ frame: 1 }], { maxColors: 4 })).toMatch(/not applied: the sprite is in indexed mode/);
  });
});
