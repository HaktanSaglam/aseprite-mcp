import type { IAnimationGateway, SpriteInfo, TagOp } from "../aseprite/AsepriteGateway.js";
import type { AnimationOptions } from "./chatSchema.js";
import type { AnimationPlan } from "./promptBuilder.js";

interface Unfinished {
  tag: string;
  frames: number;
}

/**
 * The frames, durations and tag the bridge adds before an animate run, so the model can
 * start drawing at once. Stop is checked between the steps, and the setup is safe to
 * repeat: a retry after a failed or stopped attempt picks up what the earlier one did
 * instead of adding the frames a second time.
 */
export class AnimationSetup {
  /** Sprites whose frames were added but whose setup was stopped before the tag existed. */
  private readonly unfinished = new Map<number, Unfinished>();

  constructor(private readonly gateway: Pick<IAnimationGateway, "frameOp" | "tagOp">) {}

  /** undefined = Stop was pressed; the next attempt continues from where this one stopped. */
  async prepare(
    info: SpriteInfo,
    animation: AnimationOptions,
    tag: string,
    signal: AbortSignal,
  ): Promise<AnimationPlan | undefined> {
    const existing = info.tags.find((t) => t.name === tag);
    if (this.isComplete(info, animation, existing)) {
      this.unfinished.delete(info.id);
      return { animation, tag, prepared: true, resumed: true };
    }
    const resuming = this.isUnfinished(info, animation, tag);
    // Frames the user already has are theirs to arrange; the model is told how to extend them.
    if (info.frames.length !== 1 && !resuming) {
      return { animation, tag, prepared: false, existingTag: existing && { from: existing.from, to: existing.to } };
    }

    const ref = { sprite: info.id };
    if (!resuming) {
      if (signal.aborted) return undefined;
      await this.gateway.frameOp({ op: "add", after: 1, count: animation.frames - 1, copy: true }, ref);
      this.unfinished.set(info.id, { tag, frames: animation.frames });
    }
    if (signal.aborted) return undefined;
    await this.gateway.frameOp({ op: "duration", durationMs: animation.frameMs }, ref);
    if (signal.aborted) return undefined;
    await this.gateway.tagOp(tagOp(tag, animation, existing !== undefined), ref);
    this.unfinished.delete(info.id);
    return { animation, tag, prepared: true, resumed: resuming };
  }

  // Everything an earlier attempt set up is still there: frames and the tag over all of them.
  private isComplete(info: SpriteInfo, animation: AnimationOptions, existing?: { from: number; to: number }): boolean {
    return info.frames.length === animation.frames && existing?.from === 1 && existing.to === animation.frames;
  }

  // The frame count must still match, or the user changed the sprite since and it is theirs again.
  private isUnfinished(info: SpriteInfo, animation: AnimationOptions, tag: string): boolean {
    const entry = this.unfinished.get(info.id);
    return entry?.tag === tag && entry.frames === animation.frames && info.frames.length === animation.frames;
  }
}

function tagOp(name: string, animation: AnimationOptions, exists: boolean): TagOp {
  const range = { from: 1, to: animation.frames, direction: "forward" as const, repeats: animation.loop ? 0 : 1 };
  // A tag of that name may already cover the single original frame; stretch it instead of adding a twin.
  return exists ? { op: "update", name, ...range } : { op: "add", name, ...range };
}
