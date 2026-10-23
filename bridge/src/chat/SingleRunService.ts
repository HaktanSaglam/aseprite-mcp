import type { IAsepriteGateway, ISpriteCloser, SpriteInfo } from "../aseprite/AsepriteGateway.js";
import type { ISpriteWatcher } from "../aseprite/SpriteActivity.js";
import type { LlmImage } from "../llm/LlmRunner.js";
import { activeSpriteInfo } from "./activeSprite.js";
import { AnimationSetup } from "./AnimationSetup.js";
import { continuePrompt, inbetweenPrompt, type ContinuePlan, type InbetweenPlan } from "./animationPrompts.js";
import {
  captureCanvas,
  describeCanvas,
  framesPreview,
  freshSnapshot,
  type CanvasSnapshot,
  type PreviewMode,
} from "./canvasContext.js";
import {
  ANIMATION_DEFAULTS,
  animationMode,
  DEFAULT_SPRITE_SIZE,
  type AnimationOptions,
  type ChatAction,
  type ChatSendRequest,
} from "./chatSchema.js";
import { UserFacingError, type IChatRequestHandler, type RequestOutcome, type RequestRun } from "./chatUpdates.js";
import { DirectionalAnimator, type RunExtras } from "./DirectionalAnimator.js";
import { subjectName } from "./GenerationService.js";
import { prepareContinuation, prepareInbetweens } from "./keyframeSetup.js";
import { PaletteEnforcer } from "./paletteLimits.js";
import { carryOverPalette } from "./paletteCarryOver.js";
import {
  animatePrompt,
  chatPrompt,
  CHAT_SYSTEM_PROMPT,
  editSelectionPrompt,
  generatePrompt,
  reviewPrompt,
  type AnimationPlan,
  type PromptContext,
} from "./promptBuilder.js";
import { closeIfEmpty, enforceColorRules } from "./runAftercare.js";
import { executeRun } from "./RunExecutor.js";
import type { SessionStore } from "./SessionStore.js";
import { loadStyleReference } from "./styleReference.js";

type SingleRunGateway = Pick<
  IAsepriteGateway,
  "getSpriteInfo" | "createSprite" | "readImage" | "writeImages" | "getPalette" | "setPalette" | "frameOp" | "tagOp"
> &
  ISpriteCloser;

export interface SingleRunDeps {
  gateway: SingleRunGateway;
  mcpUrls: { unscoped: string; forSprite: (sprite: number) => string };
  sessions: SessionStore;
  /** Counts the run's undo steps and the cels it drew. */
  activity: ISpriteWatcher;
}

/** Edits must see the art they change; for a free-form chat a picture only helps when there is art. */
const PREVIEW_BY_ACTION: Partial<Record<ChatAction, PreviewMode>> = {
  chat: "if_content",
  generate: "if_content",
  edit_selection: "always",
  review: "always",
  animate: "always",
};

/** Previews of more frames than this show too little of each. */
const MAX_PREVIEW_FRAMES = 8;

interface Target {
  info: SpriteInfo;
  fresh: boolean;
}

/** The frames the bridge prepared for an animate run, by mode. */
type PreparedAnimation =
  | { mode: "new"; plan: AnimationPlan }
  | { mode: "between"; plan: InbetweenPlan }
  | { mode: "continue"; plan: ContinuePlan };

/**
 * chat / generate / edit_selection / review / animate: one model run bound to one sprite.
 * The bridge does the cheap, deterministic setup itself (create the sprite, describe the
 * canvas, attach a preview, add animation frames) so the model starts drawing at once,
 * and the bookkeeping around it: the run's undo steps, the color rules afterwards, and
 * closing a sprite it created when the run came to nothing.
 */
export class SingleRunService implements IChatRequestHandler {
  private readonly animationSetup: AnimationSetup;
  private readonly directional: DirectionalAnimator;
  private readonly enforcer: PaletteEnforcer;

  constructor(private readonly deps: SingleRunDeps) {
    this.animationSetup = new AnimationSetup(deps.gateway);
    this.directional = new DirectionalAnimator({ gateway: deps.gateway, mcpUrlFor: deps.mcpUrls.forSprite, sessions: deps.sessions });
    this.enforcer = new PaletteEnforcer(deps.gateway);
  }

