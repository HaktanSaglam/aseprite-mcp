import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  IAsepriteGateway,
  ReadImageRequest,
  SelectionMask,
  WriteImageRequest,
} from "../src/aseprite/AsepriteGateway.js";
import type { ColorMode, Rect, SpriteInfo } from "../src/aseprite/protocol.js";
import { CanvasService } from "../src/canvas/CanvasService.js";
import { registerColorTools } from "../src/mcp/tools/colors.js";
import { describeTarget, registerEffectTools } from "../src/mcp/tools/effects.js";
import { registerPaletteTools } from "../src/mcp/tools/palette.js";
import type { ToolContext } from "../src/mcp/ToolContext.js";
import { formatHex, parseHex } from "../src/pixel/color.js";
import { compose } from "../src/pixel/composite.js";
import { decodeRaw, encodeRaw, type PixelTarget } from "../src/pixel/rawFormat.js";
import { createRgbaImage, type RgbaImage } from "../src/pixel/RgbaImage.js";

const unused = () => {
  throw new Error("not used by these tools");
};

/**
 * In-memory Aseprite: cels are stored as raw bytes in the sprite's color mode, exactly
 * like the real extension, so indexed sprites recolor by index when the palette changes.
 */
class FakeAseprite implements IAsepriteGateway {
  readonly cels = new Map<string, string[]>();
  palette: string[] = ["#00000000", "#000000ff", "#ffffffff", "#ff0000ff"];
  transparentIndex = 0;
  activeFrame = 1;
  selection?: { rect: Rect; mask: Uint8Array };
  /** writeImages calls: each one is one undo step in Aseprite. */
  writeCalls = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly frameCount = 1,
    readonly colorMode: ColorMode = "rgb",
    readonly activeLayer = "Layer 1",
  ) {
    this.ensureLayer(activeLayer);
  }

  private target(): PixelTarget {
    const format = ({ rgb: "rgba", grayscale: "gray", indexed: "indexed" } as const)[this.colorMode];
    return { format, palette: this.palette.map((c) => c.replace("#", "")), transparentIndex: this.transparentIndex };
  }

  private encode(image: RgbaImage): string {
    return encodeRaw(image, this.target());
  }

  private decode(raw: string): RgbaImage {
    return decodeRaw(raw, this.width, this.height, this.target());
  }

  /** Test helper: draw a whole layer frame from DSL rows. */
  draw(rows: string[], legend: Record<string, string>, frame = 1, layer = this.activeLayer): void {
    const image = createRgbaImage(this.width, this.height);
    rows.forEach((row, y) =>
      [...row].forEach((ch, x) => {
        if (ch !== ".") image.data.set(parseHex(legend[ch]), (y * this.width + x) * 4);
      }),
    );
    this.ensureLayer(layer);
    this.cels.get(layer)![frame - 1] = this.encode(image);
  }

  private ensureLayer(layer: string): void {
    if (this.cels.has(layer)) return;
    const empty = this.encode(createRgbaImage(this.width, this.height));
    this.cels.set(layer, Array.from({ length: this.frameCount }, () => empty));
  }

  /** Test helper: a layer frame back as DSL rows ("?" for colors missing from the legend). */
  rows(legend: Record<string, string>, frame = 1, layer = this.activeLayer): string[] {
    const byHex = new Map(Object.entries(legend).map(([k, v]) => [formatHex(...parseHex(v)), k]));
    const image = this.layerImage(layer, frame);
    const out: string[] = [];
    for (let y = 0; y < this.height; y++) {
      let row = "";
      for (let x = 0; x < this.width; x++) {
        const o = (y * this.width + x) * 4;
        const d = image.data;
        row += d[o + 3] === 0 ? "." : (byHex.get(formatHex(d[o], d[o + 1], d[o + 2], d[o + 3])) ?? "?");
      }
      out.push(row);
    }
    return out;
  }

  layerImage(layer: string, frame: number): RgbaImage {
    const cels = this.cels.get(layer);
    if (!cels) throw new Error(`Layer "${layer}" not found`);
    return this.decode(cels[frame - 1]);
  }

  select(rect: Rect): void {
    this.selection = { rect, mask: new Uint8Array(rect.width * rect.height).fill(1) };
  }

  isConnected() {
    return true;
  }

  async getSpriteInfo(): Promise<SpriteInfo> {
    return {
      id: 1,
      filename: "test.aseprite",
      width: this.width,
      height: this.height,
      colorMode: this.colorMode,
      frames: Array.from({ length: this.frameCount }, (_, i) => ({ index: i + 1, durationMs: 100 })),
      layers: [...this.cels.keys()].map((name, i) => ({
        name,
        path: name,
        isGroup: false,
        isVisible: true,
        isEditable: true,
        opacity: 255,
        blendMode: "normal" as const,
        stackIndex: i + 1,
      })),
      tags: [],
      activeFrame: this.activeFrame,
      activeLayer: this.activeLayer,
      selection: this.selection?.rect,
      paletteSize: this.palette.length,
      transparentIndex: this.transparentIndex,
    };
  }

  async readImage(request: ReadImageRequest): Promise<{ rect: Rect; image: RgbaImage }> {
    const frame = request.frame ?? this.activeFrame;
    let full: RgbaImage;
    if (request.flattened) {
      full = createRgbaImage(this.width, this.height);
      for (const layer of this.cels.keys()) full = compose(full, this.layerImage(layer, frame), "over");
    } else {
      const layer = request.layer ?? this.activeLayer;
      if (!this.cels.has(layer) && request.missingOk) full = createRgbaImage(this.width, this.height);
      else full = this.layerImage(layer, frame);
    }
    const rect = {
      x: request.x ?? 0,
      y: request.y ?? 0,
      width: request.width ?? this.width,
      height: request.height ?? this.height,
    };
    const image = createRgbaImage(rect.width, rect.height);
    for (let y = 0; y < rect.height; y++) {
      for (let x = 0; x < rect.width; x++) {
        const sx = rect.x + x;
        const sy = rect.y + y;
        if (sx < 0 || sy < 0 || sx >= this.width || sy >= this.height) continue;
        const o = (sy * this.width + sx) * 4;
        image.data.set(full.data.subarray(o, o + 4), (y * rect.width + x) * 4);
      }
    }
    return { rect, image };
  }

  async writeImages(writes: WriteImageRequest[]): Promise<void> {
    this.writeCalls++;
    for (const write of writes) {
      const layer = write.layer ?? this.activeLayer;
      const frame = write.frame ?? this.activeFrame;
      this.ensureLayer(layer);
      const full = this.layerImage(layer, frame);
      for (let y = 0; y < write.image.height; y++) {
        for (let x = 0; x < write.image.width; x++) {
          const tx = write.x + x;
          const ty = write.y + y;
          if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) continue;
          const src = (y * write.image.width + x) * 4;
          full.data.set(write.image.data.subarray(src, src + 4), (ty * this.width + tx) * 4);
        }
      }
      this.cels.get(layer)![frame - 1] = this.encode(full);
    }
  }

  async readSelection(): Promise<SelectionMask> {
    if (!this.selection) return { isEmpty: true, rect: { x: 0, y: 0, width: 0, height: 0 }, mask: new Uint8Array(0) };
    return { isEmpty: false, bounds: this.selection.rect, rect: this.selection.rect, mask: this.selection.mask };
  }

  async getPalette() {
    return { colors: [...this.palette], transparentIndex: this.transparentIndex };
  }

  async setPalette(colors: string[]): Promise<void> {
    this.palette = colors.map((c) => {
      const [r, g, b, a] = parseHex(c);
      return `#${[r, g, b, a].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
    });
  }

  listSprites = unused;
  activateSprite = unused;
  createSprite = unused;
  spriteOp = unused;
  undo = unused;
  redo = unused;
  saveSprite = unused;
  exportSprite = unused;
  setSelection = unused;
  layerOp = unused;
  frameOp = unused;
  tagOp = unused;
}

const L = { W: "#ffffff", K: "#000000", R: "#ff0000", G: "#00ff00", B: "#0000ff" };

async function connect(fake: FakeAseprite): Promise<Client> {
  const ctx: ToolContext = { gateway: fake, canvas: new CanvasService(fake), scripts: { run: unused } };
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerEffectTools(server, ctx);
  registerColorTools(server, ctx);
  registerPaletteTools(server, ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  return { text: content.map((c) => c.text ?? "").join(""), isError: Boolean(result.isError) };
}

const TOOLS = [
  "remove_background",
  "add_outline",
  "cleanup_pixels",
  "transform_layer",
  "drop_shadow",
  "normalize_pixel_art",
  "analyze_sprite",
  "reduce_colors",
  "apply_palette",
  "adjust_colors",
  "replace_color",
  "get_palette",
  "set_palette",
  "get_palette_preset",
];

describe("tool registration", () => {
  it("registers every tool with a description and a described parameter list", async () => {
    const client = await connect(new FakeAseprite(2, 2));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
    for (const tool of tools) {
      expect(tool.description?.length, tool.name).toBeGreaterThan(40);
      const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [param, schema] of Object.entries(props)) {
        expect(schema.description, `${tool.name}.${param}`).toBeTruthy();
      }
    }
  });
});

describe("describeTarget", () => {
  it("summarizes layers and frame lists", () => {
    expect(describeTarget(undefined, [2])).toBe("the active layer, frame 2");
    expect(describeTarget("Hero", [3, 1, 2])).toBe('layer "Hero", frames 1-3');
    expect(describeTarget("Hero", [1, 3, 6])).toBe('layer "Hero", frames 1, 3, 6');
  });
});

describe("effect tools", () => {
  let fake: FakeAseprite;
  let client: Client;

  beforeEach(async () => {
    fake = new FakeAseprite(5, 5, 3);
    client = await connect(fake);
  });

  it("remove_background clears a solid background in one write", async () => {
    fake.draw(["WWWWW", "WKKKW", "WKWKW", "WKKKW", "WWWWW"], L);
    const { text, isError } = await call(client, "remove_background", { tolerance: 0 });
    expect(isError).toBe(false);
    expect(text).toBe("Removed 16 background pixels (#ffffff, tolerance 0) on the active layer, frame 1.");
    expect(fake.rows(L)).toEqual([".....", ".KKK.", ".KWK.", ".KKK.", "....."]);
    expect(fake.writeCalls).toBe(1);
  });

  it("remove_background explains when there is nothing to remove", async () => {
    fake.draw([".....", ".KKK.", ".....", ".....", "....."], L);
    const { text } = await call(client, "remove_background", {});
    expect(text).toMatch(/No background found.*mode "color"/);
  });

  it("remove_background mode color removes enclosed pixels too", async () => {
    fake.draw(["WWWWW", "WKKKW", "WKWKW", "WKKKW", "WWWWW"], L);
    const { text } = await call(client, "remove_background", { mode: "color", color: "#ffffff" });
    expect(text).toMatch(/^Removed 17 background pixels \(#ffffff/);
    expect(fake.rows(L)[2]).toBe(".K.K.");
  });

  it("rejects malformed arguments before touching the sprite", async () => {
    const bad = await call(client, "add_outline", { frames: "some", color: "black" });
    expect(bad.isError).toBe(true);
    expect(fake.writeCalls).toBe(0);
  });

  it("remove_background mode color without a color is an actionable error", async () => {
    const { text, isError } = await call(client, "remove_background", { mode: "color" });
    expect(isError).toBe(true);
    expect(text).toMatch(/needs color/);
  });

  it("add_outline paints every target frame in a single undo step", async () => {
    for (const frame of [1, 2, 3]) fake.draw([".....", ".....", "..R..", ".....", "....."], L, frame);
    const { text } = await call(client, "add_outline", { color: "#000000", frames: "all" });
    expect(text).toBe("Outlined outside (4-connected, #000000): 12 pixels painted on the active layer, frames 1-3.");
    for (const frame of [1, 2, 3]) expect(fake.rows(L, frame)).toEqual([".....", "..K..", ".KRK.", "..K..", "....."]);
    expect(fake.writeCalls).toBe(1);
  });

  it("selectionOnly limits the change and the reported count to the selection", async () => {
    fake.draw([".....", ".....", "..R..", ".....", "....."], L);
    fake.select({ x: 0, y: 0, width: 5, height: 2 });
    const { text } = await call(client, "add_outline", { color: "#000000", selectionOnly: true });
    expect(text).toMatch(/: 1 pixel painted/);
    expect(fake.rows(L)).toEqual([".....", "..K..", "..R..", ".....", "....."]);
  });

  it("targets a named layer and validates frames", async () => {
    fake.draw([".....", ".....", "..R..", ".....", "....."], L, 2, "Hero");
    const { text } = await call(client, "drop_shadow", { layer: "Hero", frames: [2] });
    expect(text).toBe('Drop shadow (1, 1) #000000: 1 pixel painted on layer "Hero", frame 2.');
    expect(fake.rows(L, 2, "Hero")[3]).toBe("...K.");
    const bad = await call(client, "drop_shadow", { frames: [9] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Frame 9 out of range/);
  });

  it("cleanup_pixels reports what it removed and recolored", async () => {
    fake.draw(["K....", ".....", "..GGG", ".....", "....."], L);
    const { text } = await call(client, "cleanup_pixels", {});
    expect(text).toBe("Cleaned the active layer, frame 1: 1 isolated pixel removed, 0 noise pixels recolored.");
    expect(fake.rows(L)[0]).toBe(".....");
    expect((await call(client, "cleanup_pixels", {})).text).toMatch(/Already clean/);
  });

  it("transform_layer flips, shifts and rejects a shift without offsets", async () => {
    fake.draw(["RG...", ".....", ".....", ".....", "....."], L);
    expect((await call(client, "transform_layer", { op: "flip_h" })).text).toMatch(/Applied flip_h .*: 4 pixels changed/);
    expect(fake.rows(L)[0]).toBe("...GR");
    await call(client, "transform_layer", { op: "shift", dx: 1, wrap: true });
    expect(fake.rows(L)[0]).toBe("R...G");
    const bad = await call(client, "transform_layer", { op: "shift" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/shift needs dx/);
  });

  it("transform_layer with selectionOnly works inside the selection bounds", async () => {
    fake.draw(["RGKKK", ".....", ".....", ".....", "....."], L);
    fake.select({ x: 0, y: 0, width: 2, height: 1 });
    const { text } = await call(client, "transform_layer", { op: "flip_h", selectionOnly: true });
    expect(text).toMatch(/inside the selection \(2x1 at 0,0\)/);
    expect(fake.rows(L)[0]).toBe("GRKKK");
  });

  it("analyze_sprite returns stats and suggestions for the flattened sprite", async () => {
    fake.draw(["WWWWW", "WKKKW", "WKRKW", "WKKKW", "WWWWW"], L);
    const { text } = await call(client, "analyze_sprite", {});
    const result = JSON.parse(text);
    expect(result.layer).toBe("(flattened)");
    expect(result.uniqueColors).toBe(3);
    expect(result.borderColor).toEqual({ color: "#ffffff", share: 1 });
    expect(result.suggestions.join(" ")).toMatch(/remove_background/);
  });
});

describe("color tools", () => {
  let fake: FakeAseprite;
  let client: Client;

  beforeEach(async () => {
    fake = new FakeAseprite(4, 2, 2);
    client = await connect(fake);
  });

  it("replace_color swaps colors and explains misses", async () => {
    fake.draw(["RRG.", "...."], L);
    expect((await call(client, "replace_color", { from: "#ff0000", to: "#0000ff" })).text).toBe(
      "Replaced 2 pixels of #ff0000 (tolerance 0) with #0000ff on the active layer, frame 1.",
    );
    expect(fake.rows(L)[0]).toBe("BBG.");
    expect((await call(client, "replace_color", { from: "#123456", to: "#000000" })).text).toMatch(/No pixels matched/);
    const bad = await call(client, "replace_color", { from: "red", to: "#000000" });
    expect(bad.isError).toBe(true);
  });

  it("adjust_colors applies and summarizes; requires at least one adjustment", async () => {
    fake.draw(["R...", "...."], L);
    expect((await call(client, "adjust_colors", { hue: 120 })).text).toBe(
      "Adjusted hue +120 on the active layer, frame 1: 1 pixel changed.",
    );
    expect(fake.rows(L)[0]).toBe("G...");
    const none = await call(client, "adjust_colors", {});
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/Nothing to adjust/);
  });

  it("reduce_colors shares one palette across all frames", async () => {
    fake.draw(["RRWW", "RRWW"], L, 1);
    fake.draw(["KKBB", "KKBB"], L, 2);
    const { text } = await call(client, "reduce_colors", { colors: 2, frames: "all" });
    const palette = text.split("Palette: ")[1].split(" ");
    expect(palette).toHaveLength(2);
    const used = new Set<string>();
    for (const frame of [1, 2]) {
      const image = fake.layerImage("Layer 1", frame);
      const d = image.data;
      for (let o = 0; o < d.length; o += 4) used.add(formatHex(d[o], d[o + 1], d[o + 2]));
    }
    expect([...used].sort()).toEqual([...palette].sort());
    expect(fake.writeCalls).toBe(1);
  });

  it("apply_palette maps to a preset and can set the sprite palette (RGB)", async () => {
    fake.draw(["RWK.", "...."], L);
    const { text } = await call(client, "apply_palette", { palette: "gameboy", setSpritePalette: true });
    expect(text).toMatch(/Applied Game Boy \(DMG green\) \(4 colors, dither none\).*sprite palette replaced/);
    expect(fake.rows({ a: "#081820", b: "#346856", c: "#88c070", d: "#e0f8d0" })[0]).toBe("cda.");
    expect(fake.palette).toEqual(["#081820ff", "#346856ff", "#88c070ff", "#e0f8d0ff"]);
  });

  it("apply_palette accepts custom colors and 'current', and rejects unknown ids", async () => {
    fake.draw(["RWK.", "...."], L);
    await call(client, "apply_palette", { palette: ["#000000", "#ffffff"] });
    expect(fake.rows(L)[0]).toBe("WWK.");
    fake.draw(["G...", "...."], L);
    await call(client, "apply_palette", { palette: "current" });
    expect(fake.rows(L)[0]).not.toBe("G...");
    const bad = await call(client, "apply_palette", { palette: "pico-8" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Unknown palette "pico-8".*pico8/);
  });

  it("reduce_colors with selectionOnly builds the palette from selected pixels only", async () => {
    fake.draw(["RRGG", "BBKK"], L);
    fake.select({ x: 0, y: 0, width: 2, height: 1 });
    const { text } = await call(client, "reduce_colors", { colors: 2, selectionOnly: true });
    expect(text).toMatch(/Reduced to 1 color .*: 0 pixels changed\. Palette: #ff0000$/);
    expect(fake.rows(L)).toEqual(["RRGG", "BBKK"]);
  });

  it("apply_palette on an indexed sprite without setSpritePalette explains the snapping", async () => {
    const indexed = new FakeAseprite(2, 1, 1, "indexed");
    const indexedClient = await connect(indexed);
    indexed.draw(["RW"], L);
    const { text } = await call(indexedClient, "apply_palette", { palette: "pico8" });
    expect(text).toMatch(/snapped to the nearest sprite-palette colors; pass setSpritePalette: true/);
  });

  it("apply_palette on an indexed sprite remaps before swapping the palette", async () => {
    const indexed = new FakeAseprite(3, 1, 1, "indexed");
    const indexedClient = await connect(indexed);
    indexed.draw(["RWK"], L);
    const { text } = await call(indexedClient, "apply_palette", { palette: "1bit", setSpritePalette: true });
    expect(text).toMatch(/set it as the sprite palette/);
    // Transparent slot kept at index 0, then the preset colors.
    expect(indexed.palette).toEqual(["#00000000", "#000000ff", "#ffffffff"]);
    expect(indexed.rows(L)).toEqual(["WWK"]);
  });
});

describe("palette tools", () => {
  it("get_palette_preset returns colors and ramps", async () => {
    const client = await connect(new FakeAseprite(2, 2));
    const preset = JSON.parse((await call(client, "get_palette_preset", { id: "pico8" })).text);
    expect(preset.size).toBe(16);
    expect(preset.colors[0]).toBe("#000000");
    expect(preset.ramps.flatMap((r: { colors: string[] }) => r.colors)).toHaveLength(16);
  });

  it("set_palette needs exactly one of colors or preset", async () => {
    const fake = new FakeAseprite(2, 2);
    const client = await connect(fake);
    expect((await call(client, "set_palette", {})).isError).toBe(true);
    expect((await call(client, "set_palette", { colors: ["#000000"], preset: "pico8" })).isError).toBe(true);
    expect((await call(client, "set_palette", { preset: "sweetie16" })).text).toBe(
      "Sprite palette set to 16 colors (Sweetie 16).",
    );
    expect(fake.palette).toHaveLength(16);
    await call(client, "set_palette", { colors: ["#ff0000", "#00ff0080"] });
    expect(fake.palette).toEqual(["#ff0000ff", "#00ff0080"]);
  });

  it("set_palette on an indexed sprite warns about the transparent index", async () => {
    const fake = new FakeAseprite(2, 2, 1, "indexed");
    const client = await connect(fake);
    const { text } = await call(client, "set_palette", { preset: "pico8" });
    expect(text).toMatch(/Indexed sprite: existing pixels now show the new color/);
    expect(text).toMatch(/Index 0 \(#000000\) is the transparent index/);
  });

  it("get_palette lists colors and the transparent index", async () => {
    const client = await connect(new FakeAseprite(2, 2));
    expect(JSON.parse((await call(client, "get_palette")).text)).toEqual({
      colors: ["#00000000", "#000000ff", "#ffffffff", "#ff0000ff"],
      transparentIndex: 0,
    });
  });
});
