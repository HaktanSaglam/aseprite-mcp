import { basename } from "node:path";
import type { IAsepriteGateway, SpriteInfo } from "../aseprite/AsepriteGateway.js";
import type { LlmImage } from "../llm/LlmRunner.js";
import { captureCanvas, describeCanvas, freshSnapshot } from "./canvasContext.js";
import {
  batchItems,
  DEFAULT_SPRITE_SIZE,
  DEFAULT_VARIATIONS,
  type ChatOptions,
  type ChatSendRequest,
} from "./chatSchema.js";
import { UserFacingError, type IChatRequestHandler, type RequestOutcome, type RequestRun } from "./chatUpdates.js";
import { mapLimit } from "./concurrency.js";
import {
  batchItemPrompt,
  CHAT_SYSTEM_PROMPT,
  DIRECTION_ORDER,
  directionsPrompt,
  variationPrompt,
  type PromptContext,
} from "./promptBuilder.js";
import { executeRun, type JobOutcome } from "./RunExecutor.js";
import type { SessionStore } from "./SessionStore.js";
import { STYLE_SPECS } from "./styleSpecs.js";

type GenerationGateway = Pick<IAsepriteGateway, "createSprite" | "tagOp" | "getSpriteInfo" | "readImage" | "getPalette">;

export interface GenerationDeps {
  gateway: GenerationGateway;
  mcpUrlFor: (sprite: number) => string;
  sessions: SessionStore;
  maxParallelRuns: number;
}

interface Job {
  info: SpriteInfo;
  label: string;
  prompt: string;
  images?: LlmImage[];
}

const tabName = (info: SpriteInfo) => basename(info.filename) || `sprite #${info.id}`;

/**
 * variations / batch / directions: the bridge creates the sprites up front and runs one
 * model job per sprite, each bound to its own sprite through a scoped MCP endpoint, so
 * jobs run in parallel without ever drawing into each other's canvas.
 */
export class GenerationService implements IChatRequestHandler {
  constructor(private readonly deps: GenerationDeps) {}

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
    const reference = request.text.trim() ? undefined : await this.referenceOf(request, run);
    const size = request.options.size ?? reference?.size ?? DEFAULT_SPRITE_SIZE;
    const sprites = await this.createSprites(total, size, run.signal);
    if (!sprites) return { ok: false };

    const jobs = sprites.map((info, i) => ({
      info,
      label: `Variation ${i + 1}`,
      prompt: variationPrompt(this.context(request.text, request.options, info), i + 1, total, reference !== undefined),
      images: reference ? [reference.image] : undefined,
    }));
    run.sink({ kind: "status", text: `Drawing ${total} variations in parallel: ${this.tabList(jobs)}.` });
    return this.runParallel(jobs, run);
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
    const sprites = await this.createSprites(items.length, request.options.size ?? DEFAULT_SPRITE_SIZE, run.signal);
    if (!sprites) return { ok: false };

    const jobs = sprites.map((info, i) => ({
      info,
      label: items[i],
      prompt: batchItemPrompt(this.context(request.text, options, info), items[i], i + 1, items.length),
    }));
    run.sink({ kind: "status", text: `Drawing ${items.length} items in parallel: ${this.tabList(jobs)}.` });
    return this.runParallel(jobs, run);
  }

  /** One job, because consistency across directions needs one model holding the design. */
  private async directions(request: ChatSendRequest, run: RequestRun): Promise<RequestOutcome> {
    const order = DIRECTION_ORDER[request.options.directions ?? 4];
    const size = request.options.size ?? DEFAULT_SPRITE_SIZE;
    const created = await this.deps.gateway.createSprite({ ...size, colorMode: "rgb", frames: order.length });
    const ref = { sprite: created.id };
    for (const [i, direction] of order.entries()) {
      await this.deps.gateway.tagOp({ op: "add", name: direction, from: i + 1, to: i + 1 }, ref);
    }
    const info = await this.deps.gateway.getSpriteInfo(ref);
    run.sink({ kind: "status", text: `Drawing ${order.length} directions into ${tabName(info)}, one frame per direction.` });

    const providerId = run.provider.info.id;
    const outcome = await executeRun(
      run.provider,
      {
        prompt: directionsPrompt(this.context(request.text, request.options, info), order),
        systemPrompt: CHAT_SYSTEM_PROMPT,
        mcpUrl: this.deps.mcpUrlFor(info.id),
      },
      run.sink,
      run.signal,
    );
    if (outcome.sessionId) this.deps.sessions.set(providerId, info.id, outcome.sessionId);
    if (outcome.error) run.sink({ kind: "error", text: outcome.error });
    return { ok: outcome.ok, turns: outcome.turns, costUsd: outcome.costUsd };
  }

  /** Without a description, variations are of the open sprite, which the model sees as an image. */
  private async referenceOf(
    request: ChatSendRequest,
    run: RequestRun,
  ): Promise<{ image: LlmImage; size: { width: number; height: number } }> {
    const missing = "Describe what to draw, or open a sprite to make variations of it.";
    const sprite = request.sprite ?? (await this.deps.gateway.getSpriteInfo().catch(() => undefined))?.id;
    if (sprite === undefined) throw new UserFacingError(missing);
    if (!run.provider.info.supportsImages) {
      throw new UserFacingError(`${run.provider.info.label} can't see images: describe what to draw instead.`);
    }
    const snapshot = await captureCanvas(this.deps.gateway, sprite, { preview: "if_content" });
    if (!snapshot.preview) throw new UserFacingError(missing);
    return { image: snapshot.preview.image, size: { width: snapshot.info.width, height: snapshot.info.height } };
  }

  /** Sequential on purpose: each create switches Aseprite's active tab. Undefined = cancelled. */
  private async createSprites(
    count: number,
    size: { width: number; height: number },
    signal: AbortSignal,
  ): Promise<SpriteInfo[] | undefined> {
    const sprites: SpriteInfo[] = [];
    for (let i = 0; i < count; i++) {
      if (signal.aborted) return undefined;
      sprites.push(await this.deps.gateway.createSprite({ width: size.width, height: size.height, colorMode: "rgb" }));
    }
    return sprites;
  }

  private context(text: string, options: ChatOptions, info: SpriteInfo): PromptContext {
    return {
      text,
      options,
      info,
      canvas: describeCanvas(freshSnapshot(info)),
      freshSprite: true,
      hasContent: false,
    };
  }

  private tabList(jobs: Job[]): string {
    return jobs.map((job) => `${job.label} in ${tabName(job.info)}`).join(", ");
  }

  private async runParallel(jobs: Job[], run: RequestRun): Promise<RequestOutcome> {
    const { sessions, mcpUrlFor, maxParallelRuns } = this.deps;
    const providerId = run.provider.info.id;
    const total = jobs.length;
    let finished = 0;
    run.sink({ kind: "progress", done: 0, total });

    const outcomes = await mapLimit(jobs, maxParallelRuns, async (job): Promise<JobOutcome> => {
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
      return outcome;
    });

    const succeeded = outcomes.filter((o) => o.ok).length;
    if (succeeded > 0 && succeeded < total && !run.signal.aborted) {
      run.sink({ kind: "status", text: `${succeeded} of ${total} finished.` });
    }
    const costs = outcomes.map((o) => o.costUsd).filter((c): c is number => c !== undefined);
    return {
      ok: succeeded > 0,
      turns: outcomes.reduce((sum, o) => sum + (o.turns ?? 0), 0) || undefined,
      costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : undefined,
    };
  }
}