  async execute(request: ChatSendRequest, run: RequestRun): Promise<RequestOutcome> {
    // Read before anything is created, so a closed reference fails without leaving a tab.
    const extras = await this.extras(request, run);
    const target = await this.resolveTarget(request, run.signal);
    if (!target) return this.runUnbound(request, run, extras);

    const { info } = target;
    run.claimSprite?.(info.id);
    const watch = this.deps.activity.watch(info.id);
    let outcome: RequestOutcome = { ok: false };
    try {
      outcome = await this.draw(request, run, target, extras);
      if (outcome.ok && !run.signal.aborted) {
        await enforceColorRules(this.enforcer, info.id, watch.drawnCels, request.options, run.sink);
      }
    } finally {
      watch.close();
      if (target.fresh && !outcome.ok) await closeIfEmpty(this.deps.gateway, info.id);
    }
    // A sprite this run created is simply closed to get rid of it.
    return target.fresh ? outcome : { ...outcome, undo: { sprite: info.id, steps: watch.undoSteps } };
  }

  private async draw(request: ChatSendRequest, run: RequestRun, target: Target, extras: RunExtras): Promise<RequestOutcome> {
    const { info } = target;
    if (request.action === "animate" && request.options.animation?.allDirections) {
      return this.directional.run(request, run, info, extras);
    }

    let animation: PreparedAnimation | undefined;
    if (request.action === "animate") {
      animation = await this.prepareAnimation(request, info, run.signal);
      if (!animation) return { ok: false };
    }
    const sees = run.provider.info.supportsImages;
    // In-betweens and continuations look at specific frames instead of the first ones.
    const keyFrames = animation && animation.mode !== "new" ? keyFramesOf(animation) : undefined;
    const snapshot = target.fresh
      ? freshSnapshot(info)
      : await captureCanvas(this.deps.gateway, info.id, {
          preview: sees && !keyFrames ? (PREVIEW_BY_ACTION[request.action] ?? "never") : "never",
          allFrames: request.action === "animate" || request.action === "review",
          palette: request.options.palette === "current",
        });
    const keyImage = sees && keyFrames ? await framesPreview(this.deps.gateway, info.id, keyFrames) : undefined;

    const prompt = this.buildPrompt(request, snapshot, target.fresh, extras.reference, animation, keyImage !== undefined);
    const images = [snapshot.preview?.image, keyImage, ...extras.images].filter((i): i is LlmImage => i !== undefined);
    const providerId = run.provider.info.id;
    const outcome = await executeRun(
      run.provider,
      {
        prompt,
        systemPrompt: CHAT_SYSTEM_PROMPT,
        mcpUrl: this.deps.mcpUrls.forSprite(info.id),
        images: images.length ? images : undefined,
        sessionId: this.deps.sessions.get(providerId, info.id),
      },
      run.sink,
      run.signal,
    );
    if (outcome.sessionId) this.deps.sessions.set(providerId, info.id, outcome.sessionId);
    if (outcome.error) run.sink({ kind: "error", text: outcome.error });
    return { ok: outcome.ok, turns: outcome.turns, costUsd: outcome.costUsd };
  }

  /** The style reference (options.reference), read once per request. */
  private async extras(request: ChatSendRequest, run: RequestRun): Promise<RunExtras> {
    const reference = request.options.reference;
    if (!reference) return { images: [] };
    const loaded = await loadStyleReference(this.deps.gateway, reference, run.provider.info.supportsImages);
    return { reference: loaded.text, images: loaded.image ? [loaded.image] : [] };
  }

  /** undefined = nothing is open and the action can work without a sprite (plain chat). */
  private async resolveTarget(request: ChatSendRequest, signal: AbortSignal): Promise<Target | undefined> {
    const { gateway } = this.deps;
    const wantsNewSprite = request.action === "generate" && (request.options.target ?? "new_sprite") === "new_sprite";
    if (wantsNewSprite) return { info: await this.createSprite(request, signal), fresh: true };

    if (request.sprite !== undefined) return { info: await gateway.getSpriteInfo({ sprite: request.sprite }), fresh: false };

    const active = await activeSpriteInfo(gateway);
    if (active) return { info: active, fresh: false };
    if (request.action === "chat") return undefined;
    if (request.action === "generate") return { info: await this.createSprite(request, signal), fresh: true };
    throw new UserFacingError("Open or create a sprite first.");
  }

  private async createSprite(request: ChatSendRequest, signal: AbortSignal): Promise<SpriteInfo> {
    // A tab opened after Stop would be an unexplained leftover; ChatService reports the abort as "Stopped.".
    signal.throwIfAborted();
    const size = request.options.size ?? DEFAULT_SPRITE_SIZE;
    const info = await this.deps.gateway.createSprite({
      width: size.width,
      height: size.height,
      colorMode: "rgb",
      name: subjectName(request.text),
    });
    try {
      await carryOverPalette(this.deps.gateway, request, [info.id]);
    } catch (error) {
      await closeIfEmpty(this.deps.gateway, info.id);
      throw error;
    }
    return info;
  }

