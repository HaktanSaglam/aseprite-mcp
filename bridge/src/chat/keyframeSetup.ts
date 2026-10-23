import type { IAnimationGateway, SpriteInfo } from "../aseprite/AsepriteGateway.js";
import type { ContinuePlan, InbetweenPlan } from "./animationPrompts.js";
import type { AnimationOptions } from "./chatSchema.js";
import { UserFacingError } from "./chatUpdates.js";

type FrameGateway = Pick<IAnimationGateway, "frameOp">;

/**
 * mode "between": inserts `animation.frames` copies of the first key frame right after
 * it, so both key frames stay as they are. Aseprite stretches tags that cover (or end
 * on) the first key frame over the new frames, so a loop tag keeps the whole cycle.
 * The keys must be neighbours, or the last frame and 1 for a loop: frames between them
 * would sit in the middle of the in-betweens. undefined = Stop.
 */
export async function prepareInbetweens(
  gateway: FrameGateway,
  info: SpriteInfo,
  animation: AnimationOptions,
  signal: AbortSignal,
): Promise<InbetweenPlan | undefined> {
  const count = info.frames.length;
  const from = animation.fromFrame ?? 1;
  const to = animation.toFrame ?? from + 1;
  const missing = [from, to].find((f) => f > count);
  if (missing !== undefined) throw new UserFacingError(`Key frame ${missing} doesn't exist: the sprite has ${count} frame(s).`);
  const wraps = from === count && to === 1;
  if (to !== from + 1 && !wraps) {
    throw new UserFacingError(
      "In-betweens go between neighbouring frames: set To frame to From frame + 1, or From frame to the last frame and To frame to 1 for a loop.",
    );
  }
  if (signal.aborted) return undefined;
  const n = animation.frames;
  await gateway.frameOp({ op: "add", after: from, count: n, copy: true, durationMs: animation.frameMs }, { sprite: info.id });
  return { animation, keyA: from, keyB: wraps ? 1 : from + n + 1, first: from + 1, last: from + n, wraps };
}

/**
 * mode "continue": frames 1..keepFrames stay; the animation grows to `animation.frames`
 * frames (never shrinks: frames are only deleted by the user) with copies of the last
 * frame, which Aseprite adds to a tag ending there. undefined = Stop.
 */
export async function prepareContinuation(
  gateway: FrameGateway,
  info: SpriteInfo,
  animation: AnimationOptions,
  signal: AbortSignal,
): Promise<ContinuePlan | undefined> {
  const count = info.frames.length;
  const keep = animation.keepFrames ?? count;
  if (keep > count) throw new UserFacingError(`Keep frames 1-${keep}: the sprite has only ${count} frame(s).`);
  const total = Math.max(animation.frames, count);
  if (keep >= total) {
    throw new UserFacingError(`Nothing left to draw: all ${total} frames would be kept. Set Frames above ${keep}.`);
  }
  if (signal.aborted) return undefined;
  const added = total - count;
  if (added > 0) {
    await gateway.frameOp({ op: "add", after: count, count: added, copy: true, durationMs: animation.frameMs }, { sprite: info.id });
  }
  return { animation, keep, first: keep + 1, last: total, added };
}
