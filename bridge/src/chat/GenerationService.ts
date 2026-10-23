import { basename, extname } from "node:path";
import type { IAsepriteGateway, ISpriteCloser, SpriteInfo } from "../aseprite/AsepriteGateway.js";
import type { ISpriteWatcher } from "../aseprite/SpriteActivity.js";
import type { LlmImage } from "../llm/LlmRunner.js";
import type { RgbaImage } from "../pixel/RgbaImage.js";
import { activeSpriteInfo } from "./activeSprite.js";
import { captureCanvas, describeCanvas, freshSnapshot, type CanvasSnapshot } from "./canvasContext.js";
import {
  batchItems,
  DEFAULT_SPRITE_SIZE,
  DEFAULT_VARIATIONS,
  startsFromCurrent,
  type ChatOptions,
  type ChatSendRequest,
} from "./chatSchema.js";
import { UserFacingError, type IChatRequestHandler, type RequestOutcome, type RequestRun } from "./chatUpdates.js";
import { mapLimit } from "./concurrency.js";
import { DIRECTION_ORDER, mirrorPairs } from "./directions.js";
import { PaletteEnforcer } from "./paletteLimits.js";
import {
  batchItemPrompt,
  CHAT_SYSTEM_PROMPT,
  directionsPrompt,
  mirrorFixPrompt,
  variationPrompt,
  type DirectionsPlan,
  type PromptContext,
} from "./promptBuilder.js";
import { carryOverPalette } from "./paletteCarryOver.js";
import { closeIfEmpty, enforceColorRules } from "./runAftercare.js";
import { executeRun, type JobOutcome } from "./RunExecutor.js";
import type { SessionStore } from "./SessionStore.js";
import { STYLE_SPECS } from "./styleSpecs.js";
import { loadStyleReference, type LoadedReference } from "./styleReference.js";

type GenerationGateway = Pick<
  IAsepriteGateway,
  "createSprite" | "tagOp" | "frameOp" | "getSpriteInfo" | "readImage" | "writeImages" | "getPalette" | "setPalette"
> &
  ISpriteCloser;

export interface GenerationDeps {
  gateway: GenerationGateway;
  mcpUrlFor: (sprite: number) => string;
  sessions: SessionStore;
  maxParallelRuns: number;
  /** Tells which cels each job drew, for the color rules afterwards. */
  activity: ISpriteWatcher;
}

interface Job {
  info: SpriteInfo;
  label: string;
  prompt: string;
  images?: LlmImage[];
}

/** The open sprite variations are made of, as the model sees it. */
interface VariedSprite {
  info: SpriteInfo;
  preview: LlmImage;
}

/** directions from the current sprite: frame 1 (visible layers) is the design facing down. */
interface SourceDesign {
  info: SpriteInfo;
  image: RgbaImage;
}

const tabName = (info: SpriteInfo) => basename(info.filename) || `sprite #${info.id}`;
const tabStem = (info: SpriteInfo) => basename(info.filename, extname(info.filename)) || "Sprite";

/** A short tab title from the request ("a cute green slime monster" → "cute green slime"). */
export function subjectName(text: string, fallback = "AI sprite"): string {
  const words = text
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !/^(a|an|the|bir)$/i.test(w));
  let name = "";
  for (const word of words) {
    if ((name + " " + word).trim().length > 24) break;
    name = (name + " " + word).trim();
  }
  return name || fallback;
}

/**
 * variations / batch / directions: the bridge creates the sprites up front and runs one
 * model job per sprite, each bound to its own sprite through a scoped MCP endpoint, so
 * jobs run in parallel without ever drawing into each other's canvas. A sprite whose job
 * failed or was stopped is closed again if nothing was drawn in it.
 */
export class GenerationService implements IChatRequestHandler {
  private readonly enforcer: PaletteEnforcer;

  constructor(private readonly deps: GenerationDeps) {
    this.enforcer = new PaletteEnforcer(deps.gateway);
  }

  execute(request: ChatSendRequest, run: RequestRun): Promise<RequestOutcome> {
    switch (request.action) {
      case "variations":
        return this.variations(request, run);
      case "batch":
        return this.batch(request, run);
      case "directions":
        return this.directions(request, run);
      default:
        throw new Error(`GenerationService cannot handle "${request.action}"`);
    }
  }

