import type { IAsepriteGateway, SpriteInfo } from "../aseprite/AsepriteGateway.js";
import type { LlmImage } from "../llm/LlmRunner.js";
import {
  directionAnimationPrompt,
  mirroredAnimationFixPrompt,
  type DirectionRun,
  type MirroredAnimation,
} from "./animationPrompts.js";
import { captureCanvas, describeCanvas, framesPreview } from "./canvasContext.js";
import type { AnimationOptions, ChatSendRequest } from "./chatSchema.js";
import { UserFacingError, type RequestOutcome, type RequestRun } from "./chatUpdates.js";
import { byDirectionOrder, isDirection, mirrorPairs, type Direction, type MirrorPair } from "./directions.js";
import { CHAT_SYSTEM_PROMPT, type PromptContext } from "./promptBuilder.js";
import { executeRun, type JobOutcome } from "./RunExecutor.js";
import type { SessionStore } from "./SessionStore.js";

type DirectionalGateway = Pick<IAsepriteGateway, "getSpriteInfo" | "readImage" | "getPalette" | "frameOp" | "tagOp">;

export interface DirectionalDeps {
  gateway: DirectionalGateway;
  mcpUrlFor: (sprite: number) => string;
  sessions: SessionStore;
}

/** What the caller adds to every run of the request (a style reference). */
export interface RunExtras {
  reference?: string;
  images: LlmImage[];
}

interface Pose {
  direction: Direction;
  /** The frame of the direction's tag: the pose its animation starts from. */
  frame: number;
}

interface Span {
  first: number;
  last: number;
}

/** One allDirections request while it runs. */
interface RequestState {
  request: ChatSendRequest;
  run: RequestRun;
  extras: RunExtras;
  sprite: number;
  animation: AnimationOptions;
  /** The conversation every run continues, so later directions remember the first one. */
  session?: string;
  /** The first direction's finished frames, shown to every later run (read once). */
  modelStrip?: LlmImage;
  turns: number;
  costs: number[];
}

const NO_DIRECTIONS =
  'This sprite has no direction tags (down, right, up, left, ...). Draw the character with "4 directions" or ' +
  '"8 directions" first, or turn off "All directions".';

/** The directions a "directions" request tagged on this sprite, in drawing order (down first). */
export function directionPoses(info: SpriteInfo): Pose[] {
  const poses = new Map<Direction, Pose>();
  for (const tag of info.tags) {
    if (isDirection(tag.name) && !poses.has(tag.name)) poses.set(tag.name, { direction: tag.name, frame: tag.from });
  }
  return [...poses.values()].sort((a, b) => byDirectionOrder(a.direction, b.direction));
}

/** "walk" + "down" → "walk_down"; custom animations are called "animation" like a single one. */
export function directionTag(animation: AnimationOptions, direction: string): string {
  return `${animation.preset === "custom" ? "animation" : animation.preset}_${direction}`;
}

/**
 * animation.allDirections: animates every direction of a "directions" sprite one after
 * another into the same sprite (parallel writers would interleave its undo steps). The
 * first direction (down) sets the motion; each later run sees it and matches it; left-
 * facing directions are mirrored by the bridge and fixed in one last run. Frames are
 * appended per direction and tagged "<preset>_<direction>". The bridge prepares each
 * direction in one go (Stop is honoured between directions and runs), and directions
 * finished in this session are skipped, so pressing the button again after Stop or a
 * failure continues where it ended.
 */
export class DirectionalAnimator {
  /**
   * Tags each sprite finished in this bridge session, with their frame range: a tag
   * that moved since (frames added or deleted by hand, or another sprite that got the
   * same id after Aseprite restarted) is not taken for finished.
   */
  private readonly finished = new Map<number, Map<string, string>>();

  constructor(private readonly deps: DirectionalDeps) {}

  async run(request: ChatSendRequest, run: RequestRun, info: SpriteInfo, extras: RunExtras): Promise<RequestOutcome> {
    const animation = request.options.animation;
    if (!animation) throw new Error("allDirections needs animation options");
    const poses = directionPoses(info);
    if (poses.length === 0) throw new UserFacingError(NO_DIRECTIONS);
    // Checked before anything changes, so a mismatch never leaves half the directions done.
    for (const pose of poses) {
      const tag = directionTag(animation, pose.direction);
      const existing = info.tags.find((t) => t.name === tag);
      if (existing && existing.to - existing.from + 1 !== animation.frames) {
        throw new UserFacingError(
          `The tag "${tag}" already has ${existing.to - existing.from + 1} frames: delete it, or animate with that many frames.`,
        );
      }
    }

    const providerId = run.provider.info.id;
    const state: RequestState = {
      request,
      run,
      extras,
      sprite: info.id,
      animation,
      session: this.deps.sessions.get(providerId, info.id),
      turns: 0,
      costs: [],
    };
    try {
      return await this.animateAll(state, poses);
    } finally {
      if (state.session) this.deps.sessions.set(providerId, state.sprite, state.session);
    }
  }

