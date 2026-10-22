import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerDocumentTools } from "../src/mcp/tools/document.js";
import { registerSpriteTools } from "../src/mcp/tools/sprite.js";
import { FakeGateway } from "./fakes/FakeGateway.js";
import { toolHarness, type ToolHarness } from "./fakes/toolHarness.js";

let h: ToolHarness;
let gw: FakeGateway;

beforeEach(async () => {
  gw = new FakeGateway();
  h = await toolHarness([registerSpriteTools, registerDocumentTools], gw);
});
afterEach(() => h.close());

const dir = mkdtempSync(join(tmpdir(), "amcp-doc-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("list_sprites / select_sprite", () => {
  it("lists every open sprite with a readable name", async () => {
    gw.addSprite({ width: 8, height: 8, filename: "/art/hero.aseprite" });
    gw.addSprite({ width: 4, height: 2 });
    const { sprites } = await h.json("list_sprites");
    expect(sprites).toHaveLength(2);
    expect(sprites[0]).toMatchObject({ id: 1, name: "hero.aseprite", width: 8, isActive: false });
    expect(sprites[1]).toMatchObject({ id: 2, name: "Sprite-0002", isActive: true });
  });

  it("switches the active sprite and returns its info", async () => {
    const a = gw.addSprite({ width: 8, height: 8 });
    gw.addSprite({ width: 4, height: 2 });
    const info = await h.json("select_sprite", { id: a });
    expect(info).toMatchObject({ id: a, width: 8 });
    expect(gw.activeId).toBe(a);
  });

  it("names the open sprites when the id is unknown", async () => {
    gw.addSprite({ width: 8, height: 8, filename: "/art/hero.aseprite" });
    expect(await h.error("select_sprite", { id: 99 })).toMatch(/No open sprite has id 99.*1 \(hero\.aseprite, 8x8\)/);
  });
});

describe("edit_sprite", () => {
  beforeEach(() => {
    gw.addSprite({ width: 16, height: 8 });
  });

  it("resizes keeping the aspect ratio when only width is given", async () => {
    const result = await h.json("edit_sprite", { action: "resize", width: 32 });
    expect(gw.callsOf("spriteOp")[0][0]).toEqual({ op: "resize", width: 32, height: 16, method: "nearest" });
    expect(result).toMatchObject({ action: "resize", before: { width: 16, height: 8 }, width: 32, height: 16, frames: 1, layers: 1 });
  });

  it("resizes by scale", async () => {
    expect(await h.json("edit_sprite", { action: "resize", scale: 0.5 })).toMatchObject({ width: 8, height: 4 });
  });

  it("rejects ambiguous or missing resize sizes", async () => {
    expect(await h.error("edit_sprite", { action: "resize", scale: 2, width: 3 })).toMatch(/either scale or width/);
    expect(await h.error("edit_sprite", { action: "resize" })).toMatch(/needs width and\/or height, or scale/);
    expect(await h.error("edit_sprite", { action: "resize", width: 5000 })).toMatch(/maximum is 2048/);
  });

  it("names arguments the action does not use", async () => {
    expect(await h.error("edit_sprite", { action: "resize", width: 8, x: 2 })).toMatch(
      /'resize' does not use x\. It takes: width, height, scale, method/,
    );
  });

  it("grows the canvas and refuses no-op or empty canvases", async () => {
    expect(await h.json("edit_sprite", { action: "canvas", left: 2, bottom: 4 })).toMatchObject({ width: 18, height: 12 });
    expect(await h.error("edit_sprite", { action: "canvas" })).toMatch(/needs left, top, right and\/or bottom/);
    expect(await h.error("edit_sprite", { action: "canvas", right: -18 })).toMatch(/at least 1/);
  });

  it("crops to a rect, or to the selection when no rect is given", async () => {
    expect(await h.json("edit_sprite", { action: "crop", x: 2, y: 1, width: 4, height: 3 })).toMatchObject({ width: 4, height: 3 });
    await gw.setSelection("replace", [[1, 1, 2, 2]]);
    await h.json("edit_sprite", { action: "crop" });
    expect(gw.callsOf("spriteOp")[1][0]).toEqual({ op: "crop", x: 1, y: 1, width: 2, height: 2 });
  });

  it("explains how to crop without a selection or outside the canvas", async () => {
    expect(await h.error("edit_sprite", { action: "crop" })).toMatch(/or an active selection/);
    expect(await h.error("edit_sprite", { action: "crop", x: 10, y: 0, width: 10, height: 2 })).toMatch(
      /must lie inside the 16x8 canvas; use action 'canvas'/,
    );
    expect(await h.error("edit_sprite", { action: "crop", width: 2 })).toMatch(/both width and height/);
  });

  it("trims transparent margins using the art of every frame", async () => {
    gw.addSprite({ width: 16, height: 8, frames: 2 });
    gw.fillRect({ frame: 1, x: 3, y: 2, width: 2, height: 2, color: "#ff0000" });
    gw.fillRect({ frame: 2, x: 6, y: 1, width: 1, height: 1, color: "#00ff00" });
    const result = await h.json("edit_sprite", { action: "trim" });
    expect(gw.callsOf("spriteOp")[0][0]).toEqual({ op: "crop", x: 3, y: 1, width: 4, height: 3 });
    expect(result).toMatchObject({ width: 4, height: 3, before: { width: 16, height: 8 } });
  });

  it("reports when trimming would change nothing or the sprite is empty", async () => {
    expect(await h.error("edit_sprite", { action: "trim" })).toMatch(/no visible pixels; there is nothing to trim/);
    gw.fillRect({ x: 0, y: 0, width: 16, height: 8, color: "#ffffff" });
    expect((await h.json("edit_sprite", { action: "trim" })).unchanged).toMatch(/already touches every edge/);
    expect(gw.callsOf("spriteOp")).toHaveLength(0);
    expect(await h.error("edit_sprite", { action: "trim", width: 3 })).toMatch(/'trim' does not use width\. It takes no other arguments/);
  });

  it("skips converting to the color mode the sprite already has", async () => {
    const result = await h.json("edit_sprite", { action: "color_mode", mode: "rgb" });
    expect(result.unchanged).toMatch(/already rgb/);
    expect(gw.callsOf("spriteOp")).toHaveLength(0);
    expect(await h.json("edit_sprite", { action: "color_mode", mode: "indexed" })).toMatchObject({ colorMode: "indexed" });
  });

  it("rotates and flips the whole sprite", async () => {
    gw.fillRect({ x: 0, y: 0, width: 1, height: 1, color: "#ff0000" });
    expect(await h.json("edit_sprite", { action: "rotate", angle: 90 })).toMatchObject({ width: 8, height: 16 });
    expect(gw.pixel("Layer 1", 7, 0)).toEqual([255, 0, 0, 255]);
    await h.json("edit_sprite", { action: "flip", direction: "horizontal" });
    expect(gw.pixel("Layer 1", 0, 0)).toEqual([255, 0, 0, 255]);
    expect(await h.error("edit_sprite", { action: "rotate" })).toMatch(/needs angle/);
    expect(await h.error("edit_sprite", { action: "rotate", angle: 45 })).toMatch(/Input validation error/);
    expect(await h.error("edit_sprite", { action: "flip" })).toMatch(/needs direction/);
  });
});

