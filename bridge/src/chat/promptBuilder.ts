import type { Rect } from "../aseprite/AsepriteGateway.js";

export type QuickAction = "redraw_selection" | "review";

export interface ChatRequest {
  text: string;
  selection?: Rect;
  action?: QuickAction;
}

/** Appended to Claude Code's system prompt for every chat run. */
export const CHAT_SYSTEM_PROMPT = `
You are the Claude panel inside Aseprite. The user talks to you through a small chat
window that renders plain text only.
- Reply in the user's language, in 1-3 short sentences. No markdown, no lists, no code.
- Do the work with the aseprite tools instead of describing it. Never ask for permission
  to draw; every edit is a single undo step for the user.
- When editing existing art, read it first and match its palette, outline and shading style.
- Be fast: use draw_script for anything bigger than ~48x48 and finish a scene in a few
  scripts; reserve write_pixels for small sprites and final touch-ups.
`.trim();

function selectionNote(s: Rect): string {
  return (
    `The user has selected x=${s.x}, y=${s.y}, ${s.width}x${s.height} px on the active sprite. ` +
    "Treat it as the area to change: write only there, with selectionOnly: true."
  );
}

/**
 * Quick-action buttons are prompt templates: the UI stays dumb and the wording that
 * steers Claude lives in one testable place.
 */
export function buildPrompt(request: ChatRequest): string {
  const text = request.text.trim();
  const parts: string[] = [];

  switch (request.action) {
    case "redraw_selection":
      parts.push(
        `Redraw the selected area${text ? `: ${text}` : " so it looks better while keeping its idea"}.`,
        "First read the selection plus a few pixels around it so the result blends into the " +
          "surrounding art, then write on the active layer and check the result with view_sprite.",
      );
      break;
    case "review":
      parts.push(
        "Look at the sprite with view_sprite and fix pixel-art problems (stray pixels, broken " +
          "or doubled outlines, inconsistent light direction, banding) without changing the design.",
      );
      if (text) parts.push(`User note: ${text}`);
      break;
    default:
      parts.push(text);
  }

  if (request.selection) parts.push(selectionNote(request.selection));
  return parts.join("\n\n");
}
