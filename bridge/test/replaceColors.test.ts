import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerColorTools } from "../src/mcp/tools/colors.js";
import { parseHex } from "../src/pixel/color.js";
import { replaceColors } from "../src/pixel/effects/replaceColor.js";
import type { RgbaImage } from "../src/pixel/RgbaImage.js";
import { FakeGateway } from "./fakes/FakeGateway.js";
import { toolHarness, type ToolHarness } from "./fakes/toolHarness.js";
import { gridImage } from "./fixtures/pixelArt.js";

const LEGEND = { R: "#ff0000", r: "#f00808", B: "#0000ff", G: "#00ff00", W: "#ffffff" };

function rows(image: RgbaImage): string[] {
  const byColor = new Map(Object.entries(LEGEND).map(([k, v]) => [parseHex(v).join(","), k]));
  const out: string[] = [];
  for (let y = 0; y < image.height; y++) {
    let row = "";
    for (let x = 0; x < image.width; x++) {
      const px = [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
      row += px[3] === 0 ? "." : (byColor.get(px.join(",")) ?? "?");
    }
    out.push(row);
  }
  return out;
}

describe("replaceColors", () => {
  it("trades colors without chaining (a palette swap)", () => {
    const art = gridImage(["RRB", "BG."], LEGEND);
    const swaps = [
      { from: parseHex("#ff0000"), to: parseHex("#0000ff") },
      { from: parseHex("#0000ff"), to: parseHex("#ff0000") },
    ];
    const { image, replaced } = replaceColors(art, swaps);
    expect(rows(image)).toEqual(["BBR", "RG."]);
    expect(replaced).toEqual([2, 2]);
  });

  it("gives a pixel near several colors the swap of the nearest one", () => {
    const art = gridImage(["Rr"], LEGEND);
    const swaps = [
      { from: parseHex("#f00808"), to: parseHex("#00ff00") },
      { from: parseHex("#ff0000"), to: parseHex("#ffffff") },
    ];
    expect(rows(replaceColors(art, swaps, 25).image)).toEqual(["WG"]);
  });
});

describe("replace_color with pairs", () => {
  let h: ToolHarness;
  let gw: FakeGateway;
  beforeEach(async () => {
    gw = new FakeGateway();
    gw.addSprite({ width: 3, height: 1, frames: 2 });
    gw.fillRect({ x: 0, y: 0, width: 1, height: 1, color: "#ff0000" });
    gw.fillRect({ x: 1, y: 0, width: 1, height: 1, color: "#0000ff" });
    gw.fillRect({ x: 2, y: 0, width: 1, height: 1, color: "#00ff00" });
    h = await toolHarness([registerColorTools], gw);
  });
  afterEach(() => h.close());

  it("applies every swap in one undo step and lists what each did", async () => {
    const result = await h.call("replace_color", {
      pairs: [
        { from: "#ff0000", to: "#0000ff" },
        { from: "#0000ff", to: "#ff0000" },
        { from: "#123456", to: "#ffffff" },
      ],
    });
    expect(result.text).toBe(
      "Replaced 2 pixels in 3 swaps (tolerance 0) on the active layer, frame 1: " +
        "#ff0000→#0000ff (1), #0000ff→#ff0000 (1), #123456→#ffffff (0).",
    );
    expect(gw.pixel("Layer 1", 0, 0)).toEqual([0, 0, 255, 255]);
    expect(gw.pixel("Layer 1", 1, 0)).toEqual([255, 0, 0, 255]);
    expect(gw.callsOf("writeImages")).toHaveLength(1);
  });

  it("keeps the single from/to swap and accepts a one-pair list", async () => {
    expect((await h.call("replace_color", { from: "#00ff00", to: "#ffffff" })).text).toBe(
      "Replaced 1 pixel of #00ff00 (tolerance 0) with #ffffff on the active layer, frame 1.",
    );
    expect((await h.call("replace_color", { pairs: [{ from: "#ffffff", to: "#00ff00" }] })).text).toMatch(/^Replaced 1 pixel of #ffffff/);
  });

  it("says when no pair matched", async () => {
    const text = (await h.call("replace_color", { pairs: [{ from: "#111111", to: "#222222" }, { from: "#333333", to: "#444444" }] })).text;
    expect(text).toMatch(/^Nothing changed on the active layer, frame 1 \(tolerance 0\): #111111→#222222 \(0\)/);
    expect(gw.callsOf("writeImages")).toHaveLength(0);
  });

  it("rejects mixed, incomplete and ambiguous arguments", async () => {
    expect(await h.error("replace_color", { from: "#ff0000", pairs: [{ from: "#ff0000", to: "#000000" }] })).toMatch(/either from\/to .* or pairs/);
    expect(await h.error("replace_color", { from: "#ff0000" })).toMatch(/Pass from and to/);
    expect(await h.error("replace_color", {})).toMatch(/Pass from and to/);
    expect(
      await h.error("replace_color", { pairs: [{ from: "#ff0000", to: "#000000" }, { from: "#FF0000", to: "#ffffff" }] }),
    ).toMatch(/#FF0000 appears twice/);
    expect(await h.error("replace_color", { pairs: [{ from: "#ff0000", to: "#000000", tolerance: 5 }] })).toMatch(/tolerance/);
    expect(await h.error("replace_color", { pairs: [] })).toMatch(/pairs/);
  });
});
