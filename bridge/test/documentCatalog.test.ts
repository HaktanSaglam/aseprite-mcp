import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAnimationTools } from "../src/mcp/tools/animation.js";
import { registerDocumentTools } from "../src/mcp/tools/document.js";
import { registerLayerTools } from "../src/mcp/tools/layers.js";
import { registerPixelTools } from "../src/mcp/tools/pixels.js";
import { registerSelectionTools } from "../src/mcp/tools/selection.js";
import { registerSpriteTools } from "../src/mcp/tools/sprite.js";
import { toolHarness, type ListedTool, type ToolHarness } from "./fakes/toolHarness.js";

// Names shared with prompts, the chat UI and the instant tools (docs/PROTOCOL.md).
const OWNED_TOOLS = [
  "get_sprite_info",
  "create_sprite",
  "list_sprites",
  "select_sprite",
  "edit_sprite",
  "undo",
  "redo",
  "save_sprite",
  "export_sprite",
  "view_sprite",
  "manage_layers",
  "manage_frames",
  "manage_tags",
  "get_selection",
  "set_selection",
];

let h: ToolHarness;
let tools: ListedTool[];

beforeAll(async () => {
  h = await toolHarness([
    registerSpriteTools,
    registerDocumentTools,
    registerPixelTools,
    registerLayerTools,
    registerAnimationTools,
    registerSelectionTools,
  ]);
  tools = await h.listTools();
});
afterAll(() => h.close());

describe("tool catalog", () => {
  it("registers every document, structure, selection and view tool under its shared name", () => {
    const names = tools.map((t) => t.name);
    for (const name of OWNED_TOOLS) expect(names).toContain(name);
  });

  it.each(OWNED_TOOLS)("%s has a description and documents every parameter", (name) => {
    const tool = tools.find((t) => t.name === name)!;
    expect(tool.description?.length).toBeGreaterThan(40);
    for (const [param, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
      expect(schema.description, `${name}.${param}`).toBeTruthy();
    }
  });

  it("keeps undo/redo compatible with the instant-tool contract ({steps?})", () => {
    for (const name of ["undo", "redo"]) {
      const tool = tools.find((t) => t.name === name)!;
      expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(["steps"]);
      expect(tool.inputSchema.required ?? []).toEqual([]);
    }
  });
});
