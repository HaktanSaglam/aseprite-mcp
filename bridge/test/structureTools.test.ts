import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatDurations, registerAnimationTools, toFrameOp, toTagOp } from "../src/mcp/tools/animation.js";
import { registerLayerTools, toLayerOp } from "../src/mcp/tools/layers.js";
import { FakeGateway } from "./fakes/FakeGateway.js";
import { toolHarness, type ToolHarness } from "./fakes/toolHarness.js";

let h: ToolHarness;
let gw: FakeGateway;

beforeEach(async () => {
  gw = new FakeGateway();
  h = await toolHarness([registerLayerTools, registerAnimationTools], gw);
});
afterEach(() => h.close());

const names = (result: { layers: { name: string }[] }) => result.layers.map((l) => l.name);

describe("manage_layers", () => {
  beforeEach(() => {
    gw.addSprite({ width: 4, height: 4, layers: ["Body"] });
  });

  it("adds a layer and returns the stack bottom to top", async () => {
    const result = await h.json("manage_layers", { action: "add", name: "AI" });
    expect(result).toMatchObject({ ok: true, action: "add", layer: "AI", order: "bottom to top" });
    expect(names(result)).toEqual(["Layer 1", "Body", "AI"]);
    expect(result.layers[2]).toEqual({ name: "AI", visible: true, opacity: 255, blendMode: "normal" });
  });

  it("adds above a given layer and inside groups, reporting paths", async () => {
    await h.json("manage_layers", { action: "add", name: "Fx", above: "Layer 1" });
    await h.json("manage_layers", { action: "add", name: "Char", isGroup: true });
    const result = await h.json("manage_layers", { action: "add", name: "Arm", group: "Char" });
    expect(names(result)).toEqual(["Layer 1", "Fx", "Body", "Char", "Arm"]);
    expect(result.layers[3]).toMatchObject({ name: "Char", group: true });
    expect(result.layers[4]).toMatchObject({ name: "Arm", path: "Char/Arm" });
  });

  it("refuses duplicate names and non-group parents", async () => {
    expect(await h.error("manage_layers", { action: "add", name: "Body" })).toMatch(/named "Body" already exists/);
    expect(await h.error("manage_layers", { action: "add", name: "X", group: "Body" })).toMatch(/"Body" is not a group/);
  });

  it("updates visibility, opacity, blend mode, lock and name", async () => {
    const result = await h.json("manage_layers", {
      action: "update",
      name: "Body",
      newName: "Torso",
      visible: false,
      opacity: 128,
      blendMode: "multiply",
      editable: false,
    });
    expect(result.layers[1]).toEqual({ name: "Torso", visible: false, opacity: 128, blendMode: "multiply", locked: true });
  });

  it("needs something to update and validates ranges", async () => {
    expect(await h.error("manage_layers", { action: "update", name: "Body" })).toMatch(/needs at least one of newName/);
    expect(await h.error("manage_layers", { action: "update", name: "Body", opacity: 300 })).toMatch(/Input validation error/);
    expect(await h.error("manage_layers", { action: "update", name: "Body", blendMode: "glow" })).toMatch(/Input validation error/);
  });

  it("lists the existing layers when a name is wrong", async () => {
    expect(await h.error("manage_layers", { action: "delete", name: "Bdy" })).toMatch(/Layer "Bdy" not found\. Layers: Layer 1, Body/);
  });

  it("names arguments the action ignores", async () => {
    expect(await h.error("manage_layers", { action: "update", name: "Body", above: "Layer 1" })).toMatch(
      /'update' does not use above/,
    );
  });

  it("moves layers above, below and between groups", async () => {
    let result = await h.json("manage_layers", { action: "move", name: "Layer 1", above: "Body" });
    expect(names(result)).toEqual(["Body", "Layer 1"]);
    result = await h.json("manage_layers", { action: "move", name: "Layer 1", below: "Body" });
    expect(names(result)).toEqual(["Layer 1", "Body"]);
    await h.json("manage_layers", { action: "add", name: "G", isGroup: true });
    result = await h.json("manage_layers", { action: "move", name: "Body", group: "G" });
    expect(result.layers.find((l: { name: string }) => l.name === "Body").path).toBe("G/Body");
    result = await h.json("manage_layers", { action: "move", name: "G/Body", group: "" });
    expect(names(result)).toEqual(["Layer 1", "G", "Body"]);
  });

  it("validates moves", async () => {
    expect(await h.error("manage_layers", { action: "move", name: "Body" })).toMatch(/needs above, below or group/);
    expect(await h.error("manage_layers", { action: "move", name: "Body", above: "Layer 1", below: "Layer 1" })).toMatch(
      /either above or below/,
    );
    expect(await h.error("manage_layers", { action: "move", name: "Body", above: "Body" })).toMatch(/relative to itself/);
    await h.json("manage_layers", { action: "add", name: "G", isGroup: true });
    expect(await h.error("manage_layers", { action: "move", name: "G", group: "G" })).toMatch(/into itself/);
  });

  it("duplicates, merges down, activates and deletes", async () => {
    gw.fillRect({ layer: "Body", x: 0, y: 0, width: 1, height: 1, color: "#ff0000" });
    let result = await h.json("manage_layers", { action: "duplicate", name: "Body", newName: "Body 2" });
    expect(names(result)).toEqual(["Layer 1", "Body", "Body 2"]);
    expect(gw.pixel("Body 2", 0, 0)).toEqual([255, 0, 0, 255]);

    result = await h.json("manage_layers", { action: "merge_down", name: "Body" });
    expect(result.layer).toBe("Layer 1");
    expect(names(result)).toEqual(["Layer 1", "Body 2"]);
    expect(gw.pixel("Layer 1", 0, 0)).toEqual([255, 0, 0, 255]);

    result = await h.json("manage_layers", { action: "activate", name: "Body 2" });
    expect(result.activeLayer).toBe("Body 2");

    result = await h.json("manage_layers", { action: "delete", name: "Body 2" });
    expect(names(result)).toEqual(["Layer 1"]);
    expect(await h.error("manage_layers", { action: "delete", name: "Layer 1" })).toMatch(/needs at least one layer/);
  });

  it("refuses to merge the bottom layer", async () => {
    expect(await h.error("manage_layers", { action: "merge_down", name: "Layer 1" })).toMatch(/is the bottom layer; there is nothing below/);
  });

  it("is one undo step per call", async () => {
    await h.json("manage_layers", { action: "add", name: "AI" });
    await gw.undo(1);
    expect(gw.state().layers.map((l) => l.name)).toEqual(["Layer 1", "Body"]);
  });
});