  private async variations(request: ChatSendRequest, run: RequestRun): Promise<RequestOutcome> {
    const total = request.options.count ?? DEFAULT_VARIATIONS;
    // Without a description the open sprite is the subject; source "current" makes the text a direction for it.
    const subject = startsFromCurrent(request.options) || !request.text.trim() ? await this.variedSprite(request, run) : undefined;
    const style = await this.styleReference(request, run);
    const size = request.options.size ?? (subject ? { width: subject.info.width, height: subject.info.height } : DEFAULT_SPRITE_SIZE);
    const name = subjectName(request.text, "Sprite");
    const names = Array.from({ length: total }, (_, i) => `${name} (variation ${i + 1})`);
    const sprites = await this.createSprites(names, size, request, run);
    if (!sprites) return { ok: false };

    const images = [subject?.preview, style?.image].filter((i): i is LlmImage => i !== undefined);
    const jobs = sprites.map((info, i) => ({
      info,
      label: `Variation ${i + 1}`,
      prompt: variationPrompt(this.context(request.text, request.options, info, style), i + 1, total, subject !== undefined),
      images: images.length ? images : undefined,
    }));
    run.sink({ kind: "status", text: `Drawing ${total} variations in parallel, each in its own tab.` });
    return this.runParallel(jobs, request.options, run);
  }

  private async batch(request: ChatSendRequest, run: RequestRun): Promise<RequestOutcome> {
    const items = batchItems(request.options);
    if (items.length === 0) throw new UserFacingError("Add the items to draw (one per line) for a batch.");
    // Parallel jobs can't agree on a palette they each invent, so "auto" becomes one shared preset.
    const palette = request.options.palette;
    const options: ChatOptions = {
      ...request.options,
      palette: palette === undefined || palette === "auto" ? STYLE_SPECS[request.options.style ?? "auto"].setPalette : palette,
    };
    const style = await this.styleReference(request, run);
    const sprites = await this.createSprites(
      items.map((item) => subjectName(item)),
      request.options.size ?? DEFAULT_SPRITE_SIZE,
      request,
      run,
    );
    if (!sprites) return { ok: false };

    const jobs = sprites.map((info, i) => ({
      info,
      label: items[i],
      prompt: batchItemPrompt(this.context(request.text, options, info, style), items[i], i + 1, items.length),
      images: style?.image ? [style.image] : undefined,
    }));
    run.sink({ kind: "status", text: `Drawing ${items.length} items in parallel, each in its own tab.` });
    return this.runParallel(jobs, options, run);
  }

  /**
   * One model holds the design across directions, so this is one job, in two runs when
   * left-facing frames exist: the model draws the others, the bridge mirrors the right-
   * facing ones into the left-facing ones, then the model fixes what must not be mirrored.
   */
  private async directions(request: ChatSendRequest, run: RequestRun): Promise<RequestOutcome> {
    const order = DIRECTION_ORDER[request.options.directions ?? 4];
    const source = startsFromCurrent(request.options) ? await this.sourceDesign(request) : undefined;
    const style = await this.styleReference(request, run);
    // A copy of the user's frame must land 1:1, so it decides the size.
    const size = source ? { width: source.info.width, height: source.info.height } : (request.options.size ?? DEFAULT_SPRITE_SIZE);
    if (run.signal.aborted) return { ok: false };
    const created = await this.deps.gateway.createSprite({
      ...size,
      colorMode: "rgb",
      frames: order.length,
      // From the user's sprite the text is a note ("give him a cape"), not the subject.
      name: `${source ? tabStem(source.info) : subjectName(request.text)} (${order.length} directions)`,
    });
    run.claimSprite?.(created.id);
    const watch = this.deps.activity.watch(created.id);
    let outcome: RequestOutcome = { ok: false };
    try {
      const plan: DirectionsPlan = { directions: order, mirrors: mirrorPairs(order), fromCurrent: source !== undefined };
      outcome = await this.drawDirections(request, run, created, plan, source, style);
      if (outcome.ok && !run.signal.aborted) {
        await enforceColorRules(this.enforcer, created.id, watch.drawnCels, request.options, run.sink);
      }
    } finally {
      watch.close();
      if (!outcome.ok) await closeIfEmpty(this.deps.gateway, created.id);
    }
    return outcome;
  }

