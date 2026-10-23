import type { AnimationOptions } from "./chatSchema.js";
import { guideReference } from "./guideSelector.js";
import {
  ANIMATION_POSES,
  explicitOptions,
  finishSection,
  join,
  json,
  replyLanguage,
  type PromptContext,
} from "./promptBuilder.js";

// Prompts for the v1.1 animate modes. The bridge has already prepared the frames, so
// every prompt names exact frame numbers and what must stay untouched.

/** mode "between": new frames first-last sit between key frames keyA and keyB. */
export interface InbetweenPlan {
  animation: AnimationOptions;
  keyA: number;
  keyB: number;
  first: number;
  last: number;
  /** keyB is frame 1: the in-betweens close a loop after the last frame. */
  wraps: boolean;
}

/** mode "continue": frames 1-keep stay, first-last are drawn; added = frames appended as copies. */
export interface ContinuePlan {
  animation: AnimationOptions;
  keep: number;
  first: number;
  last: number;
  /** Frames last-added+1..last were added by the bridge as copies of the frame before them. */
  added: number;
}

const range = (first: number, last: number) => (first === last ? `frame ${first}` : `frames ${first}-${last}`);
/** range() at the start of a sentence. */
const Range = (first: number, last: number) => `F${range(first, last).slice(1)}`;
const loopLine = (a: AnimationOptions) => (a.loop ? "looping (the last frame must flow into the first)" : "plays once");

/**
 * `base` is where every drawn frame starts from: a frame number (the pose) or "current"
 * (each frame's own pixels). Without the exact frames, draw_script would write frames 1..n,
 * which here are finished art.
 */
function motionRules(first: number, last: number, base: number | "current"): string {
  return [
    "- Keep the size, proportions, palette and outline identical to the finished frames: no jitter, no redesign.",
    `- One call can draw them all: draw_script ${json({ startFrame: first, frameCount: last - first + 1, base })} (the script runs once per frame; i is 0 on frame ${first}).`,
    `- Move parts instead of repainting everything: transform_layer ${json({ op: "shift", dx: 0, dy: 1, frames: [first] })} for whole-body bobs; draw_script with base:"current" and frame:k to redraw one frame's limbs.`,
    "- Secondary motion (hair, cloth, tails) follows one frame behind the main motion.",
  ].join("\n");
}

const animationGuide = () => guideReference("animation");

export function inbetweenPrompt(ctx: PromptContext, plan: InbetweenPlan, keysAttached: boolean): string {
  const text = ctx.text.trim();
  const count = plan.last - plan.first + 1;
  return join([
    `Draw ${count} in-between frame${count > 1 ? "s" : ""} for this animation: ${range(plan.first, plan.last)} go from key frame ${plan.keyA} ` +
      `to key frame ${plan.keyB}${plan.wraps ? " (the loop starts over there)" : ""}.${text ? ` ${text}` : ""}`,
    [
      `- Key frames ${plan.keyA} and ${plan.keyB} are finished: never change them, and don't touch any other frame.`,
      `- ${Range(plan.first, plan.last)} ${count > 1 ? "are copies" : "is a copy"} of frame ${plan.keyA}; redraw ${count > 1 ? "each as an evenly spaced step" : "it as the halfway pose"} ` +
        "between the two key poses. Parts travel along arcs, not straight lines; ease in and out where a key frame holds a pose " +
        "(smaller steps next to it).",
      motionRules(plan.first, plan.last, "current"),
      "- Don't add or remove frames.",
    ].join("\n"),
    `The new frames last ${plan.animation.frameMs} ms each.` +
      (keysAttached ? ` Key frame ${plan.keyA} (left) and key frame ${plan.keyB} (right) are attached.` : ""),
    finishSection(ctx.options),
    explicitOptions(ctx),
    animationGuide(),
    ctx.canvas,
    replyLanguage(ctx.text),
  ]);
}

