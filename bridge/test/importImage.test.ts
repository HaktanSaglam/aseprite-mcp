import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInputPath, type PathProbe } from "../src/canvas/pathPolicy.js";
import { registerImportImage } from "../src/mcp/tools/importImage.js";
import { decodePng, pngSize } from "../src/pixel/pngDecode.js";
import type { RgbaImage } from "../src/pixel/RgbaImage.js";
import { FakeGateway } from "./fakes/FakeGateway.js";
import { toolHarness, type ToolHarness } from "./fakes/toolHarness.js";
import { differingPixels, gridImage, randomArt, upscale } from "./fixtures/pixelArt.js";

const abs = (path: string) => resolve(path);

function encode(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data.set(image.data);
  return PNG.sync.write(png);
}

/** A PNG header that claims a size, with no pixel data behind it. */
function headerOnly(width: number, height: number): Buffer {
  const real = encode(gridImage(["a"], { a: "#ff0000" }));
  const fake = Buffer.from(real);
  fake.writeUInt32BE(width, 16);
  fake.writeUInt32BE(height, 20);
  return fake;
}

describe("resolveInputPath", () => {
  const probe = (dirs: string[], files: string[], links: Record<string, string> = {}): PathProbe => ({
    homeDir: () => abs("/home/me"),
    kind: (path) => (dirs.map(abs).includes(path) ? "dir" : files.map(abs).includes(path) ? "file" : null),
    realPath: (path) => (links[path] !== undefined ? abs(links[path]) : path),
  });
  const fs = probe(["/art", "/home/me"], ["/art/hero.png", "/home/me/a.png", "/art/HERO.PNG", "/art/link.png"], {
    [abs("/art/link.png")]: "/home/me/.ssh/key.png",
  });
  const PNG_RULES = { extensions: [".png"] };

  it("accepts an existing absolute or ~/ file", () => {
    expect(resolveInputPath("/art/hero.png", PNG_RULES, fs)).toBe(abs("/art/hero.png"));
    expect(resolveInputPath(" ~/a.png ", PNG_RULES, fs)).toBe(abs("/home/me/a.png"));
    expect(resolveInputPath("/art/HERO.PNG", PNG_RULES, fs)).toBe(abs("/art/HERO.PNG"));
  });

  it("refuses relative, network, wrong-type, missing and folder paths", () => {
    expect(() => resolveInputPath("hero.png", PNG_RULES, fs)).toThrow(/must be absolute/);
    expect(() => resolveInputPath("//server/share/a.png", PNG_RULES, fs)).toThrow(/network paths/);
    expect(() => resolveInputPath("/art/hero.jpg", PNG_RULES, fs)).toThrow(/must end with \.png/);
    expect(() => resolveInputPath("/art/none.png", PNG_RULES, fs)).toThrow(/does not exist/);
    expect(() => resolveInputPath("/art.png", PNG_RULES, probe(["/art.png"], []))).toThrow(/is a folder/);
  });

  it("refuses hidden folders, also behind a symlink", () => {
    expect(() => resolveInputPath("~/.config/a.png", PNG_RULES, fs)).toThrow(/inside "\.config", a hidden name/);
    expect(() => resolveInputPath("/art/link.png", PNG_RULES, fs)).toThrow(/links to .* inside the hidden "\.ssh"/);
  });
});

describe("decodePng", () => {
  it("reads the size from the header and decodes to RGBA", () => {
    const art = randomArt(5, 3, 1);
    const buffer = encode(art);
    expect(pngSize(buffer)).toEqual({ width: 5, height: 3 });
    expect(differingPixels(decodePng(buffer, 1024), art)).toBe(0);
  });

  it("rescales 16-bit and expands gray PNGs", () => {
    const png = new PNG({ width: 2, height: 1, colorType: 0, inputColorType: 6, bitDepth: 16 } as never);
    png.data = Buffer.from([10, 20, 30, 255, 200, 200, 200, 255].flatMap((v) => [v]));
    const decoded = decodePng(PNG.sync.write(png, { colorType: 0, inputColorType: 6, bitDepth: 16 } as never), 16);
    expect(decoded.width).toBe(2);
    expect(decoded.data[3]).toBe(255);
    expect(decoded.data[4]).toBe(decoded.data[5]);
  });

  it("refuses non-PNG data, empty and oversized images before decoding", () => {
    expect(() => decodePng(Buffer.from("GIF89a................."), 1024)).toThrow(/not a PNG/);
    expect(() => decodePng(headerOnly(5000, 5000), 1024)).toThrow(/5000x5000; at most 1024x1024/);
    expect(() => decodePng(headerOnly(0, 4), 1024)).toThrow(/empty/);
    expect(() => decodePng(headerOnly(4, 4), 1024)).toThrow(/could not be decoded/);
  });
});

