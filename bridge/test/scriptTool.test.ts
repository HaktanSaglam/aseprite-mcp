import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { IAsepriteGateway } from "../src/aseprite/AsepriteGateway.js";
import { CanvasService } from "../src/canvas/CanvasService.js";
import { formatFrames, registerDrawScript, resolveTargetFrames } from "../src/mcp/tools/drawScript.js";
import type { ToolContext } from "../src/mcp/ToolContext.js";
import { Raster } from "../src/pixel/Raster.js";
import { createRgbaImage } from "../src/pixel/RgbaImage.js";
import { QuickJsScriptRunner } from "../src/script/QuickJsScriptRunner.js";
import { createScriptApi } from "../src/script/scriptApi.js";

interface Registered {
  config: { description?: string; inputSchema?: Record<string, z.ZodType> };
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

/** Captures registerTool calls; args go through the tool's real zod schema like the SDK does. */
function captureTools(ctx: ToolContext): Map<string, Registered> {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool: (name: string, config: Registered["config"], handler: Registered["handler"]) => {
      tools.set(name, { config, handler });
    },
  } as unknown as McpServer;
  registerDrawScript(server, ctx);
  return tools;
}

function call(tool: Registered, args: Record<string, unknown>) {
  const parsed = z.object(tool.config.inputSchema ?? {}).parse(args);
  return tool.handler(parsed);
}

function fakeContext(frames = 1) {
  let frameCount = frames;
  const writes: unknown[] = [];
  const gateway = {
    getSpriteInfo: async () => ({
      id: 1,
      filename: "t",
      width: 4,
      height: 4,
      colorMode: "rgb",
      frames: Array.from({ length: frameCount }, (_, i) => ({ index: i + 1, durationMs: 100 })),
      layers: [],
      tags: [],
      activeFrame: 1,
      paletteSize: 0,
      transparentIndex: 0,
    }),
    readImage: async (r: { width?: number; height?: number }) => ({
      rect: { x: 0, y: 0, width: r.width ?? 4, height: r.height ?? 4 },
      image: createRgbaImage(r.width ?? 4, r.height ?? 4),
    }),
    writeImages: async (w: unknown[]) => void writes.push(w),
    readSelection: async () => ({ isEmpty: true, rect: { x: 0, y: 0, width: 0, height: 0 }, mask: new Uint8Array(0) }),
    frameOp: async (op: { op: string; count?: number }) => {
      if (op.op === "add") frameCount += op.count ?? 1;
      return { frames: frameCount };
    },
  } as unknown as IAsepriteGateway;
  const ctx: ToolContext = { gateway, canvas: new CanvasService(gateway), scripts: new QuickJsScriptRunner() };
  return { ctx, writes };
}

describe("draw_script tool", () => {
  it("documents every helper and parameter", () => {
    const tool = captureTools(fakeContext().ctx).get("draw_script")!;
    const scope = { raster: new Raster(1, 1), random: Math.random, noise: () => 0 };
    for (const name of Object.keys(createScriptApi(scope))) {
      expect(tool.config.description, `${name}() missing from API_DOC`).toContain(`${name}(`);
    }
    for (const [key, schema] of Object.entries(tool.config.inputSchema!)) {
      expect(schema.description, `${key} needs .describe()`).toBeTruthy();
    }
  });

  it("returns a summary and a preview image", async () => {
    const tool = captureTools(fakeContext().ctx).get("draw_script")!;
    const result = await call(tool, { code: 'set(0, 0, "#fff"); console.log("hi");' });
    const [text, image] = result.content;
    expect(text).toMatchObject({ type: "text" });
    expect((text as { text: string }).text).toMatch(/^Drew 4x4 at \(0, 0\) on frame 1: \d+ calls, \d+ ms\.\nconsole:\nhi\nPreview/);
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  it("animates with frameCount/startFrame and reports created frames; preview can be skipped", async () => {
    const { ctx, writes } = fakeContext(2);
    const tool = captureTools(ctx).get("draw_script")!;
    const result = await call(tool, { code: 'set(i, 0, "#fff");', frameCount: 4, preview: false });
    expect(result.content).toHaveLength(1);
    expect((result.content[0] as { text: string }).text).toContain("on frames 1-4 (created 3-4)");
    expect(writes).toHaveLength(1);
  });

  it("accepts a frame number as base", () => {
    const tool = captureTools(fakeContext().ctx).get("draw_script")!;
    const schema = z.object(tool.config.inputSchema!);
    expect(schema.parse({ code: "x", base: 1 }).base).toBe(1);
    expect(schema.parse({ code: "x" }).base).toBe("empty");
    expect(() => schema.parse({ code: "x", base: "frame1" })).toThrow();
  });
});

describe("resolveTargetFrames / formatFrames", () => {
  it("resolves frame, frames and frameCount (+startFrame)", () => {
    expect(resolveTargetFrames({})).toBeUndefined();
    expect(resolveTargetFrames({ frame: 3 })).toEqual([3]);
    expect(resolveTargetFrames({ frames: [2, 5] })).toEqual([2, 5]);
    expect(resolveTargetFrames({ frameCount: 3 })).toEqual([1, 2, 3]);
    expect(resolveTargetFrames({ frameCount: 2, startFrame: 4 })).toEqual([4, 5]);
  });

  it("rejects conflicting selections with a fix", () => {
    expect(() => resolveTargetFrames({ frame: 1, frames: [1] })).toThrow(/only one of frame, frames or frameCount/);
    expect(() => resolveTargetFrames({ startFrame: 2 })).toThrow(/startFrame only works together with frameCount/);
  });

  it("compresses frame lists into ranges", () => {
    expect(formatFrames([1, 2, 3, 5, 7, 8])).toBe("1-3, 5, 7-8");
    expect(formatFrames([4])).toBe("4");
  });
});
