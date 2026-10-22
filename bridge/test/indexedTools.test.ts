import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { RpcAsepriteGateway } from "../src/aseprite/RpcAsepriteGateway.js";
import { CanvasService } from "../src/canvas/CanvasService.js";
import { registerColorTools } from "../src/mcp/tools/colors.js";
import { registerEffectTools } from "../src/mcp/tools/effects.js";
import { registerPaletteTools } from "../src/mcp/tools/palette.js";
import type { ToolContext } from "../src/mcp/ToolContext.js";
import { decodeGrid } from "../src/pixel/PixelGridCodec.js";
import { RawRpcFake, type RawSprite } from "./fakes/RawRpcFake.js";

// End to end through the real RpcAsepriteGateway, so these tests see the palette indexes
// that really land in an indexed sprite, not just the RGBA the tools compute.

async function connect(rpc: RawRpcFake) {
  const gateway = new RpcAsepriteGateway(rpc);
  const canvas = new CanvasService(gateway);
  const ctx: ToolContext = {
    gateway,
    canvas,
    scripts: {
      run: async () => {
        throw new Error("not used");
      },
    },
  };
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerEffectTools(server, ctx);
  registerColorTools(server, ctx);
  registerPaletteTools(server, ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text?: string }[];
    return { text: content.map((c) => c.text ?? "").join(""), isError: Boolean(result.isError) };
  };
  return { canvas, call };
}

const bytes = (rpc: RawRpcFake, s: RawSprite, layer = s.layers[0], frame = 1) => [...rpc.cel(s, layer, frame)];
const writes = (rpc: RawRpcFake) => rpc.calls("write_image").length + rpc.calls("write_images").length;

// index 0 transparent, then black, white, red
const BASIC = ["00000000", "000000ff", "ffffffff", "ff0000ff"];

describe("indexed sprites keep the palette index of pixels an edit doesn't change", () => {
  it("writes nothing when the edited colors snap back to the same palette colors, and says why", async () => {
    const rpc = new RawRpcFake();
    const s = rpc.add({ width: 2, height: 1, palette: ["00000000", "ff0000ff", "00ff00ff", "0000ffff"] });
    rpc.setCel(s, [1, 3]);
    const { call } = await connect(rpc);
    const { text } = await call("adjust_colors", { hue: 10 });
    expect(text).toMatch(/: 0 pixels changed\. Indexed sprite: 2 pixels took the nearest palette color/);
    expect(writes(rpc)).toBe(0);
    expect(bytes(rpc, s)).toEqual([1, 3]);
  });

  it("keeps pixels on a duplicated palette color on their own index (palette-swap setups)", async () => {
    const rpc = new RawRpcFake();
    const s = rpc.add({ width: 4, height: 1, palette: ["00000000", "000000ff", "ffffffff", "000000ff"] });
    rpc.setCel(s, [3, 3, 2, 1]);
    const { call } = await connect(rpc);
    const { text } = await call("replace_color", { from: "#ffffff", to: "#000000" });
    expect(text).toBe("Replaced 1 pixel of #ffffff (tolerance 0) with #000000 on the active layer, frame 1.");
    expect(bytes(rpc, s)).toEqual([3, 3, 1, 1]);
  });

  it("keeps translucent palette entries and indexes past the end of the palette", async () => {
    const rpc = new RawRpcFake();
    const s = rpc.add({ width: 4, height: 1, palette: ["00000000", "ff000040", "ffffffff", "000000ff"] });
    rpc.setCel(s, [1, 2, 7, 3]);
    const { call } = await connect(rpc);
    await call("replace_color", { from: "#ffffff", to: "#000000" });
    expect(bytes(rpc, s)).toEqual([1, 3, 7, 3]);
  });

  it("does not touch a palette-swapped layer when nothing matches", async () => {
    const rpc = new RawRpcFake();
    const s = rpc.add({ width: 4, height: 1, palette: BASIC });
    rpc.setCel(s, [3, 5, 6, 7]);
    const { call } = await connect(rpc);
    expect((await call("replace_color", { from: "#123456", to: "#000000" })).text).toMatch(/No pixels matched/);
    expect(writes(rpc)).toBe(0);
    expect(bytes(rpc, s)).toEqual([3, 5, 6, 7]);
  });

  it("with selectionOnly leaves every index outside the selection as it was", async () => {
    const rpc = new RawRpcFake();
    const s = rpc.add({ width: 4, height: 1, palette: ["00000000", "000000ff", "ffffffff", "000000ff"] });
    rpc.setCel(s, [3, 3, 2, 2]);
    s.selection = Uint8Array.from([0, 0, 1, 0]);
    const { call } = await connect(rpc);
    const { text } = await call("replace_color", { from: "#ffffff", to: "#000000", selectionOnly: true });
    expect(text).toMatch(/^Replaced 1 pixel /);
    expect(bytes(rpc, s)).toEqual([3, 3, 1, 2]);
  });

  it("paint keeps the indexes of the pixels it doesn't cover", async () => {
    const rpc = new RawRpcFake();
    const s = rpc.add({ width: 3, height: 1, palette: ["00000000", "000000ff", "ffffffff", "000000ff"] });
    rpc.setCel(s, [3, 3, 3]);
    const { canvas } = await connect(rpc);
    const image = decodeGrid({ palette: { w: "#ffffff" }, rows: [".w."] });
    await canvas.paint([{ x: 0, y: 0, image }]);
    expect(bytes(rpc, s)).toEqual([3, 2, 3]);
    // replace mode, too: the script redraws the region but only the white pixel differs.
    const redrawn = decodeGrid({ palette: { k: "#000000" }, rows: ["kkk"] });
    await canvas.paint([{ x: 0, y: 0, image: redrawn }], { mode: "replace" });
    expect(bytes(rpc, s)).toEqual([3, 1, 3]);
  });
});

