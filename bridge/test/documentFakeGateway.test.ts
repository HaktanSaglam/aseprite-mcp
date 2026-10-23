import { describe, expect, it } from "vitest";
import { CanvasService } from "../src/canvas/CanvasService.js";
import { decodeGrid } from "../src/pixel/PixelGridCodec.js";
import { FakeGateway } from "./fakes/FakeGateway.js";

// The fake stands in for Aseprite in every tool test, so its semantics are pinned here.
describe("FakeGateway", () => {
  const red = decodeGrid({ palette: { r: "#ff0000" }, rows: ["r"] });

  it("creates missing layers on write and reads them back", async () => {
    const gw = new FakeGateway();
    gw.addSprite({ width: 4, height: 4 });
    await gw.writeImages([{ x: 1, y: 2, image: red, layer: "AI" }]);
    expect(gw.state().layers.map((l) => l.name)).toEqual(["Layer 1", "AI"]);
    const { rect, image } = await gw.readImage({ layer: "AI", x: 0, y: 2, width: 2, height: 1 });
    expect(rect).toEqual({ x: 0, y: 2, width: 2, height: 1 });
    expect([...image.data]).toEqual([0, 0, 0, 0, 255, 0, 0, 255]);
    await expect(gw.readImage({ layer: "Nope" })).rejects.toThrow("Layer not found: Nope");
    expect((await gw.readImage({ layer: "Nope", missingOk: true })).image.data.every((v) => v === 0)).toBe(true);
  });

  it("makes a multi-write call one undo step and supports redo", async () => {
    const gw = new FakeGateway();
    gw.addSprite({ width: 2, height: 2, frames: 2 });
    await gw.writeImages([
      { x: 0, y: 0, image: red, frame: 1 },
      { x: 1, y: 1, image: red, frame: 2 },
    ]);
    await gw.undo(1);
    expect(gw.pixel("Layer 1", 0, 0, 1)).toEqual([0, 0, 0, 0]);
    expect(gw.pixel("Layer 1", 1, 1, 2)).toEqual([0, 0, 0, 0]);
    await gw.redo(1);
    expect(gw.pixel("Layer 1", 1, 1, 2)).toEqual([255, 0, 0, 255]);
  });

  it("rolls back a failed call entirely", async () => {
    const gw = new FakeGateway();
    gw.addSprite({ width: 2, height: 2 });
    await gw.layerOp({ op: "update", name: "Layer 1", editable: false });
    await expect(gw.writeImages([{ x: 0, y: 0, image: red, layer: "New" }, { x: 0, y: 0, image: red, layer: "Layer 1" }])).rejects.toThrow(
      "Layer is locked: Layer 1",
    );
    expect(gw.state().layers.map((l) => l.name)).toEqual(["Layer 1"]);
  });

  it("flattens visible layers with opacity", async () => {
    const gw = new FakeGateway();
    gw.addSprite({ width: 1, height: 1, layers: ["Top"] });
    gw.fillRect({ layer: "Layer 1", x: 0, y: 0, width: 1, height: 1, color: "#0000ff" });
    gw.fillRect({ layer: "Top", x: 0, y: 0, width: 1, height: 1, color: "#ff0000" });
    expect([...(await gw.readImage({ flattened: true })).image.data]).toEqual([255, 0, 0, 255]);
    await gw.layerOp({ op: "update", name: "Top", opacity: 0 });
    expect([...(await gw.readImage({ flattened: true })).image.data]).toEqual([0, 0, 255, 255]);
    await gw.layerOp({ op: "update", name: "Layer 1", visible: false });
    expect([...(await gw.readImage({ flattened: true })).image.data]).toEqual([0, 0, 0, 0]);
  });

  it("reads selections like the Lua side", async () => {
    const gw = new FakeGateway();
    gw.addSprite({ width: 4, height: 4 });
    expect(await gw.readSelection({})).toMatchObject({ isEmpty: true, rect: { width: 0, height: 0 } });
    expect(await gw.readSelection({ x: 0, y: 0, width: 2, height: 1 })).toMatchObject({ isEmpty: true, mask: new Uint8Array(2) });
    await gw.setSelection("replace", [[1, 1, 2, 1]]);
    const read = await gw.readSelection({});
    expect(read).toMatchObject({ isEmpty: false, bounds: { x: 1, y: 1, width: 2, height: 1 } });
    expect([...read.mask]).toEqual([1, 1]);
  });

  it("keeps cels and tags attached to their frames when frames are inserted or removed", async () => {
    const gw = new FakeGateway();
    gw.addSprite({ width: 1, height: 1, frames: 3 });
    gw.fillRect({ frame: 3, x: 0, y: 0, width: 1, height: 1, color: "#ff0000" });
    await gw.tagOp({ op: "add", name: "end", from: 3, to: 3 });
    await gw.frameOp({ op: "add", after: 1, count: 2 });
    expect(gw.pixel("Layer 1", 0, 0, 5)).toEqual([255, 0, 0, 255]);
    expect(gw.state().tags[0]).toMatchObject({ from: 5, to: 5 });
    await gw.frameOp({ op: "delete", from: 2, to: 3 });
    expect(gw.pixel("Layer 1", 0, 0, 3)).toEqual([255, 0, 0, 255]);
    expect(gw.state().tags[0]).toMatchObject({ from: 3, to: 3 });
  });

  it("works under CanvasService with selection masks", async () => {
    const gw = new FakeGateway();
    gw.addSprite({ width: 3, height: 1 });
    await gw.setSelection("replace", [[1, 0, 1, 1]]);
    const canvas = new CanvasService(gw);
    const row = decodeGrid({ palette: { r: "#ff0000" }, rows: ["rrr"] });
    await canvas.paint([{ x: 0, y: 0, image: row }], { selectionOnly: true });
    expect([0, 1, 2].map((x) => gw.pixel("Layer 1", x, 0)[3])).toEqual([0, 255, 0]);
  });

  it("fails every call while disconnected", async () => {
    const gw = new FakeGateway();
    gw.addSprite();
    gw.connected = false;
    expect(gw.isConnected()).toBe(false);
    await expect(gw.getSpriteInfo()).rejects.toThrow(/not connected/);
  });
});