describe("undo / redo", () => {
  it("reverts and reapplies whole tool calls", async () => {
    gw.addSprite({ width: 16, height: 8 });
    await h.json("edit_sprite", { action: "resize", scale: 2 });
    await h.json("edit_sprite", { action: "canvas", right: 1 });
    expect((await h.call("undo", { steps: 2 })).text).toBe("Undid 2 steps.");
    expect(gw.state().width).toBe(16);
    expect((await h.call("redo")).text).toBe("Redid 1 step.");
    expect(gw.state().width).toBe(32);
  });

  it("validates steps", async () => {
    gw.addSprite();
    expect(await h.error("undo", { steps: 0 })).toMatch(/Input validation error/);
  });
});

describe("save_sprite", () => {
  it("asks for a path when the sprite was never saved", async () => {
    gw.addSprite();
    expect(await h.error("save_sprite")).toMatch(/has never been saved; pass path, e\.g\. ~\/Desktop\/Sprite-0001\.aseprite/);
  });

  it("saves as a new file and then to that file", async () => {
    gw.addSprite();
    const path = join(dir, "first.aseprite");
    expect(await h.json("save_sprite", { path })).toMatchObject({ ok: true, path, copy: false });
    expect(gw.state().filename).toBe(path);
    writeFileSync(path, "saved");
    // Saving over its own file is a normal save, not an accidental overwrite.
    await h.json("save_sprite", { path });
    expect(await h.json("save_sprite")).toEqual({ ok: true, path });
    expect(gw.saves.map((s) => s.path)).toEqual([path, path, path]);
  });

  it("protects other existing files unless overwrite is set", async () => {
    gw.addSprite();
    const other = join(dir, "other.aseprite");
    writeFileSync(other, "user file");
    expect(await h.error("save_sprite", { path: other })).toMatch(/already exists; pass overwrite: true/);
    await h.json("save_sprite", { path: other, overwrite: true });
  });

  it("keeps the document's file name when saving a copy", async () => {
    gw.addSprite();
    await h.json("save_sprite", { path: join(dir, "copy.aseprite"), copy: true });
    expect(gw.state().filename).toBe("Sprite-0001");
    expect(gw.saves[0]).toMatchObject({ copy: true });
  });

  it("rejects relative paths and unknown extensions", async () => {
    gw.addSprite();
    expect(await h.error("save_sprite", { path: "art.aseprite" })).toMatch(/must be absolute/);
    expect(await h.error("save_sprite", { path: join(dir, "a.psd") })).toMatch(/\.aseprite, \.ase, \.png, \.gif/);
  });
});