export function continuePrompt(ctx: PromptContext, plan: ContinuePlan, keptAttached: boolean): string {
  const { animation } = plan;
  const text = ctx.text.trim();
  const motion = animation.preset === "custom" ? "the motion the frames show" : ANIMATION_POSES[animation.preset];
  // The sprite's frame count before the bridge appended copies.
  const existing = plan.last - plan.added;
  const origin = [
    existing >= plan.first ? `${Range(plan.first, existing)} already existed: redraw ${existing > plan.first ? "them" : "it"}.` : "",
    plan.added > 0 ? `${Range(existing + 1, plan.last)} ${plan.added > 1 ? "are copies" : "is a copy"} of frame ${existing}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return join([
    `Continue this animation: ${motion}.${text ? ` ${text}` : ""}`,
    `Animation: ${plan.last} frames in total, ${loopLine(animation)}.`,
    [
      `- Frames 1-${plan.keep} are finished: never change them.`,
      `- Draw ${range(plan.first, plan.last)} so the motion carries on from frame ${plan.keep}` +
        `${animation.loop ? " and flows back into frame 1" : ""}. ${origin}`,
      motionRules(plan.first, plan.last, "current"),
      "- Don't add or remove frames.",
    ].join("\n"),
    keptAttached ? `The finished frames are attached, left to right then top to bottom, ending with frame ${plan.keep}.` : undefined,
    finishSection(ctx.options),
    explicitOptions(ctx),
    animationGuide(),
    ctx.canvas,
    replyLanguage(ctx.text),
  ]);
}

/** One direction of animation.allDirections; the first one sets the motion. */
export interface DirectionRun {
  animation: AnimationOptions;
  direction: string;
  tag: string;
  first: number;
  last: number;
  /** The direction's own pose (the frame of its direction tag). */
  pose: number;
  /** Frames left from an earlier attempt, which may hold part of the motion. */
  resumed: boolean;
  /** Every direction of the request in order, and which ones the bridge mirrors. */
  order: readonly string[];
  mirrored: readonly { from: string; to: string }[];
  /** The finished animation this direction must match; undefined for the first one. */
  model?: { tag: string; first: number; last: number };
  /** The model's animation (as a filmstrip) and the pose are attached, in that order. */
  imagesAttached: boolean;
}

function directionSetup(run: DirectionRun): string {
  const frames = Range(run.first, run.last);
  const setup = run.resumed
    ? `${frames} (tag "${run.tag}") already exist with their durations, left from an earlier attempt; they may hold part of the motion.`
    : `${frames} (tag "${run.tag}") are already set up as copies of the "${run.direction}" pose (frame ${run.pose}), with their durations.`;
  return `${setup} Edit only ${range(run.first, run.last)}: leave every other frame as it is, and don't add or remove frames.`;
}

export function directionAnimationPrompt(ctx: PromptContext, run: DirectionRun): string {
  const { animation } = run;
  const text = ctx.text.trim();
  const mirrorNote = run.mirrored.length
    ? `; ${run.mirrored.map((m) => `${m.to} is mirrored from ${m.from}`).join(", ")} by the bridge`
    : "";

  if (!run.model) {
    return join([
      `Animate this character facing ${run.direction}: ${ANIMATION_POSES[animation.preset]}.${text ? ` ${text}` : ""}`,
      `The sprite holds one pose per direction and the bridge animates them one after another (${run.order.join(", ")}${mirrorNote}). ` +
        "This first direction sets the motion the others copy, so make it clean and readable.",
      `Animation: ${animation.frames} frames, ${animation.frameMs} ms per frame, ${loopLine(animation)}.`,
      directionSetup(run),
      motionRules(run.first, run.last, run.resumed ? "current" : run.pose),
      run.imagesAttached ? `The "${run.direction}" pose (frame ${run.pose}) is attached.` : undefined,
      finishSection(ctx.options),
      explicitOptions(ctx),
      animationGuide(),
      ctx.canvas,
      replyLanguage(ctx.text),
    ]);
  }

  const model = run.model;
  return join([
    `Animate the same motion facing ${run.direction}: ${ANIMATION_POSES[animation.preset]}.${text ? ` ${text}` : ""}`,
    `Match "${model.tag}" (${range(model.first, model.last)}): the same ${animation.frames} frames and timing, the same phase on each ` +
      "frame (the same pose of the cycle on the same frame number) and the same amount of bob, swing and squash; only the viewpoint changes.",
    directionSetup(run),
    motionRules(run.first, run.last, run.resumed ? "current" : run.pose),
    run.imagesAttached ? `Attached: "${model.tag}" left to right, then the "${run.direction}" pose (frame ${run.pose}).` : undefined,
    finishSection(ctx.options),
    explicitOptions(ctx),
    ctx.canvas,
    replyLanguage(ctx.text),
  ]);
}

/** After allDirections mirrored animations: fix the details that must not be mirrored. */
export interface MirroredAnimation {
  fromTag: string;
  tag: string;
  direction: string;
  first: number;
  last: number;
  pose: number;
}

export function mirroredAnimationFixPrompt(ctx: PromptContext, mirrored: readonly MirroredAnimation[], attached: boolean): string {
  const copies = mirrored.map((m) => `"${m.fromTag}" into "${m.tag}" (${range(m.first, m.last)})`).join(", ");
  const poses = mirrored.map((m) => `"${m.tag}" with the "${m.direction}" pose (frame ${m.pose})`).join(", ");
  return join([
    `The bridge mirrored ${copies}.${attached ? " The mirrored frames are attached, one strip per direction." : ""}`,
    `Compare ${poses} and fix only what must not be mirrored: details that belong to one side of the body (the hand holding ` +
      "a weapon or shield, a side parting, an eye patch, a badge, lettering). Edit only those frames (draw_script with " +
      'base:"current" and frame k, or write_pixels with frame k) and leave every other pixel as it is. If nothing needs fixing, change nothing.',
    ctx.canvas,
    replyLanguage(ctx.text),
  ]);
}
