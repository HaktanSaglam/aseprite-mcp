import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerEffectTools } from "../src/mcp/tools/effects.js";
import { FakeGateway } from "./fakes/FakeGateway.js";
import { toolHarness, type ToolHarness } from "./fakes/toolHarness.js";

/** A layer as rows: "." transparent, "#" any opaque pixel. */
function silhouette(gw: FakeGateway, width: number, height: number): string[] {
  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => (gw.pixel("Layer 1", x, y)[3] > 0 ? "#" : ".")).join(""),
  );
}

describe("transform_layer with a non-rectangular selection", () => {
  let gw: FakeGateway;
  let h: ToolHarness;

  beforeEach(async () => {
    gw = new FakeGateway();
    gw.addSprite({ width: 8, height: 3 });
    // A body (columns 1-2) with a sword (row 1, columns 3-6) pointing right.
    gw.fillRect({ x: 1, y: 0, width: 2, height: 3, color: "#ff0000" });
    gw.fillRect({ x: 3, y: 1, width: 4, height: 1, color: "#00ff00" });
    // The opaque pixels as runs, like set_selection shape "opaque" makes them.
    await gw.setSelection("replace", [
      [1, 0, 2, 1],
      [1, 1, 6, 1],
      [1, 2, 2, 1],
    ]);
    h = await toolHarness([registerEffectTools], gw);
  });

  afterEach(() => h.close());

  it("flips the selected art as a whole instead of clipping it to the old outline", async () => {
    const { text } = await h.call("transform_layer", { op: "flip_h", selectionOnly: true });
    expect(text).toMatch(/inside the selection \(6x3 at 1,0\)/);
    expect(silhouette(gw, 8, 3)).toEqual([".....##.", ".######.", ".....##."]);
    expect(gw.pixel("Layer 1", 1, 1)).toEqual([0, 255, 0, 255]);
    expect(gw.pixel("Layer 1", 6, 0)).toEqual([255, 0, 0, 255]);
  });

  it("shifts the selected pixels past the selection's box, leaving the rest in place", async () => {
    await gw.setSelection("replace", [[3, 1, 4, 1]]);
    const { text } = await h.call("transform_layer", { op: "shift", dx: 1, selectionOnly: true });
    expect(text).toMatch(/: 2 pixels changed\./);
    expect(silhouette(gw, 8, 3)).toEqual([".##.....", ".##.####", ".##....."]);
  });
});