  private async animateAll(state: RequestState, poses: Pose[]): Promise<RequestOutcome> {
    const { run, sprite, animation } = state;
    const order = poses.map((p) => p.direction);
    const mirrors = mirrorPairs(order);
    const mirrorSource = new Map<string, Direction>(mirrors.map((m) => [m.to, m.from]));
    const spans = new Map<Direction, Span>();
    const mirrored: MirroredAnimation[] = [];
    let model: DirectionRun["model"];
    let done = 0;
    let worked = false;

    run.sink({ kind: "status", text: describePlan(order, mirrors) });
    run.sink({ kind: "progress", done: 0, total: poses.length });
    for (const pose of poses) {
      if (run.signal.aborted) return this.outcome(state, done > 0);
      const tag = directionTag(animation, pose.direction);
      const current = await this.deps.gateway.getSpriteInfo({ sprite });
      const existing = current.tags.find((t) => t.name === tag);
      const source = mirrorSource.get(pose.direction);
      // Mirrored directions get empty frames (the mirror fills them), the others copies of their pose.
      const span = existing
        ? { first: existing.from, last: existing.to }
        : await this.appendFrames(current, animation, source ? undefined : pose.frame);
      const finished = existing !== undefined && this.isFinished(sprite, tag, span);
      if (!finished) worked = true;

      if (source && !finished) {
        await this.mirror(sprite, spans.get(source) as Span, span);
        if (!existing) await this.addTag(sprite, tag, span, animation);
        mirrored.push({ fromTag: directionTag(animation, source), tag, direction: pose.direction, pose: pose.frame, ...span });
      } else if (!source && !finished) {
        if (!existing) await this.addTag(sprite, tag, span, animation);
        if (run.signal.aborted) return this.outcome(state, done > 0);
        const outcome = await this.animateDirection(state, {
          animation,
          direction: pose.direction,
          tag,
          ...span,
          pose: pose.frame,
          resumed: existing !== undefined,
          order,
          mirrored: mirrors,
          model,
          imagesAttached: run.provider.info.supportsImages,
        });
        if (!outcome.ok) return this.stopped(state, outcome, done, poses.length);
        this.markFinished(sprite, tag, span);
      }

      spans.set(pose.direction, span);
      if (!source) model ??= { tag, ...span };
      done++;
      run.sink({ kind: "progress", done, total: poses.length, label: pose.direction });
    }

    if (mirrored.length > 0 && !run.signal.aborted) {
      const outcome = await this.fixMirrored(state, mirrored);
      if (outcome.ok) for (const m of mirrored) this.markFinished(sprite, m.tag, { first: m.first, last: m.last });
      else if (outcome.error) run.sink({ kind: "error", text: outcome.error });
    }
    if (!worked) {
      const tags = poses.map((p) => directionTag(animation, p.direction)).join(", ");
      run.sink({ kind: "status", text: `Every direction is already animated (${tags}). Delete a tag to animate it again.` });
    }
    return this.outcome(state, true);
  }

  // A failed or stopped direction ends the request; finished directions stay finished.
  private stopped(state: RequestState, outcome: JobOutcome, done: number, total: number): RequestOutcome {
    if (outcome.error) state.run.sink({ kind: "error", text: outcome.error });
    if (done > 0 && !outcome.aborted) {
      state.run.sink({ kind: "status", text: `${done} of ${total} directions animated. Press again to finish the rest.` });
    }
    return this.outcome(state, done > 0);
  }

  private async animateDirection(state: RequestState, plan: DirectionRun): Promise<JobOutcome> {
    const { gateway } = this.deps;
    const images: LlmImage[] = [];
    if (plan.imagesAttached) {
      if (plan.model) images.push((state.modelStrip ??= await this.strip(state.sprite, plan.model)));
      images.push(await framesPreview(gateway, state.sprite, [plan.pose]));
    }
    const ctx = await this.context(state);
    return this.execute(state, directionAnimationPrompt(ctx, plan), images, plan.direction);
  }

