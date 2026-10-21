import type { IAsepriteGateway, SpriteInfo } from "../aseprite/AsepriteGateway.js";
import { captureCanvas, describeCanvas, freshSnapshot, type CanvasSnapshot, type PreviewMode } from "./canvasContext.js";
import { ANIMATION_DEFAULTS, DEFAULT_SPRITE_SIZE, type ChatAction, type ChatSendRequest } from "./chatSchema.js";
import { UserFacingError, type IChatRequestHandler, type RequestOutcome, type RequestRun } from "./chatUpdates.js";
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
import { executeRun } from "./RunExecutor.js";
import type { SessionStore } from "./SessionStore.js";

type SingleRunGateway = Pick<
  IAsepriteGateway,
  "getSpriteInfo" | "createSprite" | "readImage" | "getPalette" | "frameOp" | "tagOp"
>;

export interface SingleRunDeps {
  gateway: SingleRunGateway;
  mcpUrls: { unscoped: string; forSprite: (sprite: number) => string };
  sessions: SessionStore;
}

/** Edits must see the art they change; for a free-form chat a picture only helps when there is art. */
const PREVIEW_BY_ACTION: Partial<Record<ChatAction, PreviewMode>> = {
  chat: "if_content",
  generate: "if_content",
  edit_selection: "always",
  review: "always",
  animate: "always",
};

interface Target {
  info: SpriteInfo;
  fresh: boolean;
}

/**
 * chat / generate / edit_selection / review / animate: one model run bound to one sprite.
 * The bridge does the cheap, deterministic setup itself (create the sprite, describe the
 * canvas, attach a preview, add animation frames) so the model starts drawing at once.
 */
export class SingleRunService implements IChatRequestHandler {
  constructor(private readonly deps: SingleRunDeps) {}

  async execute(request: ChatSendRequest, run: RequestRun): Promise<RequestOutcome> {
    const target = await this.resolveTarget(request);
    if (!target) return this.runUnbound(request, run);

    const { info } = target;
    const plan = request.action === "animate" ? await this.prepareAnimation(request, info) : undefined;
    const snapshot = target.fresh
      ? freshSnapshot(info)
      : await captureCanvas(this.deps.gateway, info.id, {
          preview: run.provider.info.supportsImages ? (PREVIEW_BY_ACTION[request.action] ?? "never") : "never",
          allFrames: request.action === "animate" || request.action === "review",
          palette: request.options.palette === "current",
        });

    const prompt = this.buildPrompt(request, snapshot, target.fresh, plan);
    const providerId = run.provider.info.id;
    const outcome = await executeRun(
      run.provider,
      {
        prompt,
        systemPrompt: CHAT_SYSTEM_PROMPT,
        mcpUrl: this.deps.mcpUrls.forSprite(info.id),
        images: snapshot.preview ? [snapshot.preview.image] : undefined,
        sessionId: this.deps.sessions.get(providerId, info.id),
      },
      run.sink,
      run.signal,
    );
    if (outcome.sessionId) this.deps.sessions.set(providerId, info.id, outcome.sessionId);
    if (outcome.error) run.sink({ kind: "error", text: outcome.error });
    return { ok: outcome.ok, turns: outcome.turns, costUsd: outcome.costUsd };
  }

  /** undefined = nothing is open and the action can work without a sprite (plain chat). */
  private async resolveTarget(request: ChatSendRequest): Promise<Target | undefined> {
    const { gateway } = this.deps;
    const wantsNewSprite = request.action === "generate" && (request.options.target ?? "new_sprite") === "new_sprite";
    if (wantsNewSprite) return { info: await this.createSprite(request), fresh: true };

    if (request.sprite !== undefined) return { info: await gateway.getSpriteInfo({ sprite: request.sprite }), fresh: false };

    const active = await gateway.getSpriteInfo().catch(() => undefined);
    if (active) return { info: active, fresh: false };
    if (request.action === "chat") return undefined;
    if (request.action === "generate") return { info: await this.createSprite(request), fresh: true };
    throw new UserFacingError("Open or create a sprite first.");
  }

  private createSprite(request: ChatSendRequest): Promise<SpriteInfo> {
    const size = request.options.size ?? DEFAULT_SPRITE_SIZE;
    return this.deps.gateway.createSprite({ width: size.width, height: size.height, colorMode: "rgb" });
  }

  /**
   * A single-frame sprite gets its frames, durations and tag from the bridge: three
   * deterministic calls the model would otherwise spend a turn each on.
   */
  private async prepareAnimation(request: ChatSendRequest, info: SpriteInfo): Promise<AnimationPlan> {
    const animation = request.options.animation ?? { preset: "custom" as const, ...ANIMATION_DEFAULTS.custom };
    const tag = animation.preset === "custom" ? "animation" : animation.preset;
    if (info.frames.length !== 1) return { animation, tag, prepared: false };

    const { gateway } = this.deps;
    const ref = { sprite: info.id };
    await gateway.frameOp({ op: "add", after: 1, count: animation.frames - 1, copy: true }, ref);
    await gateway.frameOp({ op: "duration", durationMs: animation.frameMs }, ref);
    await gateway.tagOp(
      { op: "add", name: tag, from: 1, to: animation.frames, direction: "forward", repeats: animation.loop ? 0 : 1 },
      ref,
    );
    return { animation, tag, prepared: true };
  }

  private buildPrompt(request: ChatSendRequest, snapshot: CanvasSnapshot, fresh: boolean, plan?: AnimationPlan): string {
    const ctx: PromptContext = {
      text: request.text,
      options: request.options,
      info: snapshot.info,
      canvas: describeCanvas(snapshot),
      selection: request.selection ?? snapshot.info.selection,
      freshSprite: fresh,
      hasContent: snapshot.content ? !snapshot.content.isEmpty : true,
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
        if (!plan) throw new Error("animate needs an animation plan");
        return animatePrompt(ctx, plan);
      default:
        // A selection only matters for chat when the user chose "use selection" (it arrives in the request).
        return chatPrompt({ ...ctx, selection: request.selection });
    }
  }

  /** Nothing open: the model may create a sprite through the unscoped endpoint. */
  private async runUnbound(request: ChatSendRequest, run: RequestRun): Promise<RequestOutcome> {
    const providerId = run.provider.info.id;
    const outcome = await executeRun(
      run.provider,
      {
        prompt: chatPrompt({ text: request.text, options: request.options }),
        systemPrompt: CHAT_SYSTEM_PROMPT,
        mcpUrl: this.deps.mcpUrls.unscoped,
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
