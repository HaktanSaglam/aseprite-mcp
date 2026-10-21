import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { previewScale, renderPreviewPng } from "../../pixel/previewPng.js";
import {
  DrawScriptService,
  FILMSTRIP_COLUMNS,
  MAX_FRAMES_PER_CALL,
  MAX_SIDE,
  type DrawScriptOutcome,
} from "../../script/DrawScriptService.js";
import { API_DOC } from "../../script/scriptApi.js";
import type { ToolRegistrar } from "../ToolContext.js";

// Filmstrips are wide; a larger target keeps each frame big enough to judge.
const PREVIEW_TARGET = 512;
const FILMSTRIP_TARGET = 768;

const DESCRIPTION =
  "Draw by running a short JavaScript program instead of listing pixels: the fastest way to " +
  "block in silhouettes, shade with hue-shifted ramps, build scenes, tiles, gradients and whole " +
  "animations. Use write_pixels/stamp() for hand-placed detail afterwards. Every call is one undo " +
  "step and returns a preview (a filmstrip when drawing several frames).\n" +
  "Animation: pass frameCount (+ startFrame) or frames; the script runs once per frame with F/i/n/t " +
  "set, missing frames are created, frameMs sets their duration. base:<frame number> starts every " +
  "frame from that frame's pixels (animate existing art); base:'current' starts each frame from its " +
  "own pixels; 'empty' draws on top of what is there.\n\n" +
  API_DOC;

export function formatFrames(frames: number[]): string {
  const sorted = [...frames].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let k = 0; k < sorted.length; k++) {
    const start = sorted[k];
    while (k + 1 < sorted.length && sorted[k + 1] === sorted[k] + 1) k++;
    parts.push(start === sorted[k] ? `${start}` : `${start}-${sorted[k]}`);
  }
  return parts.join(", ");
}

/** Frame selection from the tool arguments; conflicting combinations are rejected with a fix. */
export function resolveTargetFrames(args: {
  frame?: number;
  frames?: number[];
  frameCount?: number;
  startFrame?: number;
}): number[] | undefined {
  const given = [args.frame !== undefined, args.frames !== undefined, args.frameCount !== undefined].filter(Boolean);
  if (given.length > 1) throw new Error("Pass only one of frame, frames or frameCount.");
  if (args.startFrame !== undefined && args.frameCount === undefined) {
    throw new Error("startFrame only works together with frameCount.");
  }
  if (args.frames) return args.frames;
  if (args.frameCount !== undefined) {
    const start = args.startFrame ?? 1;
    return Array.from({ length: args.frameCount }, (_, k) => start + k);
  }
  return args.frame === undefined ? undefined : [args.frame];
}

function summary(o: DrawScriptOutcome, x: number, y: number): string {
  const where = o.frames.length === 1 ? `frame ${o.frames[0]}` : `frames ${formatFrames(o.frames)}`;
  const created = o.created.length ? ` (created ${formatFrames(o.created)})` : "";
  const lines = [`Drew ${o.width}x${o.height} at (${x}, ${y}) on ${where}${created}: ${o.calls} calls, ${o.elapsedMs} ms.`];
  if (o.logs.length) lines.push(`console:\n${o.logs.join("\n")}`);
  if (o.preview) {
    lines.push(
      o.frames.length === 1
        ? "Preview of the whole sprite:"
        : `Filmstrip of frames ${formatFrames(o.frames)} (left to right, ${FILMSTRIP_COLUMNS} per row):`,
    );
  }
  return lines.join("\n");
}


export const registerDrawScript: ToolRegistrar = (server, { gateway, canvas, scripts }) => {
  const service = new DrawScriptService(gateway, canvas, scripts);

  server.registerTool(
    "draw_script",
    {
      title: "Draw with a script",
      description: DESCRIPTION,
      inputSchema: {
        code: z.string().min(1).describe("JavaScript using the helpers above."),
        x: z.number().int().default(0).describe("Region left edge on the canvas."),
        y: z.number().int().default(0).describe("Region top edge on the canvas."),
        width: z.number().int().min(1).max(MAX_SIDE).optional().describe("Region width. Defaults to canvas width - x."),
        height: z.number().int().min(1).max(MAX_SIDE).optional().describe("Region height. Defaults to canvas height - y."),
        frame: z.number().int().min(1).optional().describe("Single 1-based target frame. Defaults to the active frame."),
        frames: z
          .array(z.number().int().min(1))
          .min(1)
          .max(MAX_FRAMES_PER_CALL)
          .optional()
          .describe("Animation: exact 1-based frames to draw; frames past the end are created."),
        frameCount: z
          .number()
          .int()
          .min(1)
          .max(MAX_FRAMES_PER_CALL)
          .optional()
          .describe("Animation: draw this many consecutive frames starting at startFrame."),
        startFrame: z.number().int().min(1).optional().describe("First frame for frameCount. Default 1."),
        frameMs: z.number().int().min(10).max(65535).optional().describe("Duration in ms for every drawn frame."),
        layer: z.string().optional().describe("Target layer; created if missing. Defaults to the active layer."),
        base: z
          .union([z.enum(["empty", "current"]), z.number().int().min(1)])
          .default("empty")
          .describe(
            "'empty': start transparent, draw over existing art. 'current': start from each frame's own " +
              "pixels (the script owns the region: transparent erases). A frame number: every frame starts " +
              "from that frame's pixels, e.g. 1 to animate a finished sprite.",
          ),
        seed: z.number().int().default(1).describe("Seed for rand() and noise()."),
        selectionOnly: z.boolean().default(false).describe("Only change pixels inside the user's selection."),
        preview: z
          .boolean()
          .default(true)
          .describe("Return a preview image. Set false for intermediate passes to save time and tokens."),
      },
    },
    async (args): Promise<CallToolResult> => {
      const outcome = await service.draw({
        code: args.code,
        x: args.x,
        y: args.y,
        width: args.width,
        height: args.height,
        frames: resolveTargetFrames(args),
        layer: args.layer,
        base: args.base,
        seed: args.seed,
        selectionOnly: args.selectionOnly,
        frameMs: args.frameMs,
        preview: args.preview,
      });

      const content: CallToolResult["content"] = [{ type: "text", text: summary(outcome, args.x, args.y) }];
      if (outcome.preview) {
        const target = outcome.frames.length > 1 ? FILMSTRIP_TARGET : PREVIEW_TARGET;
        const scale = previewScale(outcome.preview.width, outcome.preview.height, target);
        content.push({ type: "image", data: renderPreviewPng(outcome.preview, scale).toString("base64"), mimeType: "image/png" });
      }
      return { content };
    },
  );
};
