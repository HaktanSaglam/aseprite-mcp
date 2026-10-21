import { z } from "zod";
import { previewScale, renderPreviewPng } from "../../pixel/previewPng.js";
import type { ToolRegistrar } from "../ToolContext.js";

const MAX_SIDE = 512;

const API_DOC = `
JavaScript (ES2023, no imports, no I/O). Coordinates are relative to (x, y) of the region.
Colors: "#rgb", "#rrggbb", "#rrggbbaa" or "transparent".
  W, H                              region size
  set(x, y, c)  get(x, y) -> "#rrggbbaa"|null
  rect(x, y, w, h, c)               filled
  frame(x, y, w, h, c)              1px outline
  line(x0, y0, x1, y1, c)           Bresenham
  circle(cx, cy, r, c, filled=true)
  ellipse(cx, cy, rx, ry, c, filled=true)
  poly([[x,y], ...], c)             filled polygon
  fill(x, y, c)                     paint bucket (4-connected)
  dither(x, y, w, h, c, amount)     ordered 4x4 Bayer, amount 0..1
  rand(n) -> int in [0, n)          seeded; rand() -> float in [0, 1)
Loops, functions and Math are available. Hard edges only: no anti-aliasing.
`.trim();

export const registerDrawScript: ToolRegistrar = (server, { gateway, canvas, scripts: runner }) => {
  server.registerTool(
    "draw_script",
    {
      title: "Draw with a script",
      description:
        "Draw by writing a short JavaScript program instead of listing every pixel. Much faster " +
        "than write_pixels for anything larger than ~48x48 or with repeated structure (skies, " +
        "terrain, bricks, stars, gradients, scenes). Use write_pixels afterwards for fine detail. " +
        "The result is written as one undo step and a preview of the whole sprite is returned.\n\n" +
        API_DOC,
      inputSchema: {
        code: z.string().min(1),
        x: z.number().int().default(0),
        y: z.number().int().default(0),
        width: z.number().int().min(1).max(MAX_SIDE).optional().describe("Defaults to canvas width - x."),
        height: z.number().int().min(1).max(MAX_SIDE).optional().describe("Defaults to canvas height - y."),
        frame: z.number().int().min(1).optional().describe("1-based. Defaults to the active frame."),
        layer: z.string().optional().describe("Target layer; created if missing. Defaults to the active layer."),
        base: z
          .enum(["empty", "current"])
          .default("empty")
          .describe("'current' starts from the layer's existing pixels so the script can edit them."),
        seed: z.number().int().default(1),
        selectionOnly: z.boolean().default(false).describe("Only change pixels inside the user's selection."),
      },
    },
    async ({ code, x, y, width, height, frame, layer, base, seed, selectionOnly }) => {
      const info = await gateway.getSpriteInfo();
      const w = width ?? Math.min(MAX_SIDE, info.width - x);
      const h = height ?? Math.min(MAX_SIDE, info.height - y);
      if (w < 1 || h < 1) throw new Error("Region is outside the canvas");

      const current =
        base === "current"
          ? (await gateway.readImage({ x, y, width: w, height: h, frame, layer, missingOk: true })).image
          : undefined;
      const result = await runner.run({ code, width: w, height: h, base: current, seed });

      // Starting from current pixels makes the script authoritative for the whole region,
      // so transparent output must erase; on an empty base it must not wipe other art.
      await canvas.paint([{ x, y, image: result.image, frame, layer }], {
        mode: base === "current" ? "replace" : "over",
        selectionOnly,
      });

      const view = await gateway.readImage({ frame, flattened: true });
      const scale = previewScale(view.rect.width, view.rect.height);
      return {
        content: [
          {
            type: "text",
            text: `Drew ${w}x${h} at (${x}, ${y}) with ${result.calls} calls in ${result.elapsedMs} ms. Preview of the whole sprite:`,
          },
          { type: "image", data: renderPreviewPng(view.image, scale).toString("base64"), mimeType: "image/png" },
        ],
      };
    },
  );
};
