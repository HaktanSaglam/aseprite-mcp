import { describe, expect, it } from "vitest";
import { z } from "zod";
import { INSTANT_TOOLS, InstantToolService } from "../src/chat/InstantToolService.js";
import { createMcpServer, scopeToolContext } from "../src/mcp/createMcpServer.js";
import type { ToolContext, ToolRegistrar } from "../src/mcp/ToolContext.js";
import { createRgbaImage } from "../src/pixel/RgbaImage.js";
import { FakeGateway } from "./chatFakes.js";

// Stand-ins for tools other modules implement: they report which sprite they acted on.
const dummyTools: ToolRegistrar = (server, { gateway }) => {
  server.registerTool(
    "add_outline",
    { description: "test", inputSchema: { color: z.string().regex(/^#[0-9a-f]{6}$/).optional() } },
    async ({ color }) => {
      const info = await gateway.getSpriteInfo();
      return { content: [{ type: "text", text: `outlined sprite ${info.id} with ${color ?? "auto"}` }] };
    },
  );
  server.registerTool("undo", { description: "test" }, async () => {
    throw new Error("Nothing to undo");
  });
  server.registerTool("redo", { description: "test" }, async () => ({
    content: [
      { type: "image", data: "AA", mimeType: "image/png" },
      { type: "text", text: "Redone." },
    ],
  }));
  server.registerTool("draw_script", { description: "not instant" }, async () => ({ content: [{ type: "text", text: "drew" }] }));
};

function service(registrars: ToolRegistrar[] = [dummyTools]) {
  const gateway = new FakeGateway();
  gateway.addSprite({ id: 3 });
  gateway.addSprite({ id: 8 }); // active
  const base: ToolContext = {
    gateway,
    canvas: {} as ToolContext["canvas"],
    scripts: { run: async () => ({ image: createRgbaImage(1, 1), images: [createRgbaImage(1, 1)], calls: 0, elapsedMs: 0, logs: [] }) },
  };
  return new InstantToolService((sprite) =>
    createMcpServer(sprite === undefined ? base : scopeToolContext(base, sprite), registrars),
  );
}

describe("InstantToolService", () => {
  it("allows exactly the PROTOCOL.md instant tools", () => {
    expect([...INSTANT_TOOLS].sort()).toEqual(
      ["add_outline", "adjust_colors", "apply_palette", "cleanup_pixels", "drop_shadow", "redo", "reduce_colors", "remove_background", "replace_color", "transform_layer", "undo"],
    );
  });

  it("calls the MCP tool in-process on the requested sprite and returns its text", async () => {
    expect(await service().run({ tool: "add_outline", params: { color: "#112233" }, sprite: 3 })).toEqual({
      ok: true,
      text: "outlined sprite 3 with #112233",
    });
  });

  it("acts on the active sprite when no sprite is given", async () => {
    expect(await service().run({ tool: "add_outline", params: {} })).toEqual({ ok: true, text: "outlined sprite 8 with auto" });
  });

  it("refuses tools outside the allowlist, even if registered", async () => {
    expect(await service().run({ tool: "draw_script", params: {} })).toEqual({ ok: false, text: '"draw_script" is not an instant tool.' });
  });

  it("says when an allowed tool is not in this build", async () => {
    expect(await service().run({ tool: "drop_shadow", params: {} })).toEqual({
      ok: false,
      text: "Tool not available in this build: drop_shadow",
    });
    expect(await service([]).run({ tool: "undo", params: {} })).toEqual({ ok: false, text: "Tool not available in this build: undo" });
  });

  it("returns tool errors and argument validation errors as ok:false", async () => {
    const tools = service();
    expect(await tools.run({ tool: "undo", params: {} })).toEqual({ ok: false, text: "Nothing to undo" });
    const invalid = await tools.run({ tool: "add_outline", params: { color: "red" } });
    expect(invalid.ok).toBe(false);
    expect(invalid.text).toMatch(/color/);
  });

  it("finds the text block after an image", async () => {
    expect(await service().run({ tool: "redo", params: {} })).toEqual({ ok: true, text: "Redone." });
  });

  it("reports a sprite that is not open", async () => {
    const result = await service().run({ tool: "add_outline", params: {}, sprite: 99 });
    expect(result).toEqual({ ok: false, text: "Sprite 99 is not open anymore" });
  });
});
