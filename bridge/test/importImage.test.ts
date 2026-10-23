import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import zlib from "node:zlib";
import { PNG } from "pngjs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** An 8-bit RGBA PNG around the given compressed pixel stream (pngjs can't write interlaced files). */
function pngFile(width: number, height: number, interlace: 0 | 1, idat: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[12] = interlace;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))]);
}

/** `image` as an Adam7-interlaced PNG, every pass row unfiltered. */
function interlacedPng(image: RgbaImage): Buffer {
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  const bytes: number[] = [];
  for (const [x0, y0, dx, dy] of passes) {
    if (image.width <= x0) continue;
    for (let y = y0; y < image.height; y += dy) {
      bytes.push(0);
      for (let x = x0; x < image.width; x += dx) {
        const o = (y * image.width + x) * 4;
        bytes.push(...image.data.subarray(o, o + 4));
      }
    }
  }
  return pngFile(image.width, image.height, 1, zlib.deflateSync(Buffer.from(bytes)));
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

  it("decodes interlaced pixel art", () => {
    for (const [w, h] of [[13, 11], [1, 1], [3, 9]]) {
      const art = randomArt(w, h, w + h);
      expect(differingPixels(decodePng(interlacedPng(art), 1024), art)).toBe(0);
    }
  });

  it("refuses an interlaced PNG whose pixel data inflates past its header size, before pngjs inflates it", () => {
    // 1024x1024 RGBA needs ~4.2 MB; this 32 kB stream inflates to 32 MB (a decompression bomb).
    const bomb = pngFile(1024, 1024, 1, zlib.deflateSync(Buffer.alloc(32 * 1024 * 1024)));
    expect(bomb.length).toBeLessThan(64 * 1024);
    const inflate = vi.spyOn(zlib, "inflateSync");
    let error: unknown;
    try {
      decodePng(bomb, 1024);
    } catch (thrown) {
      error = thrown;
    } finally {
      inflate.mockRestore();
    }
    // pngjs inflates interlaced data without a limit (a 16 MB file could take ~16 GB): it must
    // never get to the stream, and nothing bigger than the image may be inflated at all.
    const sizes = inflate.mock.results.flatMap((r) => (r.type === "return" ? [(r.value as Buffer).length] : []));
    expect(sizes.filter((n) => n > 4.5 * 1024 * 1024)).toEqual([]);
    expect(String(error)).toMatch(/pixel data is bigger than its 1024x1024 header says/);
  });

  it("reports a broken interlaced stream as undecodable", () => {
    const broken = interlacedPng(randomArt(8, 8, 1));
    const idat = broken.indexOf("IDAT");
    broken.fill(0xff, idat + 6, idat + 14);
    expect(() => decodePng(broken, 1024)).toThrow(/could not be decoded/);
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