  /**
   * new: a single-frame sprite gets its frames, durations and tag from the bridge (three
   * deterministic calls the model would otherwise spend a turn each on). between and
   * continue: the bridge inserts the frames to draw. undefined = Stop.
   */
  private async prepareAnimation(request: ChatSendRequest, info: SpriteInfo, signal: AbortSignal): Promise<PreparedAnimation | undefined> {
    const animation: AnimationOptions = request.options.animation ?? { preset: "custom", ...ANIMATION_DEFAULTS.custom };
    switch (animationMode(animation)) {
      case "between": {
        const plan = await prepareInbetweens(this.deps.gateway, info, animation, signal);
        return plan && { mode: "between", plan };
      }
      case "continue": {
        const plan = await prepareContinuation(this.deps.gateway, info, animation, signal);
        return plan && { mode: "continue", plan };
      }
      case "new": {
        const tag = animation.preset === "custom" ? "animation" : animation.preset;
        const plan = await this.animationSetup.prepare(info, animation, tag, signal);
        return plan && { mode: "new", plan };
      }
    }
  }

  private buildPrompt(
    request: ChatSendRequest,
    snapshot: CanvasSnapshot,
    fresh: boolean,
    reference: string | undefined,
    animation?: PreparedAnimation,
    keyImageAttached = false,
  ): string {
    const ctx: PromptContext = {
      text: request.text,
      options: request.options,
      info: snapshot.info,
      canvas: describeCanvas(snapshot),
      selection: request.selection ?? snapshot.info.selection,
      freshSprite: fresh,
      hasContent: snapshot.content ? !snapshot.content.isEmpty : true,
      reference,
    };
    switch (request.action) {
      case "generate":
        return generatePrompt(ctx);
      case "edit_selection": {
        const selection = ctx.selection;
        if (!selection) throw new UserFacingError("Select an area first (Rectangular Marquee tool, M), then try again.");
        return editSelectionPrompt({ ...ctx, selection });
      }
      case "review":
        if (snapshot.content?.isEmpty) throw new UserFacingError("The sprite is empty: there is nothing to review yet.");
        return reviewPrompt(ctx);
      case "animate":
        if (!animation) throw new Error("animate needs an animation plan");
        if (animation.mode === "between") return inbetweenPrompt(ctx, animation.plan, keyImageAttached);
        if (animation.mode === "continue") return continuePrompt(ctx, animation.plan, keyImageAttached);
        return animatePrompt(ctx, animation.plan);
      default:
        // A selection only matters for chat when the user chose "use selection" (it arrives in the request).
        return chatPrompt({ ...ctx, selection: request.selection });
    }
  }

  /** Nothing open: the model may create a sprite through the unscoped endpoint. */
  private async runUnbound(request: ChatSendRequest, run: RequestRun, extras: RunExtras): Promise<RequestOutcome> {
    const providerId = run.provider.info.id;
    const outcome = await executeRun(
      run.provider,
      {
        prompt: chatPrompt({ text: request.text, options: request.options, reference: extras.reference }),
        systemPrompt: CHAT_SYSTEM_PROMPT,
        mcpUrl: this.deps.mcpUrls.unscoped,
        images: extras.images.length ? extras.images : undefined,
        sessionId: this.deps.sessions.get(providerId, undefined),
      },
      run.sink,
      run.signal,
    );
    if (outcome.sessionId) {
      // The conversation belongs to the sprite it created, so follow-ups on that tab continue it.
      const created = await this.deps.gateway.getSpriteInfo().catch(() => undefined);
      this.deps.sessions.set(providerId, created?.id, outcome.sessionId);
    }
    if (outcome.error) run.sink({ kind: "error", text: outcome.error });
    return { ok: outcome.ok, turns: outcome.turns, costUsd: outcome.costUsd };
  }
}

/** The frames an in-between or continuation run is shown: both keys, or the last kept frames. */
function keyFramesOf(animation: Exclude<PreparedAnimation, { mode: "new" }>): number[] {
  if (animation.mode === "between") return [animation.plan.keyA, animation.plan.keyB];
  const { keep } = animation.plan;
  const first = Math.max(1, keep - MAX_PREVIEW_FRAMES + 1);
  return Array.from({ length: keep - first + 1 }, (_, i) => first + i);
}
