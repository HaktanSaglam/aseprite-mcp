import { describe, expect, it } from "vitest";
import { RpcAsepriteGateway } from "../src/aseprite/RpcAsepriteGateway.js";
import { ScopedAsepriteGateway } from "../src/aseprite/ScopedAsepriteGateway.js";
import { SpriteActivity } from "../src/aseprite/SpriteActivity.js";
import { TrackingAsepriteGateway } from "../src/aseprite/TrackingAsepriteGateway.js";
import { createRgbaImage } from "../src/pixel/RgbaImage.js";
import { FakeGateway } from "./fakes/FakeGateway.js";

function setup() {
  const fake = new FakeGateway();
  const activity = new SpriteActivity();
  const gateway = new TrackingAsepriteGateway(fake, activity);
  const sprite = fake.addSprite({ width: 4, height: 4, frames: 2 });
  return { fake, activity, gateway, sprite, ref: { sprite } };
}

const pixel = () => createRgbaImage(1, 1);

describe("SpriteActivity + TrackingAsepriteGateway", () => {
  it("counts one undo step per mutating call and none for reads or activation", async () => {
    const { gateway, activity, sprite, ref } = setup();
    const watch = activity.watch(sprite);
    await gateway.getSpriteInfo(ref);
    await gateway.readImage({ ...ref, frame: 1 });
    await gateway.writeImages([{ x: 0, y: 0, image: pixel(), layer: "AI", frame: 2 }], ref);
    await gateway.writeImages([], ref); // never reaches Aseprite
    await gateway.layerOp({ op: "add", name: "Extra" }, ref);
    await gateway.layerOp({ op: "activate", name: "Extra" }, ref);
    await gateway.frameOp({ op: "add", count: 2 }, ref);
    await gateway.frameOp({ op: "activate", frame: 1 }, ref);
    await gateway.tagOp({ op: "add", name: "walk" }, ref);
    await gateway.setSelection("all", [], ref);
    await gateway.setPalette(["#000000", "#ffffff"], ref);
    await gateway.spriteOp({ op: "flip", direction: "horizontal" }, ref);
    await gateway.saveSprite({ path: "/tmp/x.aseprite" }, ref);
    expect(watch.undoSteps).toBe(7);
  });

  it("nets undo and redo inside the watch, and redo restores older steps first", async () => {
    const { gateway, activity, sprite, ref } = setup();
    await gateway.tagOp({ op: "add", name: "before" }, ref); // the user's step, before the run
    const watch = activity.watch(sprite);
    await gateway.tagOp({ op: "add", name: "a" }, ref);
    await gateway.tagOp({ op: "add", name: "b" }, ref);
    await gateway.undo(3, ref); // b, a and the older step
    expect(watch.undoSteps).toBe(0);
    await gateway.redo(1, ref); // brings back the older step, not ours
    expect(watch.undoSteps).toBe(0);
    await gateway.redo(1, ref);
    expect(watch.undoSteps).toBe(1);
    await gateway.undo(1, ref);
    await gateway.tagOp({ op: "add", name: "c" }, ref); // a new change clears the redo stack
    await gateway.redo(5, ref);
    expect(watch.undoSteps).toBe(1);
  });

  it("records the cels writes and copy_cel drew, once each", async () => {
    const { gateway, activity, sprite, ref } = setup();
    const watch = activity.watch(sprite);
    await gateway.writeImages(
      [
        { x: 0, y: 0, image: pixel(), layer: "AI", frame: 1 },
        { x: 1, y: 0, image: pixel(), layer: "AI", frame: 1 },
        { x: 0, y: 0, image: pixel() },
      ],
      ref,
    );
    await gateway.frameOp({ op: "copy_cel", from: 1, to: 2 }, ref);
    await gateway.frameOp({ op: "copy_cel", from: 1, to: 2, layer: "AI", flip: "horizontal" }, ref);
    expect(watch.drawnCels).toEqual([
      { layer: "AI", frame: 1 },
      { layer: undefined, frame: undefined },
      { everyLayer: true, frame: 2 },
      { layer: "AI", frame: 2 },
    ]);
  });

  it("ignores failed calls, other sprites, calls without a sprite and closed watches", async () => {
    const { fake, gateway, activity, sprite, ref } = setup();
    const other = fake.addSprite();
    const watch = activity.watch(sprite);
    await expect(gateway.tagOp({ op: "delete", name: "missing" }, ref)).rejects.toThrow(/not found/);
    await gateway.tagOp({ op: "add", name: "x" }, { sprite: other });
    await gateway.tagOp({ op: "add", name: "y" }); // the active tab: unknown when recorded
    expect(watch.undoSteps).toBe(0);
    watch.close();
    await gateway.tagOp({ op: "add", name: "z" }, ref);
    expect(watch.undoSteps).toBe(0);
  });

  it("sees a model's calls through its scoped gateway", async () => {
    const { gateway, activity, sprite } = setup();
    const scoped = new ScopedAsepriteGateway(gateway, sprite);
    const watch = activity.watch(sprite);
    await scoped.writeImages([{ x: 0, y: 0, image: pixel(), layer: "AI" }]);
    await scoped.undo(1);
    await scoped.redo(1);
    expect(watch.undoSteps).toBe(1);
  });

  it("speaks the protocol's close_sprite and frame_op copy_cel", async () => {
    const calls: [string, object][] = [];
    const rpc = {
      isConnected: () => true,
      call: async <T>(method: string, params: object): Promise<T> => {
        calls.push([method, params]);
        return (method === "close_sprite" ? { closed: false } : { ok: true, frames: 4 }) as T;
      },
    };
    const gateway = new RpcAsepriteGateway(rpc);
    expect(await gateway.closeSprite(3, { onlyIfEmpty: true })).toBe(false);
    await gateway.frameOp({ op: "copy_cel", from: 2, to: 4, flip: "horizontal" }, { sprite: 3 });
    expect(calls).toEqual([
      ["close_sprite", { sprite: 3, onlyIfEmpty: true }],
      ["frame_op", { op: "copy_cel", from: 2, to: 4, flip: "horizontal", sprite: 3 }],
    ]);
  });

  it("passes close_sprite through untracked", async () => {
    const { fake, gateway, activity, sprite } = setup();
    const watch = activity.watch(sprite);
    expect(await gateway.closeSprite(sprite, { onlyIfEmpty: true })).toBe(true);
    expect(fake.isOpen(sprite)).toBe(false);
    expect(watch.undoSteps).toBe(0);
  });
});
