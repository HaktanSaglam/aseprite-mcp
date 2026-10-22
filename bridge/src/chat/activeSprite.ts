import type { ISpriteGateway, SpriteInfo } from "../aseprite/AsepriteGateway.js";

/** What the extension answers when no tab is open (core/util.lua, U.sprite). */
const NO_SPRITE_OPEN = "No sprite is open in Aseprite";

/**
 * The sprite in the user's active tab, or undefined when no sprite is open. Any other
 * failure (a timeout while a modal dialog blocks Aseprite, a disconnect) is rethrown:
 * read as "nothing open" it would send the model off to create a new sprite next to
 * the art the user has open.
 */
export async function activeSpriteInfo(gateway: Pick<ISpriteGateway, "getSpriteInfo">): Promise<SpriteInfo | undefined> {
  try {
    return await gateway.getSpriteInfo();
  } catch (error) {
    if (error instanceof Error && error.message.includes(NO_SPRITE_OPEN)) return undefined;
    throw error;
  }
}