  private async drawDirections(
    request: ChatSendRequest,
    run: RequestRun,
    created: SpriteInfo,
    plan: DirectionsPlan,
    source: SourceDesign | undefined,
    style: LoadedReference | undefined,
  ): Promise<RequestOutcome> {
    const { gateway, sessions } = this.deps;
    const ref = { sprite: created.id };
    await carryOverPalette(gateway, request, [created.id]);
    for (const [i, direction] of plan.directions.entries()) {
      if (run.signal.aborted) return { ok: false };
      await gateway.tagOp({ op: "add", name: direction, from: i + 1, to: i + 1 }, ref);
    }
    if (source) {
      const layer = created.layers.find((l) => !l.isGroup)?.path ?? "Layer 1";
      await gateway.writeImages([{ x: 0, y: 0, image: source.image, frame: 1, layer }], ref);
    }
    const sees = run.provider.info.supportsImages;
    const snapshot = source
      ? await captureCanvas(gateway, created.id, { preview: sees ? "always" : "never", palette: request.options.palette === "current" })
      : freshSnapshot(await gateway.getSpriteInfo(ref));
    const info = snapshot.info;
    run.sink({
      kind: "status",
      text: source
        ? `Turning ${tabName(source.info)} into ${plan.directions.length} directions in ${tabName(info)}, one frame per direction.`
        : `Drawing ${plan.directions.length} directions into ${tabName(info)}, one frame per direction.`,
    });

    const providerId = run.provider.info.id;
    const ctx = this.directionsContext(request, snapshot, source !== undefined, style);
    const first = await executeRun(
      run.provider,
      {
        prompt: directionsPrompt(ctx, plan),
        systemPrompt: CHAT_SYSTEM_PROMPT,
        mcpUrl: this.deps.mcpUrlFor(info.id),
        images: imagesOf(snapshot.preview?.image, style?.image),
      },
      run.sink,
      run.signal,
    );
    if (first.sessionId) sessions.set(providerId, info.id, first.sessionId);
    if (first.error) run.sink({ kind: "error", text: first.error });
    if (!first.ok || plan.mirrors.length === 0 || run.signal.aborted) return statsOf([first], first.ok);

    for (const pair of plan.mirrors) {
      const from = plan.directions.indexOf(pair.from) + 1;
      const to = plan.directions.indexOf(pair.to) + 1;
      await gateway.frameOp({ op: "copy_cel", from, to, flip: "horizontal" }, ref);
    }
    const mirrored = await captureCanvas(gateway, info.id, { preview: sees ? "always" : "never", allFrames: true });
    const fix = await executeRun(
      run.provider,
      {
        prompt: mirrorFixPrompt(this.directionsContext(request, mirrored, true, style), plan, mirrored.preview !== undefined),
        systemPrompt: CHAT_SYSTEM_PROMPT,
        mcpUrl: this.deps.mcpUrlFor(info.id),
        images: imagesOf(mirrored.preview?.image),
        sessionId: first.sessionId,
      },
      run.sink,
      run.signal,
    );
    if (fix.sessionId) sessions.set(providerId, info.id, fix.sessionId);
    // The directions are drawn and mirrored either way; a failed touch-up is only reported.
    if (fix.error) run.sink({ kind: "error", text: `Fixing the mirrored frames failed: ${fix.error}` });
    return statsOf([first, fix], true);
  }

  private directionsContext(
    request: ChatSendRequest,
    snapshot: CanvasSnapshot,
    hasContent: boolean,
    style: LoadedReference | undefined,
  ): PromptContext {
    return {
      text: request.text,
      // The sprite is always the bridge's own, so the Generate tab's target doesn't apply.
      options: { ...request.options, target: undefined },
      info: snapshot.info,
      canvas: describeCanvas(snapshot),
      freshSprite: !hasContent,
      hasContent,
      reference: style?.text,
    };
  }

  /** variations of the open sprite: the model sees it as an image. */
  private async variedSprite(request: ChatSendRequest, run: RequestRun): Promise<VariedSprite> {
    const missing = "Describe what to draw, or open a sprite to make variations of it.";
    const sprite = request.sprite ?? (await activeSpriteInfo(this.deps.gateway))?.id;
    if (sprite === undefined) throw new UserFacingError(missing);
    if (!run.provider.info.supportsImages) {
      const why = startsFromCurrent(request.options) ? ", so it can't start from your sprite" : "";
      throw new UserFacingError(`${run.provider.info.label} can't see images${why}: describe what to draw instead.`);
    }
    const snapshot = await captureCanvas(this.deps.gateway, sprite, { preview: "if_content" });
    if (!snapshot.preview) throw new UserFacingError(missing);
    return { info: snapshot.info, preview: snapshot.preview.image };
  }

