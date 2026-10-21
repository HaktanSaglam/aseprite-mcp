import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GUIDE_EXAMPLES, type GuideExample } from "../src/guide/examples.js";
import { findTopic, GUIDE_TOPICS, TOPIC_IDS, topicIndex } from "../src/guide/index.js";
import { INSTRUCTIONS } from "../src/mcp/createMcpServer.js";
import { guideText, registerGuideTools } from "../src/mcp/tools/guide.js";
import type { ToolContext } from "../src/mcp/ToolContext.js";
import { createRgbaImage } from "../src/pixel/RgbaImage.js";
import { QuickJsScriptRunner } from "../src/script/QuickJsScriptRunner.js";

const EXPECTED_TOPICS = [
  "fundamentals",
  "characters",
  "animation",
  "tiles",
  "items_icons",
  "environments",
  "shading_light",
  "color_palettes",
  "outlines_aa",
  "styles",
  "workflow",
];

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

describe("guide topics", () => {
  it("has every required topic exactly once", () => {
    expect([...TOPIC_IDS].sort()).toEqual([...EXPECTED_TOPICS].sort());
  });

  it.each(GUIDE_TOPICS.map((t) => [t.id, t] as const))("%s is dense, titled and summarised", (_, topic) => {
    expect(topic.title.length).toBeGreaterThan(3);
    expect(topic.summary.length).toBeGreaterThan(20);
    expect(topic.body.startsWith("# ")).toBe(true);
    expect(words(topic.body)).toBeGreaterThan(300);
    expect(words(topic.body)).toBeLessThan(1100);
    // Numbers are what make a recipe actionable.
    expect(topic.body).toMatch(/\d/);
  });

  it("lists every topic with its summary when called without a topic", () => {
    const index = topicIndex();
    for (const t of GUIDE_TOPICS) expect(index).toContain(`- ${t.id}: ${t.summary}`);
    expect(guideText(undefined)).toBe(index);
    expect(guideText([])).toBe(index);
  });

  it("returns one or several topics and rejects unknown ids", () => {
    expect(guideText("animation")).toBe(findTopic("animation")!.body);
    const both = guideText(["tiles", "styles", "tiles"]);
    expect(both).toContain(findTopic("tiles")!.body);
    expect(both).toContain(findTopic("styles")!.body);
    expect(both).toBe(`${findTopic("tiles")!.body}\n\n---\n\n${findTopic("styles")!.body}`);
    expect(() => guideText("nonsense")).toThrow(/Unknown topic "nonsense". Topics: fundamentals/);
  });

  it("quotes every worked example in some topic", () => {
    const all = GUIDE_TOPICS.map((t) => t.body).join("\n");
    for (const [name, example] of Object.entries(GUIDE_EXAMPLES)) {
      expect(all, name).toContain(example.code);
    }
  });
});

describe("guide examples run cleanly", () => {
  const runner = new QuickJsScriptRunner();

  /** A filled 32x32 figure as the base for examples that animate existing art. */
  function figure(example: GuideExample) {
    const base = createRgbaImage(example.width, example.height);
    for (let y = 4; y < example.height - 2; y++)
      for (let x = 10; x < 22; x++) base.data.set([200, 120, 80, 255], (y * example.width + x) * 4);
    return base;
  }

  it.each(Object.entries(GUIDE_EXAMPLES))("%s", async (name, example) => {
    const animatesExisting = name === "BREATHING_IDLE";
    const result = await runner.run({
      code: example.code,
      width: example.width,
      height: example.height,
      frames: Array.from({ length: example.frames }, (_, i) => ({
        frame: i + 1,
        base: animatesExisting ? figure(example) : undefined,
      })),
    });
    expect(result.images).toHaveLength(example.frames);
    for (const image of result.images) {
      let opaque = 0;
      for (let o = 3; o < image.data.length; o += 4) if (image.data[o] > 0) opaque++;
      expect(opaque, `${name} drew nothing`).toBeGreaterThan(10);
    }
    if (example.frames > 1) {
      const distinct = new Set(result.images.map((image) => Buffer.from(image.data).toString("base64")));
      expect(distinct.size, `${name} frames are identical`).toBeGreaterThan(1);
    }
    expect(result.logs).toEqual([]);
  });
});

describe("pixel_art_guide tool", () => {
  type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;
  let schema: Record<string, z.ZodType> = {};
  let handler: Handler = async () => ({ content: [] });
  const server = {
    registerTool: (_name: string, config: { inputSchema: Record<string, z.ZodType> }, h: Handler) => {
      schema = config.inputSchema;
      handler = h;
    },
  } as unknown as McpServer;
  registerGuideTools(server, {} as ToolContext);

  it("validates topic ids and returns the topic text", async () => {
    const args = z.object(schema).parse({ topic: "workflow" });
    const result = await handler(args);
    expect(result.content[0]).toEqual({ type: "text", text: findTopic("workflow")!.body });
    expect(() => z.object(schema).parse({ topic: "drawing" })).toThrow();
    expect(() => z.object(schema).parse({ topic: ["tiles", "styles", "animation", "workflow"] })).toThrow();
  });
});

describe("server instructions", () => {
  it("stay a compact playbook that points at the guide", () => {
    expect(words(INSTRUCTIONS)).toBeLessThanOrEqual(350);
    expect(INSTRUCTIONS).toContain("pixel_art_guide");
    for (const id of EXPECTED_TOPICS) expect(INSTRUCTIONS).toContain(id);
    for (const tool of ["draw_script", "write_pixels", "view_sprite", "add_outline", "cleanup_pixels", "analyze_sprite"]) {
      expect(INSTRUCTIONS).toContain(tool);
    }
  });
});
