import type { ToolRegistrar } from "../ToolContext.js";
import { registerAnimationTools } from "./animation.js";
import { registerColorTools } from "./colors.js";
import { registerDocumentTools } from "./document.js";
import { registerDrawScript } from "./drawScript.js";
import { registerEffectTools } from "./effects.js";
import { registerGuideTools } from "./guide.js";
import { registerLayerTools } from "./layers.js";
import { registerPaletteTools } from "./palette.js";
import { registerPixelTools } from "./pixels.js";
import { registerSelectionTools } from "./selection.js";
import { registerSpriteTools } from "./sprite.js";

/** Order matters only for how clients list the tools. */
export const TOOL_REGISTRARS: ToolRegistrar[] = [
  registerSpriteTools,
  registerDocumentTools,
  registerPixelTools,
  registerDrawScript,
  registerLayerTools,
  registerAnimationTools,
  registerSelectionTools,
  registerPaletteTools,
  registerColorTools,
  registerEffectTools,
  registerGuideTools,
];