describe("toLayerOp", () => {
  const layers = [
    { name: "G", path: "G", isGroup: true, isVisible: true, isEditable: true, opacity: 255, blendMode: "normal" as const, stackIndex: 1 },
    { name: "Arm", path: "G/Arm", isGroup: false, isVisible: true, isEditable: true, opacity: 255, blendMode: "normal" as const, stackIndex: 1, parent: "G" },
    { name: "Leg", path: "G/Leg", isGroup: false, isVisible: true, isEditable: true, opacity: 255, blendMode: "normal" as const, stackIndex: 2, parent: "G" },
  ];

  it("passes nested layers on by full path", () => {
    expect(toLayerOp({ action: "update", name: "Leg", visible: false }, layers)).toMatchObject({ op: "update", name: "G/Leg" });
    expect(toLayerOp({ action: "move", name: "Arm", above: "Leg" }, layers)).toMatchObject({ name: "G/Arm", above: "G/Leg" });
  });

  it("names the parent group when merging its bottom layer", () => {
    expect(() => toLayerOp({ action: "merge_down", name: "Arm" }, layers)).toThrow(/bottom layer of group "G"/);
    expect(toLayerOp({ action: "merge_down", name: "Leg" }, layers)).toEqual({ op: "merge_down", name: "G/Leg" });
  });
});

describe("manage_frames", () => {
  beforeEach(() => {
    gw.addSprite({ width: 2, height: 2 });
    gw.fillRect({ x: 0, y: 0, width: 1, height: 1, color: "#00ff00" });
  });

  it("adds copied frames and summarizes durations", async () => {
    const result = await h.json("manage_frames", { action: "add", count: 3, copy: true, durationMs: 120 });
    expect(result).toEqual({
      ok: true,
      action: "add",
      frameCount: 4,
      activeFrame: 1,
      durations: "1: 100ms, 2-4: 120ms",
      totalMs: 460,
    });
    expect(gw.pixel("Layer 1", 0, 0, 4)).toEqual([0, 255, 0, 255]);
  });

  it("adds empty frames after a given frame", async () => {
    await h.json("manage_frames", { action: "add", count: 2 });
    await h.json("manage_frames", { action: "add", after: 1 });
    expect(gw.pixel("Layer 1", 0, 0, 2)).toEqual([0, 0, 0, 0]);
    expect(gw.state().frames).toHaveLength(4);
  });

  it("sets durations for some or all frames", async () => {
    await h.json("manage_frames", { action: "add", count: 3 });
    let result = await h.json("manage_frames", { action: "duration", durationMs: 80 });
    expect(result.durations).toBe("1-4: 80ms");
    result = await h.json("manage_frames", { action: "duration", frames: [2, 3], durationMs: 200 });
    expect(result.durations).toBe("1: 80ms, 2-3: 200ms, 4: 80ms");
  });

  it("deletes frame ranges but never all of them", async () => {
    await h.json("manage_frames", { action: "add", count: 3 });
    expect((await h.json("manage_frames", { action: "delete", from: 2, to: 3 })).frameCount).toBe(2);
    expect(await h.error("manage_frames", { action: "delete", from: 1, to: 2 })).toMatch(/Cannot delete every frame/);
    expect(await h.error("manage_frames", { action: "delete" })).toMatch(/needs from/);
  });

  it("activates a frame and reports it", async () => {
    await h.json("manage_frames", { action: "add" });
    expect((await h.json("manage_frames", { action: "activate", frame: 2 })).activeFrame).toBe(2);
    expect(await h.error("manage_frames", { action: "activate", frame: 5 })).toMatch(/Frame 5 out of range \(sprite has 2 frames\)/);
  });

  it("includes tags once there are any", async () => {
    await h.json("manage_frames", { action: "add", count: 3 });
    await h.json("manage_tags", { action: "add", name: "walk" });
    const result = await h.json("manage_frames", { action: "duration", durationMs: 90 });
    expect(result.tags).toEqual([{ name: "walk", from: 1, to: 4, direction: "forward", repeats: 0 }]);
  });
});