describe("indexed sprites report the colors they really store", () => {
  it("replace_color names the nearest palette color it wrote instead of the requested one", async () => {
    const rpc = new RawRpcFake();
    const s = rpc.add({ width: 4, height: 1, palette: BASIC });
    rpc.setCel(s, [3, 3, 3, 3]);
    const { call } = await connect(rpc);
    const { text } = await call("replace_color", { from: "#ff0000", to: "#00ff00" });
    expect(text).toMatch(
      /^Replaced 4 pixels of #ff0000 \(tolerance 0\) with #ffffff \(the nearest palette color; #00ff00 is not in the indexed palette/,
    );
    expect(bytes(rpc, s)).toEqual([2, 2, 2, 2]);
  });

  it("replace_color explains a replacement that snaps back to the old color", async () => {
    const rpc = new RawRpcFake();
    const s = rpc.add({ width: 2, height: 1, palette: BASIC });
    rpc.setCel(s, [3, 3]);
    const { call } = await connect(rpc);
    const { text } = await call("replace_color", { from: "#ff0000", to: "#ee1111" });
    expect(text).toMatch(/^Nothing changed .*#ee1111 is not in the indexed palette, and its nearest palette color is #ff0000/);
    expect(writes(rpc)).toBe(0);
  });

  it("drop_shadow and add_outline report snapped colors", async () => {
    const rpc = new RawRpcFake();
    const s = rpc.add({ width: 3, height: 3, palette: BASIC });
    rpc.setCel(s, [0, 0, 0, 0, 3, 0, 0, 0, 0]);
    const { call } = await connect(rpc);
    expect((await call("drop_shadow", { color: "#222222" })).text).toMatch(
      /^Drop shadow \(1, 1\) #000000 \(the nearest palette color; #222222 is not in the indexed palette/,
    );
    rpc.setCel(s, [0, 0, 0, 0, 3, 0, 0, 0, 0]);
    expect((await call("add_outline")).text).toMatch(/painted on .*\. Indexed sprite: 4 pixels took the nearest palette color/);
  });
});

describe("apply_palette with setSpritePalette on indexed sprites", () => {
  it("refuses more than 255 colors before changing anything", async () => {
    const rpc = new RawRpcFake();
    const s = rpc.add({ width: 1, height: 1, palette: BASIC });
    rpc.setCel(s, [3]);
    const { call } = await connect(rpc);
    const colors = Array.from({ length: 256 }, (_, i) => `#${i.toString(16).padStart(2, "0")}0000`);
    const result = await call("apply_palette", { palette: colors, setSpritePalette: true });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/at most 255 colors \(got 256\)/);
    expect(rpc.transactions).toBe(0);
    expect(s.palette).toEqual(BASIC);
  });

  it("puts the transparent slot exactly on a high transparent index, so black stays paintable", async () => {
    const rpc = new RawRpcFake();
    const s = rpc.add({
      width: 2,
      height: 1,
      palette: ["000000ff", "ffffffff", "ff0000ff", "00ff00ff", "0000ffff", "00000000"],
      transparentIndex: 5,
    });
    rpc.setCel(s, [0, 1]);
    const { call } = await connect(rpc);
    const { text } = await call("apply_palette", { palette: ["#ffffff", "#000000"], setSpritePalette: true });
    expect(s.palette).toEqual(["ffffffff", "000000ff", "00000000", "00000000", "00000000", "00000000"]);
    expect(bytes(rpc, s)).toEqual([1, 0]);
    expect(text).toMatch(/2 undo steps: undo with steps: 2/);
  });
});

