import { z } from "zod";
import type { AnimationDirection, FrameOp, SpriteInfo, TagOp } from "../../aseprite/protocol.js";
import { rejectUnusedArgs } from "../actionArgs.js";
import type { ToolRegistrar } from "../ToolContext.js";
import { jsonResult } from "../toolResult.js";

export const FRAME_ACTIONS = ["add", "delete", "duration", "activate"] as const;
export const TAG_ACTIONS = ["add", "update", "delete"] as const;
const DIRECTIONS = ["forward", "reverse", "pingpong", "pingpong_reverse"] as const;
const MAX_FRAME_MS = 65535;

export interface ManageFramesArgs {
  action: (typeof FRAME_ACTIONS)[number];
  after?: number;
  count?: number;
  copy?: boolean;
  durationMs?: number;
  from?: number;
  to?: number;
  frames?: number[];
  frame?: number;
}

export interface ManageTagsArgs {
  action: (typeof TAG_ACTIONS)[number];
  name: string;
  newName?: string;
  from?: number;
  to?: number;
  direction?: AnimationDirection;
  repeats?: number;
  color?: string;
}

const FRAME_PARAMS: Record<ManageFramesArgs["action"], string[]> = {
  add: ["after", "count", "copy", "durationMs"],
  delete: ["from", "to"],
  duration: ["frames", "durationMs"],
  activate: ["frame"],
};

const TAG_PARAMS: Record<ManageTagsArgs["action"], string[]> = {
  add: ["name", "from", "to", "direction", "repeats", "color"],
  update: ["name", "newName", "from", "to", "direction", "repeats", "color"],
  delete: ["name"],
};

function checkFrame(n: number, frameCount: number, what = "Frame"): number {
  if (!Number.isInteger(n) || n < 1 || n > frameCount) {
    throw new Error(`${what} ${n} out of range (sprite has ${frameCount} frame${frameCount === 1 ? "" : "s"})`);
  }
  return n;
}

/** Validates one manage_frames call against the sprite's frame count and builds frame_op. */
export function toFrameOp(args: ManageFramesArgs, frameCount: number): FrameOp {
  rejectUnusedArgs(args.action, args, FRAME_PARAMS[args.action]);
  switch (args.action) {
    case "add":
      if (args.after !== undefined) checkFrame(args.after, frameCount, "after: frame");
      return { op: "add", after: args.after, count: args.count, copy: args.copy, durationMs: args.durationMs };
    case "delete": {
      if (args.from === undefined) throw new Error("delete needs from (and optionally to) frame numbers");
      const from = checkFrame(args.from, frameCount);
      const to = checkFrame(args.to ?? from, frameCount);
      if (to < from) throw new Error(`to (${to}) must not be before from (${from})`);
      if (to - from + 1 >= frameCount) throw new Error("Cannot delete every frame; a sprite needs at least one");
      return { op: "delete", from, to };
    }
    case "duration": {
      if (args.durationMs === undefined) throw new Error("duration needs durationMs (e.g. 100 for 10 fps)");
      const frames = args.frames ? [...new Set(args.frames)].map((f) => checkFrame(f, frameCount)) : undefined;
      return { op: "duration", frames, durationMs: args.durationMs };
    }
    case "activate":
      if (args.frame === undefined) throw new Error("activate needs frame");
      return { op: "activate", frame: checkFrame(args.frame, frameCount) };
  }
}

function requireTag(info: SpriteInfo, name: string) {
  const tag = info.tags.find((t) => t.name === name);
  if (!tag) throw new Error(`Tag "${name}" not found. Tags: ${info.tags.map((t) => t.name).join(", ") || "none"}`);
  return tag;
}

function requireFreeTagName(info: SpriteInfo, name: string): void {
  if (info.tags.some((t) => t.name === name)) throw new Error(`Tag "${name}" already exists; use action 'update' to change it`);
}

function checkRange(from: number, to: number, frameCount: number): void {
  checkFrame(from, frameCount, "from: frame");
  checkFrame(to, frameCount, "to: frame");
  if (to < from) throw new Error(`Tag range ${from}-${to} is reversed; from must be <= to`);
}

/** Validates one manage_tags call against the sprite's frames and tags and builds tag_op. */
export function toTagOp(args: ManageTagsArgs, info: SpriteInfo): TagOp {
  rejectUnusedArgs(args.action, args, TAG_PARAMS[args.action]);
  const frameCount = info.frames.length;
  switch (args.action) {
    case "add": {
      requireFreeTagName(info, args.name);
      const from = args.from ?? 1;
      const to = args.to ?? frameCount;
      checkRange(from, to, frameCount);
      return { op: "add", name: args.name, from, to, direction: args.direction, repeats: args.repeats, color: args.color };
    }
    case "update": {
      const tag = requireTag(info, args.name);
      const { newName, from, to, direction, repeats, color } = args;
      if ([newName, from, to, direction, repeats, color].every((v) => v === undefined)) {
        throw new Error("update needs at least one of newName, from, to, direction, repeats, color");
      }
      if (newName !== undefined && newName !== tag.name) requireFreeTagName(info, newName);
      checkRange(from ?? tag.from, to ?? tag.to, frameCount);
      return { op: "update", name: tag.name, newName, from, to, direction, repeats, color };
    }
    case "delete":
      return { op: "delete", name: requireTag(info, args.name).name };
  }
}