  /** directions from the current sprite: its frame 1 is the finished design facing down. */
  private async sourceDesign(request: ChatSendRequest): Promise<SourceDesign> {
    const sprite = request.sprite ?? (await activeSpriteInfo(this.deps.gateway))?.id;
    if (sprite === undefined) throw new UserFacingError("Open the sprite to turn first: its frame 1 is the design facing down.");
    const info = await this.deps.gateway.getSpriteInfo({ sprite });
    const { image } = await this.deps.gateway.readImage({ sprite, frame: 1, flattened: true });
    if (!image.data.some((v, i) => i % 4 === 3 && v > 0)) {
      throw new UserFacingError("Frame 1 of the sprite is empty: draw the character facing down there first.");
    }
    return { info, image };
  }

  private async styleReference(request: ChatSendRequest, run: RequestRun): Promise<LoadedReference | undefined> {
    const reference = request.options.reference;
    return reference ? loadStyleReference(this.deps.gateway, reference, run.provider.info.supportsImages) : undefined;
  }

  /**
   * Sequential on purpose: each create switches Aseprite's active tab. undefined =
   * cancelled (or a palette copy failed), after closing what was already created.
   */
  private async createSprites(
    names: string[],
    size: { width: number; height: number },
    request: ChatSendRequest,
    run: RequestRun,
  ): Promise<SpriteInfo[] | undefined> {
    const sprites: SpriteInfo[] = [];
    const discard = () => Promise.all(sprites.map((s) => closeIfEmpty(this.deps.gateway, s.id)));
    try {
      for (const name of names) {
        if (run.signal.aborted) {
          await discard();
          return undefined;
        }
        const info = await this.deps.gateway.createSprite({ width: size.width, height: size.height, colorMode: "rgb", name });
        run.claimSprite?.(info.id);
        sprites.push(info);
      }
      await carryOverPalette(this.deps.gateway, request, sprites.map((s) => s.id));
    } catch (error) {
      await discard();
      throw error;
    }
    return sprites;
  }

  private context(text: string, options: ChatOptions, info: SpriteInfo, style?: LoadedReference): PromptContext {
    return {
      text,
      options,
      info,
      canvas: describeCanvas(freshSnapshot(info)),
      freshSprite: true,
      hasContent: false,
      reference: style?.text,
    };
  }

  private async runParallel(jobs: Job[], options: ChatOptions, run: RequestRun): Promise<RequestOutcome> {
    const { sessions, mcpUrlFor, maxParallelRuns } = this.deps;
    const providerId = run.provider.info.id;
    const total = jobs.length;
    let finished = 0;
    run.sink({ kind: "progress", done: 0, total });

    const outcomes = await mapLimit(jobs, maxParallelRuns, async (job): Promise<JobOutcome> => {
      const watch = this.deps.activity.watch(job.info.id);
      try {
        const outcome = await executeRun(
          run.provider,
          {
            prompt: job.prompt,
            systemPrompt: CHAT_SYSTEM_PROMPT,
            mcpUrl: mcpUrlFor(job.info.id),
            images: job.images,
            keepAlive: false,
          },
          run.sink,
          run.signal,
          { label: job.label, quietTools: true },
        );
        if (outcome.sessionId) sessions.set(providerId, job.info.id, outcome.sessionId);
        if (!outcome.aborted) {
          finished++;
          run.sink({ kind: "progress", done: finished, total, label: job.label });
          if (outcome.error) run.sink({ kind: "error", text: `${job.label} failed: ${outcome.error}` });
        }
        if (outcome.ok && !run.signal.aborted) {
          await enforceColorRules(this.enforcer, job.info.id, watch.drawnCels, options, run.sink, job.label);
        }
        if (!outcome.ok) await closeIfEmpty(this.deps.gateway, job.info.id);
        return outcome;
      } finally {
        watch.close();
      }
    });

    const succeeded = outcomes.filter((o) => o.ok).length;
    if (succeeded > 0 && succeeded < total && !run.signal.aborted) {
      run.sink({ kind: "status", text: `${succeeded} of ${total} finished.` });
    }
    return statsOf(outcomes, succeeded > 0);
  }
}

function imagesOf(...images: (LlmImage | undefined)[]): LlmImage[] | undefined {
  const present = images.filter((i): i is LlmImage => i !== undefined);
  return present.length ? present : undefined;
}

function statsOf(outcomes: JobOutcome[], ok: boolean): RequestOutcome {
  const costs = outcomes.map((o) => o.costUsd).filter((c): c is number => c !== undefined);
  return {
    ok,
    turns: outcomes.reduce((sum, o) => sum + (o.turns ?? 0), 0) || undefined,
    costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : undefined,
  };
}