  private async fixMirrored(state: RequestState, mirrored: MirroredAnimation[]): Promise<JobOutcome> {
    const sees = state.run.provider.info.supportsImages;
    const strips: LlmImage[] = [];
    if (sees) for (const m of mirrored) strips.push(await this.strip(state.sprite, m));
    state.run.sink({ kind: "status", text: `Fixing the mirrored details of ${mirrored.map((m) => m.tag).join(", ")}.` });
    const ctx = await this.context(state);
    return this.execute(state, mirroredAnimationFixPrompt(ctx, mirrored, sees), strips, "mirrored");
  }

  private async execute(state: RequestState, prompt: string, images: LlmImage[], label: string): Promise<JobOutcome> {
    const outcome = await executeRun(
      state.run.provider,
      {
        prompt,
        systemPrompt: CHAT_SYSTEM_PROMPT,
        mcpUrl: this.deps.mcpUrlFor(state.sprite),
        images: [...images, ...state.extras.images],
        sessionId: state.session,
      },
      state.run.sink,
      state.run.signal,
      { label },
    );
    state.session = outcome.sessionId ?? state.session;
    state.turns += outcome.turns ?? 0;
    if (outcome.costUsd !== undefined) state.costs.push(outcome.costUsd);
    return outcome;
  }

  private async context(state: RequestState): Promise<PromptContext> {
    const { request } = state;
    const snapshot = await captureCanvas(this.deps.gateway, state.sprite, {
      preview: "never",
      palette: request.options.palette === "current",
    });
    return {
      text: request.text,
      options: request.options,
      info: snapshot.info,
      canvas: describeCanvas(snapshot),
      hasContent: true,
      reference: state.extras.reference,
    };
  }

  private outcome(state: RequestState, ok: boolean): RequestOutcome {
    return {
      ok,
      turns: state.turns || undefined,
      costUsd: state.costs.length ? state.costs.reduce((a, b) => a + b, 0) : undefined,
    };
  }

  /**
   * Appends this direction's frames, as copies of `pose` when given (one copy_cel, then
   * frame_op add duplicates it: a few steps whatever the frame count). Aseprite stretches
   * a tag that ends on the frame new frames go after, but these frames belong to no tag
   * yet, so it is put back.
   */
  private async appendFrames(info: SpriteInfo, animation: AnimationOptions, pose?: number): Promise<Span> {
    const { gateway } = this.deps;
    const ref = { sprite: info.id };
    const last = info.frames.length;
    const span = { first: last + 1, last: last + animation.frames };
    const durationMs = animation.frameMs;
    await gateway.frameOp({ op: "add", after: last, count: pose === undefined ? animation.frames : 1, durationMs }, ref);
    for (const tag of info.tags) if (tag.to === last) await gateway.tagOp({ op: "update", name: tag.name, to: last }, ref);
    if (pose === undefined) return span;
    await gateway.frameOp({ op: "copy_cel", from: pose, to: span.first }, ref);
    if (animation.frames > 1) {
      await gateway.frameOp({ op: "add", after: span.first, count: animation.frames - 1, copy: true, durationMs }, ref);
    }
    return span;
  }

  private async mirror(sprite: number, source: Span, span: Span): Promise<void> {
    for (let i = 0; i <= span.last - span.first; i++) {
      await this.deps.gateway.frameOp({ op: "copy_cel", from: source.first + i, to: span.first + i, flip: "horizontal" }, { sprite });
    }
  }

  private async addTag(sprite: number, name: string, span: Span, animation: AnimationOptions): Promise<void> {
    await this.deps.gateway.tagOp(
      { op: "add", name, from: span.first, to: span.last, direction: "forward", repeats: animation.loop ? 0 : 1 },
      { sprite },
    );
  }

  private strip(sprite: number, span: Span): Promise<LlmImage> {
    const frames = Array.from({ length: span.last - span.first + 1 }, (_, i) => span.first + i);
    return framesPreview(this.deps.gateway, sprite, frames);
  }

  private isFinished(sprite: number, tag: string, span: Span): boolean {
    return this.finished.get(sprite)?.get(tag) === `${span.first}-${span.last}`;
  }

  private markFinished(sprite: number, tag: string, span: Span): void {
    let tags = this.finished.get(sprite);
    if (!tags) this.finished.set(sprite, (tags = new Map()));
    tags.set(tag, `${span.first}-${span.last}`);
  }
}

function describePlan(order: readonly string[], mirrors: readonly MirrorPair[]): string {
  const mirrored = new Set<string>(mirrors.map((m) => m.to));
  const drawn = order.filter((d) => !mirrored.has(d));
  const mirrorText = mirrors.length ? `; ${mirrors.map((m) => `${m.to} is mirrored from ${m.from}`).join(", ")}` : "";
  return `Animating ${order.length} directions one after another: ${drawn.join(", ")}${mirrorText}.`;
}