describe("one tool call stays on the sprite, layer and frame it started on", () => {
  function twoTabs() {
    const rpc = new RawRpcFake();
    const a = rpc.add({ width: 2, height: 1, colorMode: "rgb" });
    const b = rpc.add({ width: 2, height: 1, colorMode: "rgb" });
    rpc.setCel(a, [255, 0, 0, 255, 0, 0, 0, 0]);
    rpc.active = 0;
    return { rpc, a, b };
  }

  it("an effect reads and writes the tab that was active when it started", async () => {
    const { rpc, a, b } = twoTabs();
    const { call } = await connect(rpc);
    rpc.beforeCall = (_method, n) => {
      if (n === 2) rpc.active = 1; // the user clicks the other tab right after the tool starts
    };
    expect((await call("adjust_colors", { invert: true })).text).toMatch(/1 pixel changed/);
    expect(bytes(rpc, a)).toEqual([0, 255, 255, 255, 0, 0, 0, 0]);
    expect(bytes(rpc, b)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    for (const method of ["read_image", "write_image"]) {
      for (const params of rpc.calls(method)) expect(params.sprite).toBe(a.id);
    }
  });

  it("paint stays on its sprite, layer and frame", async () => {
    const { rpc, a, b } = twoTabs();
    a.frames = 2;
    a.layers = ["Layer 1", "Top"];
    a.activeLayer = "Layer 1";
    const { canvas } = await connect(rpc);
    rpc.beforeCall = (_method, n) => {
      if (n !== 2) return;
      a.activeFrame = 2;
      a.activeLayer = "Top";
      rpc.active = 1;
    };
    await canvas.paint([{ x: 1, y: 0, image: decodeGrid({ palette: { g: "#00ff00" }, rows: ["g"] }) }]);
    expect(bytes(rpc, a, "Layer 1", 1)).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
    expect(bytes(rpc, a, "Top", 1).every((v) => v === 0)).toBe(true);
    expect(bytes(rpc, a, "Layer 1", 2).every((v) => v === 0)).toBe(true);
    expect(bytes(rpc, b).every((v) => v === 0)).toBe(true);
  });

  it("an effect keeps the layer and frame that were active when it started", async () => {
    const rpc = new RawRpcFake();
    const s = rpc.add({ width: 1, height: 1, colorMode: "rgb", frames: 2, layers: ["Layer 1", "Layer 2"] });
    s.activeLayer = "Layer 2";
    rpc.setCel(s, [255, 0, 0, 255], "Layer 2", 1);
    const { call } = await connect(rpc);
    rpc.beforeCall = (_method, n) => {
      if (n !== 2) return;
      s.activeLayer = "Layer 1";
      s.activeFrame = 2;
    };
    await call("adjust_colors", { invert: true });
    expect(bytes(rpc, s, "Layer 2", 1)).toEqual([0, 255, 255, 255]);
    expect(bytes(rpc, s, "Layer 1", 2)).toEqual([0, 0, 0, 0]);
  });
});