describe("import_image", () => {
  const dir = mkdtempSync(join(tmpdir(), "aseprite-mcp-import-"));
  const art = gridImage(["kkkk", "krrk", "krrk", "kkkk"], { k: "#1a1c2c", r: "#b13e53" });
  writeFileSync(join(dir, "hero.png"), encode(art));
  writeFileSync(join(dir, "big.png"), encode(upscale(randomArt(12, 10, 3), 4)));
  writeFileSync(join(dir, "fake.png"), "not an image");
  mkdirSync(join(dir, ".secret"));
  writeFileSync(join(dir, ".secret", "x.png"), encode(art));
  symlinkSync(join(dir, ".secret", "x.png"), join(dir, "link.png"));

  let h: ToolHarness;
  let gw: FakeGateway;
  beforeEach(async () => {
    gw = new FakeGateway();
    gw.addSprite({ width: 16, height: 16, frames: 2 });
    h = await toolHarness([registerImportImage], gw);
  });
  afterEach(() => h.close());
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("puts the PNG on a new layer named after the file, in one undo step", async () => {
    const result = await h.call("import_image", { path: join(dir, "hero.png"), x: 2, y: 3 });
    expect(result.text).toBe(`Imported hero.png (4x4) onto new layer "hero" at (2, 3), frame 1.`);
    expect(gw.pixel("hero", 2, 3)).toEqual([0x1a, 0x1c, 0x2c, 255]);
    expect(gw.pixel("hero", 3, 4)).toEqual([0xb1, 0x3e, 0x53, 255]);
    expect(gw.callsOf("writeImages")).toHaveLength(1);
    await h.call("import_image", { path: join(dir, "hero.png") });
    expect(gw.state().layers.map((l) => l.name)).toEqual(["Layer 1", "hero", "hero 2"]);
  });

  it("writes into a named layer and frame, keeping pixels under transparency", async () => {
    gw.fillRect({ layer: "Layer 1", frame: 2, x: 0, y: 0, width: 16, height: 16, color: "#00ff00" });
    const transparentCorner = gridImage([".k", "kk"], { k: "#000000" });
    writeFileSync(join(dir, "corner.png"), encode(transparentCorner));
    const result = await h.call("import_image", { path: join(dir, "corner.png"), layer: "Layer 1", frame: 2 });
    expect(result.text).toMatch(/onto layer "Layer 1" at \(0, 0\), frame 2\./);
    expect(gw.pixel("Layer 1", 0, 0, 2)).toEqual([0, 255, 0, 255]);
    expect(gw.pixel("Layer 1", 1, 0, 2)).toEqual([0, 0, 0, 255]);
  });

  it("says what was cut off and suggests normalize_pixel_art for upscaled art", async () => {
    const result = await h.call("import_image", { path: join(dir, "big.png") });
    expect(result.text).toMatch(/Only 16x16 of it is on the 16x16 canvas; the rest was dropped \(create_sprite at 48x40/);
    expect(result.text).toMatch(/It looks 4x upscaled: normalize_pixel_art \{layer: "big"\} turns it into 12x10 pixel art\./);
  });

  it("refuses bad paths, files and placements without writing", async () => {
    expect(await h.error("import_image", { path: "hero.png" })).toMatch(/must be absolute/);
    expect(await h.error("import_image", { path: join(dir, "missing.png") })).toMatch(/does not exist/);
    expect(await h.error("import_image", { path: join(dir, ".secret", "x.png") })).toMatch(/hidden name/);
    expect(await h.error("import_image", { path: join(dir, "link.png") })).toMatch(/hidden "\.secret"/);
    expect(await h.error("import_image", { path: join(dir, "fake.png") })).toMatch(/Can't import .*not a PNG/);
    expect(await h.error("import_image", { path: join(dir, "hero.png"), x: 16 })).toMatch(/lies outside the 16x16 canvas/);
    expect(await h.error("import_image", { path: join(dir, "hero.png"), frame: 3 })).toMatch(/Frame 3 does not exist/);
    expect(gw.callsOf("writeImages")).toHaveLength(0);
  });

  it("maps colors onto an indexed sprite's palette and says so", async () => {
    gw.addSprite({ width: 8, height: 8, colorMode: "indexed" });
    const result = await h.call("import_image", { path: join(dir, "hero.png") });
    expect(result.text).toMatch(/Indexed sprite: its colors were mapped to the nearest palette colors\./);
  });
});