describe("export_sprite", () => {
  beforeEach(async () => {
    gw.addSprite({ width: 8, height: 4, frames: 3 });
    await gw.tagOp({ op: "add", name: "walk", from: 2, to: 3 });
  });

  it("infers png from the extension and scales the frame", async () => {
    const path = join(dir, "frame.png");
    const result = await h.json("export_sprite", { path, frame: 2, scale: 4 });
    expect(gw.exports[0]).toMatchObject({ path, kind: "png", frame: 2, scale: 4 });
    expect(result).toEqual({ ok: true, kind: "png", files: [path], frames: 1, frameSize: "32x16" });
  });

  it("infers gif and exports a tag", async () => {
    const result = await h.json("export_sprite", { path: join(dir, "walk.gif"), tag: "walk" });
    expect(result).toMatchObject({ kind: "gif", frames: 2 });
  });

  it("needs a known extension or an explicit kind", async () => {
    expect(await h.error("export_sprite", { path: join(dir, "x.webp") })).toMatch(/end the path with \.png or \.gif, or pass kind/);
    expect(await h.error("export_sprite", { path: join(dir, "x.gif"), kind: "png" })).toMatch(/must end with \.png/);
  });

  it("describes numbered frame files and protects an existing sequence", async () => {
    const path = join(dir, "seq.png");
    const result = await h.json("export_sprite", { path, kind: "frames" });
    expect(result.files).toEqual([`${join(dir, "seq-1.png")} … ${join(dir, "seq-3.png")}`]);
    writeFileSync(join(dir, "seq-2.png"), "old");
    expect(await h.error("export_sprite", { path, kind: "frames" })).toMatch(/seq-2\.png" already exists/);
    await h.json("export_sprite", { path, kind: "frames", overwrite: true });
  });

  it("exports sheets with layout and json data", async () => {
    const path = join(dir, "sheet.png");
    const dataPath = join(dir, "sheet.json");
    await h.json("export_sprite", { path, kind: "sheet", columns: 2, dataPath });
    expect(gw.exports[0]).toEqual({ path, kind: "sheet", sheetType: "rows", columns: 2, dataPath, sprite: 1 });
    await h.json("export_sprite", { path: join(dir, "strip.png"), kind: "sheet" });
    expect(gw.exports[1].sheetType).toBe("horizontal");
    expect(await h.error("export_sprite", { path, kind: "sheet", dataPath: join(dir, "d.txt") })).toMatch(/^dataPath must end with \.json/);
  });

  it("rejects options that do not fit the kind", async () => {
    const png = join(dir, "o.png");
    expect(await h.error("export_sprite", { path: join(dir, "o.gif"), frame: 1 })).toMatch(/frame only applies to kind 'png'/);
    expect(await h.error("export_sprite", { path: png, tag: "walk" })).toMatch(/tag does not apply to a single png/);
    expect(await h.error("export_sprite", { path: png, kind: "sheet", scale: 2 })).toMatch(/scale is not available for sheets/);
    expect(await h.error("export_sprite", { path: png, columns: 2 })).toMatch(/columns only applies to kind 'sheet'/);
  });

  it("checks frames and tags against the sprite", async () => {
    expect(await h.error("export_sprite", { path: join(dir, "f.png"), frame: 9 })).toMatch(/Frame 9 out of range \(sprite has 3 frames\)/);
    expect(await h.error("export_sprite", { path: join(dir, "t.gif"), tag: "run" })).toMatch(/Tag "run" not found\. Tags: walk/);
  });
});

describe("sequenceName", () => {
  it("pads frame numbers to the frame count", async () => {
    const { sequenceName } = await import("../src/mcp/tools/document.js");
    const { join } = await import("node:path");
    expect(sequenceName(join("a", "hero.png"), 3, 12)).toBe(join("a", "hero-03.png"));
    expect(sequenceName(join("a", "hero.png"), 3, 9)).toBe(join("a", "hero-3.png"));
  });
});
