import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSelectionTools } from "../src/mcp/tools/selection.js";
import { FakeGateway } from "./fakes/FakeGateway.js";
import { toolHarness, type ToolHarness } from "./fakes/toolHarness.js";

let h: ToolHarness;
let gw: FakeGateway;

beforeEach(async () => {
  gw = new FakeGateway();
  gw.addSprite({ width: 16, height: 12, layers: ["Top"] });
  h = await toolHarness([registerSelectionTools], gw);
});
afterEach(() => h.close());

/** The fake's selection as '#'/'.' rows over the whole canvas. */
function selectionRows(): string[] {
  const s = gw.state();
  return Array.from({ length: s.height }, (_, y) =>
    Array.from({ length: s.width }, (_, x) => (s.selection?.[y * s.width + x] ? "#" : ".")).join(""),
  );
}

describe("get_selection", () => {
  it("says when nothing is selected", async () => {
    expect(await h.json("get_selection")).toEqual({
      isEmpty: true,
      note: "Nothing is selected; pixel tools act on the whole layer.",
    });
  });

  it("reports bounds, pixel count and whether it is a rectangle", async () => {
    await gw.setSelection("replace", [[2, 3, 4, 2]]);
    expect(await h.json("get_selection")).toEqual({
      isEmpty: false,
      bounds: { x: 2, y: 3, width: 4, height: 2 },
      pixelCount: 8,
      isRectangle: true,
    });
  });

  it("returns the mask rows for small selections on request", async () => {
    await gw.setSelection("replace", [[1, 1, 2, 1], [2, 2, 2, 1]]);
    const result = await h.json("get_selection", { includeMask: true });
    expect(result).toMatchObject({ pixelCount: 4, isRectangle: false });
    expect(result.mask).toEqual({ x: 1, y: 1, rows: ["##.", ".##"] });
  });

  it("omits masks of large selections with a pointer to view_sprite", async () => {
    gw.addSprite({ width: 100, height: 80 });
    await gw.setSelection("all", []);
    const result = await h.json("get_selection", { includeMask: true });
    expect(result.mask).toBeUndefined();
    expect(result.maskOmitted).toMatch(/100x80.*up to 64x64.*view_sprite with region/);
    expect(result.pixelCount).toBe(8000);
  });
});

describe("set_selection: rect and ellipse", () => {
  it("selects a rect as one undo step", async () => {
    const result = await h.json("set_selection", { shape: "rect", x: 1, y: 2, width: 3, height: 4 });
    expect(gw.callsOf("setSelection")).toEqual([["replace", [[1, 2, 3, 4]], {}]]);
    expect(result).toEqual({
      isEmpty: false,
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      shape: "rect",
      mode: "replace",
      shapePixels: 12,
      note: "Tools with selectionOnly: true now change only the selected pixels.",
    });
    await gw.undo(1);
    expect(gw.state().selection).toBeNull();
  });

  it("clips rects to the canvas and refuses rects entirely outside", async () => {
    const result = await h.json("set_selection", { shape: "rect", x: 14, y: -1, width: 5, height: 3 });
    expect(result.bounds).toEqual({ x: 14, y: 0, width: 2, height: 2 });
    expect(await h.error("set_selection", { shape: "rect", x: 20, y: 0, width: 2, height: 2 })).toMatch(
      /outside the 16x12 canvas; selection unchanged/,
    );
  });

  it("needs a full box", async () => {
    expect(await h.error("set_selection", { shape: "ellipse", x: 1, y: 1, width: 3 })).toMatch(/needs x, y, width and height/);
  });

  it("selects an ellipse inscribed in the box using few rects", async () => {
    const result = await h.json("set_selection", { shape: "ellipse", x: 0, y: 0, width: 5, height: 5 });
    expect(result.shapePixels).toBe(21);
    expect(gw.callsOf("setSelection")[0][1]).toEqual([
      [1, 0, 3, 1],
      [0, 1, 5, 3],
      [1, 4, 3, 1],
    ]);
    expect(selectionRows().slice(0, 5).map((r) => r.slice(0, 5))).toEqual([".###.", "#####", "#####", "#####", ".###."]);
  });

  it("combines with the current selection", async () => {
    await h.json("set_selection", { shape: "rect", x: 0, y: 0, width: 4, height: 1 });
    await h.json("set_selection", { shape: "rect", x: 0, y: 1, width: 2, height: 1, mode: "add" });
    await h.json("set_selection", { shape: "rect", x: 1, y: 0, width: 1, height: 2, mode: "subtract" });
    expect(selectionRows().slice(0, 2).map((r) => r.slice(0, 4))).toEqual(["#.##", "#..."]);
    const result = await h.json("set_selection", { shape: "rect", x: 3, y: 0, width: 5, height: 5, mode: "intersect" });
    expect(result.bounds).toEqual({ x: 3, y: 0, width: 1, height: 1 });
  });

  it("reports when a combination leaves nothing selected", async () => {
    await h.json("set_selection", { shape: "rect", x: 0, y: 0, width: 2, height: 2 });
    const result = await h.json("set_selection", { shape: "rect", x: 5, y: 5, width: 2, height: 2, mode: "intersect" });
    expect(result).toMatchObject({ isEmpty: true, note: expect.stringMatching(/Nothing is selected now/) });
  });
});

