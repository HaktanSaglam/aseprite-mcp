import type { IPaletteGateway } from "../aseprite/AsepriteGateway.js";
import type { ChatSendRequest } from "./chatSchema.js";

/**
 * palette "current" means the palette of the sprite the user was working on. Sprites the
 * bridge creates for a request start with Aseprite's default palette, so it is copied
 * over before the model looks at it.
 */
export async function carryOverPalette(
  gateway: Pick<IPaletteGateway, "getPalette" | "setPalette">,
  request: ChatSendRequest,
  targets: number[],
): Promise<void> {
  if (request.options.palette !== "current" || request.sprite === undefined || targets.length === 0) return;
  const { colors } = await gateway.getPalette({ sprite: request.sprite });
  for (const sprite of targets) await gateway.setPalette(colors, { sprite });
}