describe("toFrameOp", () => {
  it("validates ranges and required arguments", () => {
    expect(() => toFrameOp({ action: "add", after: 3 }, 2)).toThrow(/after: frame 3 out of range/);
    expect(() => toFrameOp({ action: "delete", from: 2, to: 1 }, 3)).toThrow(/must not be before/);
    expect(() => toFrameOp({ action: "duration" }, 3)).toThrow(/needs durationMs/);
    expect(() => toFrameOp({ action: "duration", durationMs: 50, frames: [4] }, 3)).toThrow(/Frame 4 out of range/);
    expect(() => toFrameOp({ action: "activate" }, 3)).toThrow(/needs frame/);
    expect(() => toFrameOp({ action: "activate", frame: 1, count: 2 }, 3)).toThrow(/'activate' does not use count/);
  });

  it("deduplicates frame lists", () => {
    expect(toFrameOp({ action: "duration", durationMs: 50, frames: [2, 2, 1] }, 3)).toEqual({
      op: "duration",
      frames: [2, 1],
      durationMs: 50,
    });
  });
});

describe("manage_tags", () => {
  beforeEach(() => {
    gw.addSprite({ width: 2, height: 2, frames: 8 });
  });

  it("adds tags spanning all frames by default", async () => {
    const result = await h.json("manage_tags", { action: "add", name: "idle" });
    expect(result).toEqual({
      ok: true,
      action: "add",
      tags: [{ name: "idle", from: 1, to: 8, direction: "forward", repeats: 0 }],
      frameCount: 8,
    });
  });

  it("adds, updates and deletes tags", async () => {
    await h.json("manage_tags", { action: "add", name: "walk", from: 1, to: 4, direction: "pingpong", color: "#ff0000" });
    expect(gw.callsOf("tagOp")[0][0]).toMatchObject({ color: "#ff0000" });
    let result = await h.json("manage_tags", { action: "update", name: "walk", newName: "run", to: 6, repeats: 2 });
    expect(result.tags).toEqual([{ name: "run", from: 1, to: 6, direction: "pingpong", repeats: 2 }]);
    result = await h.json("manage_tags", { action: "delete", name: "run" });
    expect(result.tags).toEqual([]);
  });

  it("validates names, ranges and colors", async () => {
    await h.json("manage_tags", { action: "add", name: "walk", from: 1, to: 4 });
    expect(await h.error("manage_tags", { action: "add", name: "walk" })).toMatch(/already exists; use action 'update'/);
    expect(await h.error("manage_tags", { action: "add", name: "jump", from: 5, to: 3 })).toMatch(/reversed/);
    expect(await h.error("manage_tags", { action: "add", name: "jump", from: 5, to: 9 })).toMatch(/to: frame 9 out of range/);
    expect(await h.error("manage_tags", { action: "update", name: "walk", from: 6 })).toMatch(/Tag range 6-4 is reversed/);
    expect(await h.error("manage_tags", { action: "update", name: "walk" })).toMatch(/needs at least one of/);
    expect(await h.error("manage_tags", { action: "delete", name: "run" })).toMatch(/Tag "run" not found\. Tags: walk/);
    expect(await h.error("manage_tags", { action: "add", name: "x", color: "red" })).toMatch(/Use #rrggbb/);
    await h.json("manage_tags", { action: "update", name: "walk", color: "#00ff00" });
    expect(gw.callsOf("tagOp").at(-1)?.[0]).toMatchObject({ op: "update", color: "#00ff00" });
  });
});

describe("toTagOp", () => {
  it("allows renaming a tag to its own name", () => {
    const info = {
      frames: [{ index: 1, durationMs: 100 }],
      tags: [{ name: "a", from: 1, to: 1, direction: "forward" as const, repeats: 0 }],
    } as Parameters<typeof toTagOp>[1];
    expect(toTagOp({ action: "update", name: "a", newName: "a" }, info)).toMatchObject({ op: "update", name: "a" });
  });
});

describe("formatDurations", () => {
  it("groups runs of equal durations", () => {
    const frames = [100, 100, 250, 100].map((durationMs, i) => ({ index: i + 1, durationMs }));
    expect(formatDurations(frames)).toBe("1-2: 100ms, 3: 250ms, 4: 100ms");
  });

  it("only joins consecutive frame numbers of a subset", () => {
    expect(formatDurations([{ index: 3, durationMs: 50 }, { index: 7, durationMs: 50 }])).toBe("3: 50ms, 7: 50ms");
    expect(formatDurations([{ index: 3, durationMs: 50 }, { index: 4, durationMs: 50 }])).toBe("3-4: 50ms");
    expect(formatDurations([])).toBe("");
  });
});
