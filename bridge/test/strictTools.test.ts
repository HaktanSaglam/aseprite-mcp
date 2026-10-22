import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CanvasService } from "../src/canvas/CanvasService.js";
import { createMcpServer } from "../src/mcp/createMcpServer.js";
import { StrictMcpServer, unknownArgumentsMessage } from "../src/mcp/StrictMcpServer.js";
import type { ToolRegistrar } from "../src/mcp/ToolContext.js";
import { TOOL_REGISTRARS } from "../src/mcp/tools/index.js";
import { registerPixelTools } from "../src/mcp/tools/pixels.js";
import { registerSpriteTools } from "../src/mcp/tools/sprite.js";
import { FakeGateway } from "./fakes/FakeGateway.js";
import { toolHarness, type ToolHarness } from "./fakes/toolHarness.js";

let h: ToolHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("StrictMcpServer", () => {
  it("is what the bridge registers its tools on", () => {
    const gateway = new FakeGateway();
    const ctx = { gateway, canvas: new CanvasService(gateway), scripts: { run: async () => ({}) as never } };
    expect(createMcpServer(ctx, [])).toBeInstanceOf(StrictMcpServer);
  });

  it("rejects an argument the tool does not declare, naming every argument it takes", async () => {
    const gw = new FakeGateway();
    gw.addSprite({ width: 2, height: 2, frames: 3 });
    h = await toolHarness([registerPixelTools], gw);
    // The original bug: frames was dropped and the write went to the active frame only.
    const error = await h.error("write_pixels", { palette: { a: "#ff0000" }, rows: ["a"], frames: [1, 2, 3] });
    expect(error).toMatch(/Invalid arguments for tool write_pixels/);
    expect(error).toMatch(/Unknown argument "frames"\. It takes: .*\bframe\b/);
    expect(gw.calls.filter((c) => c.method === "writeImages")).toHaveLength(0);
  });

  it("lists several unknown arguments at once", async () => {
    const gw = new FakeGateway();
    gw.addSprite();
    h = await toolHarness([registerSpriteTools], gw);
    const error = await h.error("create_sprite", { width: 8, height: 8, colour: "#ff0000", fps: 12 });
    expect(error).toMatch(/Unknown arguments "colour", "fps"\. It takes: width, height, colorMode, frames, background\./);
    expect(gw.calls.filter((c) => c.method === "createSprite")).toHaveLength(0);
  });

  it("rejects arguments for tools that take none, and still calls them without", async () => {
    const gw = new FakeGateway();
    gw.addSprite();
    h = await toolHarness([registerSpriteTools], gw);
    expect(await h.error("get_sprite_info", { sprite: 2 })).toMatch(/Unknown argument "sprite"\. It takes no arguments\./);
    expect(await h.json("get_sprite_info")).toMatchObject({ width: 16, height: 16 });
  });

  it("publishes additionalProperties: false so clients know the argument list is closed", async () => {
    h = await toolHarness(TOOL_REGISTRARS);
    const tools = await h.listTools();
    expect(tools.length).toBeGreaterThan(20);
    for (const tool of tools) {
      expect({ tool: tool.name, closed: (tool.inputSchema as { additionalProperties?: unknown }).additionalProperties }).toEqual({
        tool: tool.name,
        closed: false,
      });
    }
  });

  it("leaves full schemas a tool built itself alone", async () => {
    const custom: ToolRegistrar = (server) => {
      server.registerTool("loose", { inputSchema: z.object({ a: z.number() }).passthrough() }, async (args) => ({
        content: [{ type: "text", text: JSON.stringify(args) }],
      }));
    };
    h = await toolHarness([custom]);
    expect(JSON.parse((await h.call("loose", { a: 1, b: 2 })).text)).toEqual({ a: 1, b: 2 });
  });

  it("words the message for one or many keys", () => {
    expect(unknownArgumentsMessage(["x"], ["a", "b"])).toBe('Unknown argument "x". It takes: a, b.');
    expect(unknownArgumentsMessage(["x", "y"], [])).toBe('Unknown arguments "x", "y". It takes no arguments.');
  });
});

describe("Tools tab requests (aseprite-extension/ui/requests.lua R.TOOLS)", () => {
  // Every scoped tool gets the shared target; a strict schema must accept all of it.
  const target = (frames: "current" | "all", selectionOnly: boolean) => ({ layer: "Layer 1", frames, selectionOnly });
  const requests: [string, Record<string, unknown>][] = [
    ["remove_background", { mode: "edges", tolerance: 10, ...target("current", false) }],
    ["cleanup_pixels", { minNeighbors: 1, ...target("all", false) }],
    ["drop_shadow", { dx: 1, dy: 1, ...target("current", true) }],
    ["add_outline", { placement: "outside", ...target("current", false) }],
    ["add_outline", { placement: "inside", color: "#112233", ...target("all", false) }],
    ["reduce_colors", { colors: 8, dither: "none", ...target("current", false) }],
    ["apply_palette", { palette: "pico8", dither: "ordered", ...target("current", false) }],
    ["adjust_colors", { hue: 10, saturation: -5, lightness: 3, ...target("current", false) }],
    ["transform_layer", { op: "flip_h", ...target("current", false) }],
    ["transform_layer", { op: "shift", dx: -1, dy: 0, ...target("all", false) }],
    ["undo", { steps: 1 }],
    ["redo", { steps: 1 }],
  ];

  it.each(requests)("%s accepts the params the window sends", async (tool, params) => {
    const gw = new FakeGateway();
    gw.addSprite({ width: 4, height: 4, frames: 2 });
    gw.fillRect({ layer: "Layer 1", x: 1, y: 1, width: 2, height: 2, color: "#ff0000" });
    h = await toolHarness(TOOL_REGISTRARS, gw);
    const result = await h.call(tool, params);
    expect(result.text).not.toMatch(/Input validation error|Unknown argument/);
  });
});
