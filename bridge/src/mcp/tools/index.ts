import type { ToolRegistrar } from "../ToolContext.js";
import { registerDrawScript } from "./drawScript.js";
import { registerPaletteTools } from "./palette.js";
import { registerPixelTools } from "./pixels.js";
import { registerSpriteTools } from "./sprite.js";

/** Order matters only for how clients list the tools. */
export const TOOL_REGISTRARS: ToolRegistrar[] = [
  registerSpriteTools,
  registerPixelTools,
  registerDrawScript,
  registerPaletteTools,
];