/** "1-4: 100ms, 5: 250ms": runs of consecutive frames with equal durations. */
export function formatDurations(frames: { index: number; durationMs: number }[]): string {
  const parts: string[] = [];
  let start = 0;
  for (let i = 1; i <= frames.length; i++) {
    const continues =
      i < frames.length &&
      frames[i].durationMs === frames[start].durationMs &&
      frames[i].index === frames[i - 1].index + 1;
    if (continues) continue;
    const first = frames[start].index;
    const last = frames[i - 1].index;
    parts.push(`${first === last ? first : `${first}-${last}`}: ${frames[start].durationMs}ms`);
    start = i;
  }
  return parts.join(", ");
}

export function tagSummary(info: SpriteInfo) {
  return info.tags.map(({ name, from, to, direction, repeats }) => ({ name, from, to, direction, repeats }));
}

function framesSummary(info: SpriteInfo) {
  return {
    frameCount: info.frames.length,
    activeFrame: info.activeFrame,
    durations: formatDurations(info.frames),
    totalMs: info.frames.reduce((sum, f) => sum + f.durationMs, 0),
    ...(info.tags.length > 0 ? { tags: tagSummary(info) } : {}),
  };
}

export const registerAnimationTools: ToolRegistrar = (server, { gateway }) => {
  const frameNumber = z.number().int().min(1);

  server.registerTool(
    "manage_frames",
    {
      title: "Manage frames",
      description:
        "Add, delete, time or activate animation frames (1-based; one undo step). To animate: add frames " +
        "with copy: true, redraw what moves in each frame (drawing tools take frame), then check the whole " +
        "animation with view_sprite frames: \"all\". Actions:\n" +
        "- add: count new frames after frame `after` (default last); copy: true duplicates that frame's pixels\n" +
        "- delete: frames from..to\n" +
        "- duration: durationMs for frames (default all); 100ms = 10 fps\n" +
        "- activate: show frame in Aseprite\n" +
        "Returns frame count, durations and tags.",
      inputSchema: {
        action: z.enum(FRAME_ACTIONS).describe("What to do; each action uses only the arguments listed above."),
        after: frameNumber.optional().describe("add: insert after this frame (default: the last one)."),
        count: z.number().int().min(1).max(64).optional().describe("add: how many frames (default 1)."),
        copy: z
          .boolean()
          .optional()
          .describe("add: true copies frame `after` into the new frames; false (default) adds empty frames."),
        durationMs: z.number().int().min(1).max(MAX_FRAME_MS).optional().describe("add/duration: frame duration in ms."),
        from: frameNumber.optional().describe("delete: first frame to remove."),
        to: frameNumber.optional().describe("delete: last frame to remove (default: from)."),
        frames: z.array(frameNumber).min(1).optional().describe("duration: frames to change (default: all)."),
        frame: frameNumber.optional().describe("activate: frame to show."),
      },
    },
    async (args) => {
      const before = await gateway.getSpriteInfo();
      await gateway.frameOp(toFrameOp(args, before.frames.length));
      const after = await gateway.getSpriteInfo();
      return jsonResult({ ok: true, action: args.action, ...framesSummary(after) });
    },
  );

  server.registerTool(
    "manage_tags",
    {
      title: "Manage animation tags",
      description:
        "Name frame ranges as animation tags (e.g. idle 1-4, walk 5-12) so Aseprite, exports and game " +
        "engines can play each animation on its own. Actions: add (name, from, to, direction, repeats, " +
        "color), update (name plus the fields to change, newName to rename), delete (name). Returns all tags.",
      inputSchema: {
        action: z.enum(TAG_ACTIONS).describe("add a new tag, update an existing one, or delete it."),
        name: z.string().min(1).describe("Tag name (add: the new tag's name)."),
        newName: z.string().min(1).optional().describe("update: rename the tag."),
        from: frameNumber.optional().describe("add/update: first frame (add default: 1)."),
        to: frameNumber.optional().describe("add/update: last frame (add default: last frame)."),
        direction: z.enum(DIRECTIONS).optional().describe("add/update: playback direction (default forward)."),
        repeats: z.number().int().min(0).max(65535).optional().describe("add/update: times to play; 0 = loop forever."),
        color: z
          .string()
          .regex(/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, "Use #rrggbb")
          .optional()
          .describe("add/update: tag color in the timeline, #rrggbb."),
      },
    },
    async (args) => {
      const before = await gateway.getSpriteInfo();
      await gateway.tagOp(toTagOp(args, before));
      const after = await gateway.getSpriteInfo();
      return jsonResult({ ok: true, action: args.action, tags: tagSummary(after), frameCount: after.frames.length });
    },
  );
};