describe("set_selection: all, none, invert", () => {
  it("selects all, inverts and deselects", async () => {
    await h.json("set_selection", { shape: "rect", x: 0, y: 0, width: 16, height: 6 });
    const inverted = await h.json("set_selection", { shape: "invert" });
    expect(inverted).toMatchObject({ shape: "invert", bounds: { x: 0, y: 6, width: 16, height: 6 } });
    expect(inverted.mode).toBeUndefined();
    expect((await h.json("set_selection", { shape: "all" })).bounds).toEqual({ x: 0, y: 0, width: 16, height: 12 });
    expect((await h.json("set_selection", { shape: "none" })).isEmpty).toBe(true);
  });

  it("rejects arguments these shapes ignore", async () => {
    expect(await h.error("set_selection", { shape: "all", mode: "add" })).toMatch(/'all' does not use mode\. It takes no other arguments/);
  });
});

describe("set_selection: color", () => {
  beforeEach(() => {
    gw.fillRect({ layer: "Layer 1", x: 0, y: 0, width: 16, height: 12, color: "#0000ff" });
    gw.fillRect({ layer: "Top", x: 2, y: 2, width: 2, height: 2, color: "#ff0000" });
    gw.fillRect({ layer: "Top", x: 10, y: 5, width: 1, height: 1, color: "#ff0000" });
    gw.fillRect({ layer: "Top", x: 12, y: 8, width: 1, height: 1, color: "#f80000" });
  });

  it("matches a color on the visible image", async () => {
    const result = await h.json("set_selection", { shape: "color", color: "#ff0000" });
    expect(result).toMatchObject({ shapePixels: 5, color: "#ff0000ff", bounds: { x: 2, y: 2, width: 9, height: 4 } });
    expect(gw.callsOf("readImage")[0][0]).toMatchObject({ flattened: true });
  });

  it("widens the match with tolerance", async () => {
    expect((await h.json("set_selection", { shape: "color", color: "#ff0000", tolerance: 5 })).shapePixels).toBe(6);
  });

  it("reads a single layer when asked", async () => {
    const result = await h.json("set_selection", { shape: "color", color: "transparent", layer: "Top" });
    expect(result.shapePixels).toBe(16 * 12 - 6);
    expect(gw.callsOf("readImage")[0][0]).toMatchObject({ layer: "Top" });
  });

  it("samples the color at x, y when no color is given", async () => {
    const result = await h.json("set_selection", { shape: "color", x: 0, y: 0 });
    expect(result).toMatchObject({ color: "#0000ffff", shapePixels: 16 * 12 - 6 });
  });

  it("magic wand selects only the connected area", async () => {
    const result = await h.json("set_selection", { shape: "color", x: 3, y: 3, contiguous: true });
    expect(result).toMatchObject({ shapePixels: 4, bounds: { x: 2, y: 2, width: 2, height: 2 } });
  });

  it("explains how to fix a call that matches nothing, leaving the selection alone", async () => {
    const message = await h.error("set_selection", { shape: "color", color: "#00ff00" });
    expect(message).toMatch(/No pixels of the visible image match #00ff00ff within tolerance 0; selection unchanged\. Raise tolerance/);
    expect(gw.callsOf("setSelection")).toHaveLength(0);
  });

  it("validates the color arguments", async () => {
    expect(await h.error("set_selection", { shape: "color" })).toMatch(/needs color, or x and y/);
    expect(await h.error("set_selection", { shape: "color", color: "#ff0000", contiguous: true })).toMatch(/contiguous: true needs x and y/);
    expect(await h.error("set_selection", { shape: "color", color: "#ff0000", x: 1, y: 1 })).toMatch(/only used with contiguous: true/);
    expect(await h.error("set_selection", { shape: "color", x: 1 })).toMatch(/both x and y/);
    expect(await h.error("set_selection", { shape: "color", x: 40, y: 1 })).toMatch(/\(40, 1\) is outside the 16x12 canvas/);
    expect(await h.error("set_selection", { shape: "color", color: "reddish" })).toMatch(/Invalid color "reddish"/);
    expect(await h.error("set_selection", { shape: "color", color: "#ff0000", tolerance: 101 })).toMatch(/Input validation error/);
  });
});

describe("set_selection: opaque", () => {
  it("selects the drawn pixels of the active layer", async () => {
    gw.fillRect({ layer: "Top", x: 4, y: 4, width: 3, height: 2, color: "#ffffff" });
    const result = await h.json("set_selection", { shape: "opaque" });
    expect(result).toMatchObject({ shapePixels: 6, bounds: { x: 4, y: 4, width: 3, height: 2 } });
    expect(gw.callsOf("setSelection")[0][1]).toEqual([[4, 4, 3, 2]]);
  });

  it("reads another layer and frame when asked", async () => {
    gw.addSprite({ width: 4, height: 4, frames: 2 });
    gw.fillRect({ layer: "Layer 1", frame: 2, x: 0, y: 0, width: 1, height: 1, color: "#ffffff" });
    const result = await h.json("set_selection", { shape: "opaque", layer: "Layer 1", frame: 2 });
    expect(result.shapePixels).toBe(1);
  });

  it("refuses an empty layer", async () => {
    expect(await h.error("set_selection", { shape: "opaque" })).toMatch(/The active layer has no visible pixels on frame 1/);
  });
});
