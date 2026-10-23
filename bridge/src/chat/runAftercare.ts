import type { ISpriteCloser } from "../aseprite/AsepriteGateway.js";
import type { DrawnCel } from "../aseprite/SpriteActivity.js";
import type { ChatOptions } from "./chatSchema.js";
import type { ChatSink } from "./chatUpdates.js";
import type { PaletteEnforcer } from "./paletteLimits.js";

/**
 * Closes a sprite the bridge created for a request that failed or was stopped, unless
 * something was drawn in it. `nothingDrawn` closes it even with pixels in it: for the
 * pixels the bridge put there itself (a copy of the user's design). Best effort: a
 * leftover tab is better than an error that hides why the request ended.
 */
export async function closeIfEmpty(gateway: ISpriteCloser, sprite: number, nothingDrawn = false): Promise<void> {
  try {
    await gateway.closeSprite(sprite, { onlyIfEmpty: !nothingDrawn });
  } catch (error) {
    console.error(`[bridge] could not close sprite #${sprite}:`, error);
  }
}

/**
 * forcePalette with a preset or custom palette, before the run: it becomes the sprite
 * palette, which the run's own undo steps then include. Best effort, like the snap after.
 */
export async function applyChosenPalette(enforcer: PaletteEnforcer, sprite: number, options: ChatOptions): Promise<void> {
  try {
    await enforcer.presetSpritePalette(sprite, options);
  } catch (error) {
    console.error(`[bridge] could not set the palette of sprite #${sprite}:`, error);
  }
}

/**
 * maxColors / forcePalette after a successful run, reported in the chat. A failure is
 * reported, not thrown: the art itself is finished.
 */
export async function enforceColorRules(
  enforcer: PaletteEnforcer,
  sprite: number,
  drawn: readonly DrawnCel[],
  options: ChatOptions,
  sink: ChatSink,
  label?: string,
): Promise<void> {
  const prefix = label ? `${label}: ` : "";
  try {
    const status = await enforcer.enforce(sprite, drawn, options);
    if (status) sink({ kind: "status", text: prefix + status });
  } catch (error) {
    sink({ kind: "error", text: `${prefix}Could not apply the color rules: ${error instanceof Error ? error.message : String(error)}` });
  }
}
