import { describe, expect, it } from "vitest";
import { ScopedAsepriteGateway } from "../src/aseprite/ScopedAsepriteGateway.js";
import { scopeToolContext } from "../src/mcp/createMcpServer.js";
import type { ToolContext } from "../src/mcp/ToolContext.js";
import { createRgbaImage } from "../src/pixel/RgbaImage.js";
import { FakeGateway } from "./chatFakes.js";

function setup() {
  const inner = new FakeGateway();
  inner.addSprite({ id: 3 });
  inner.addSprite({ id: 7 }); // the user's active tab is another sprite
  return { inner, scoped: new ScopedAsepriteGateway(inner, 3) };
}

describe("ScopedAsepriteGateway", () => {
  it("binds calls without a sprite to its own sprite, not the active one", async () => {
    const { inner, scoped } = setup();
    expect((await scoped.getSpriteInfo()).id).toBe(3);
    await scoped.readImage({ x: 0, y: 0, width: 2, height: 2, frame: 1, layer: "L" });
    await scoped.writeImages([{ x: 0, y: 0, image: createRgbaImage(1, 1) }]);
    await scoped.readSelection({});
    await scoped.setSelection("all", []);
    await scoped.layerOp({ op: "add", name: "AI" });
    await scoped.frameOp({ op: "add" });
    await scoped.tagOp({ op: "add", name: "walk" });
    await scoped.getPalette();
    await scoped.setPalette(["#000000"]);
    await scoped.spriteOp({ op: "flip", direction: "horizontal" });
    await scoped.undo(1);
    await scoped.redo(2);
    await scoped.saveSprite({ path: "/x.aseprite" });
    await scoped.exportSprite({ path: "/x.png", kind: "png" });

    const sprites = inner.calls.map((c) => {
      const refArg = c.method === "readImage" || c.method === "readSelection" ? c.args[0] : c.args.at(-1);
      return [c.method, (refArg as { sprite?: number } | undefined)?.sprite];
    });
    for (const [method, sprite] of sprites) expect({ method, sprite }).toEqual({ method, sprite: 3 });
  });

  it("keeps the request's other read parameters", async () => {
    const { inner, scoped } = setup();
    await scoped.readImage({ x: 1, y: 2, width: 3, height: 4, frame: 1, flattened: true });
    expect(inner.callsOf("readImage")[0].args[0]).toEqual({ x: 1, y: 2, width: 3, height: 4, frame: 1, flattened: true, sprite: 3 });
  });

  it("accepts its own sprite id explicitly and refuses others", async () => {
    const { scoped } = setup();
    await expect(scoped.getSpriteInfo({ sprite: 3 })).resolves.toMatchObject({ id: 3 });
    await expect(scoped.getSpriteInfo({ sprite: 7 })).rejects.toThrow(/own sprite \(#3\).*cannot edit sprite #7/);
    await expect(scoped.readImage({ sprite: 7 })).rejects.toThrow(/cannot edit sprite #7/);
  });

  it("refuses by rejecting, never by throwing synchronously (callers use .catch)", () => {
    const { scoped } = setup();
    expect(() => void scoped.writeImages([], { sprite: 7 }).catch(() => {})).not.toThrow();
    expect(() => void scoped.createSprite({ width: 1, height: 1 }).catch(() => {})).not.toThrow();
  });

  it("refuses to create or switch sprites with an actionable error", async () => {
    const { inner, scoped } = setup();
    await expect(scoped.createSprite({ width: 8, height: 8 })).rejects.toThrow(
      /This job draws into its own sprite \(#3\) and cannot create new sprites.*edit_sprite/,
    );
    await expect(scoped.activateSprite(7)).rejects.toThrow(/cannot switch to sprite #7/);
    expect(inner.callsOf("createSprite")).toHaveLength(0);
    expect(inner.callsOf("activateSprite")).toHaveLength(0);
  });

  it("treats activating its own sprite as a no-op instead of stealing the user's tab", async () => {
    const { inner, scoped } = setup();
    await scoped.activateSprite(3);
    expect(inner.callsOf("activateSprite")).toHaveLength(0);
    expect(inner.active).toBe(7);
  });

  it("lets listSprites through", async () => {
    const { scoped } = setup();
    expect((await scoped.listSprites()).map((s) => s.id)).toEqual([3, 7]);
  });
});

describe("scopeToolContext", () => {
  it("rebuilds the canvas on the scoped gateway and keeps the other services", async () => {
    const inner = new FakeGateway();
    inner.addSprite({ id: 3 });
    inner.addSprite({ id: 7 });
    const scripts = { run: async () => ({ image: createRgbaImage(1, 1), calls: 0, elapsedMs: 0 }) };
    const base = { gateway: inner, canvas: {} as ToolContext["canvas"], scripts } satisfies ToolContext;

    const ctx = scopeToolContext(base, 3);
    expect(ctx.scripts).toBe(scripts);
    expect(ctx.gateway).toBeInstanceOf(ScopedAsepriteGateway);

    await ctx.canvas.paint([{ x: 0, y: 0, image: createRgbaImage(1, 1) }]);
    const write = inner.callsOf("writeImages")[0];
    expect(write.args[1]).toEqual({ sprite: 3 });
    expect(inner.callsOf("readImage").every((c) => (c.args[0] as { sprite: number }).sprite === 3)).toBe(true);
  });
});
