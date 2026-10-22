import type { AsepriteEvent, IAsepriteEvents } from "../aseprite/AsepriteSocket.js";
import type { IProviderRegistry, ProviderInfo } from "../llm/LlmRunner.js";
import { checkRequest, PARALLEL_ACTIONS, parseChatSend, parseToolRun, type ChatSendRequest } from "./chatSchema.js";
import { UserFacingError, type ChatUpdate, type IChatRequestHandler } from "./chatUpdates.js";
import type { InstantToolRequest, InstantToolResult } from "./InstantToolService.js";
import { resolveProvider } from "./providerResolver.js";
import type { SessionStore } from "./SessionStore.js";

export interface ChatServiceDeps {
  events: IAsepriteEvents;
  registry: IProviderRegistry;
  /** chat, generate, edit_selection, review, animate */
  singleRun: IChatRequestHandler;
  /** variations, batch, directions */
  generation: IChatRequestHandler;
  instantTools: { run(request: InstantToolRequest): Promise<InstantToolResult> };
  sessions: SessionStore;
  version: string;
  /** How often provider availability is re-checked while Aseprite is connected (tests shorten it). */
  providerPollMs?: number;
}

const STILL_BUSY = "Still working on the previous request. Press Stop to cancel it first.";
const AI_IS_DRAWING = "The AI is drawing on this sprite. Wait for the AI to finish or press Stop.";
/** Cheap (the registry caches the config file and remote model lists), so a key or `ollama serve` shows up quickly. */
const PROVIDER_POLL_MS = 30_000;

/**
 * Routes Aseprite's chat events and owns the request lifecycle: one request at a time
 * (which may run several jobs), busy/done/stopped reporting and cancellation. What a
 * request actually does lives in the handlers.
 */
export class ChatService {
  private current?: AbortController;
  /** Sprites the current run draws into; undefined while it may touch any sprite (see RequestRun.claimSprite). */
  private claimed?: Set<number>;
  /**
   * Instant tools read a layer, compute and write it back over several RPCs, so two of
   * them at once would overwrite each other's result. They run one at a time.
   */
  private toolQueue: Promise<void> = Promise.resolve();
  /** A reset during a run: the run may still store its session while it winds down. */
  private resetWhenIdle = false;
  /** hello.instance of the connected Aseprite, to tell reconnects from restarts. */
  private asepriteInstance?: string;
  /** The last bridge_info sent, to notify the window only when provider availability changed. */
  private lastBridgeInfo?: string;
  private providerPoll?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: ChatServiceDeps) {}

  attach(): void {
    this.deps.events.onEvent((event) => this.handle(event));
    this.deps.events.onConnectionChange((connected) => {
      if (connected) return;
      // Nobody is left to see the result, and every tool call would fail anyway.
      this.current?.abort();
      this.stopProviderPoll();
    });
  }

  /** Stops the provider polling. The timer never keeps the process alive, so only tests need this. */
  detach(): void {
    this.stopProviderPoll();
  }

  private handle(event: AsepriteEvent): void {
    switch (event.event) {
      case "hello": {
        // Sprite ids restart with Aseprite, so old conversations could attach to the wrong
        // sprite; a reconnect of the same Aseprite (same instance) keeps them.
        const instance = typeof event.instance === "string" ? event.instance : undefined;
        if (instance === undefined || instance !== this.asepriteInstance) this.forgetSessions();
        this.asepriteInstance = instance;
        void this.sendBridgeInfo(false);
        this.startProviderPoll();
        return;
      }
      case "chat_send": {
        const parsed = parseChatSend(event);
        if (!parsed.ok) return this.push({ kind: "error", text: parsed.error });
        void this.start(parsed.value);
        return;
      }
      case "chat_cancel":
        this.current?.abort();
        return;
      case "chat_reset":
        this.current?.abort();
        this.forgetSessions();
        this.push({ kind: "status", text: "New conversation." });
        return;
      case "tool_run":
        this.queueInstantTool(event);
        return;
    }
  }

  private forgetSessions(): void {
    this.deps.sessions.clear();
    if (this.current) this.resetWhenIdle = true;
  }

  /**
   * After hello the window always gets the list; a poll only notifies when it changed
   * (a key added to the config file, `ollama serve` started, a CLI installed).
   */
  private async sendBridgeInfo(onlyIfChanged: boolean): Promise<void> {
    const { registry, version, events } = this.deps;
    let providers: ProviderInfo[];
    try {
      providers = await registry.list();
    } catch (error) {
      // The window keeps its last list; the next poll tries again instead of repeating the error.
      if (onlyIfChanged) return;
      providers = [];
      this.push({ kind: "error", text: `Could not list AI providers: ${message(error)}` });
    }
    const info = { event: "bridge_info", version, providers, defaultProvider: registry.defaultId };
    const serialized = JSON.stringify(info);
    if (onlyIfChanged && serialized === this.lastBridgeInfo) return;
    this.lastBridgeInfo = serialized;
    events.notify(info);
  }

  private startProviderPoll(): void {
    this.stopProviderPoll();
    this.providerPoll = setInterval(() => void this.sendBridgeInfo(true), this.deps.providerPollMs ?? PROVIDER_POLL_MS);
    // Polling alone must never keep the bridge process alive.
    this.providerPoll.unref?.();
  }

  private stopProviderPoll(): void {
    if (this.providerPoll) clearInterval(this.providerPoll);
    this.providerPoll = undefined;
  }

  private async start(request: ChatSendRequest): Promise<void> {
    if (this.current) return this.push({ kind: "error", text: STILL_BUSY });
    const invalid = checkRequest(request);
    if (invalid) return this.push({ kind: "error", text: invalid });

    const controller = new AbortController();
    this.current = controller;
    this.claimed = undefined;
    const started = Date.now();
    this.push({ kind: "busy", busy: true });
    try {
      // Instant tools clicked before this request finish before the AI reads the canvas.
      await this.toolQueue;
      const provider = await resolveProvider(this.deps.registry, request.options);
      const handler = PARALLEL_ACTIONS.has(request.action) ? this.deps.generation : this.deps.singleRun;
      const sink = (update: ChatUpdate) => this.push(update);
      const claimSprite = (sprite: number) => (this.claimed ??= new Set()).add(sprite);
      const outcome = await handler.execute(request, { provider, sink, signal: controller.signal, claimSprite });

      if (controller.signal.aborted) this.push({ kind: "status", text: "Stopped." });
      else if (outcome.ok) {
        this.push({
          kind: "done",
          stats: { durationMs: Date.now() - started, turns: outcome.turns, costUsd: outcome.costUsd },
        });
      }
    } catch (error) {
      if (controller.signal.aborted) return this.push({ kind: "status", text: "Stopped." });
      // Expected problems ("Select an area first") need no stack trace in the bridge log.
      if (!(error instanceof UserFacingError)) console.error("[bridge] chat request failed:", error);
      this.push({ kind: "error", text: message(error) });
    } finally {
      this.current = undefined;
      this.claimed = undefined;
      if (this.resetWhenIdle) {
        this.resetWhenIdle = false;
        this.deps.sessions.clear();
      }
      this.push({ kind: "busy", busy: false });
    }
  }

  /**
   * Checked when the click arrives, so tools clicked before an AI request still run (the
   * request waits for them) and only the ones clicked during the run are refused.
   */
  private queueInstantTool(event: AsepriteEvent): void {
    const parsed = parseToolRun(event);
    if (!parsed.ok) {
      // Answer anyway when possible, so the UI doesn't wait for a result that never comes.
      const requestId = event.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        this.deps.events.notify({ event: "tool_result", requestId, ok: false, text: parsed.error });
      } else {
        this.push({ kind: "error", text: parsed.error });
      }
      return;
    }
    const { requestId, ...request } = parsed.value;
    if (this.aiIsDrawingOn(request.sprite)) {
      this.deps.events.notify({ event: "tool_result", requestId, ok: false, text: AI_IS_DRAWING });
      return;
    }
    this.toolQueue = this.toolQueue
      .then(async () => {
        const result = await this.deps.instantTools.run(request);
        this.deps.events.notify({ event: "tool_result", requestId, ...result });
      })
      .catch((error) => {
        console.error("[bridge] instant tool failed:", error);
        this.deps.events.notify({ event: "tool_result", requestId, ok: false, text: message(error) });
      });
  }

  // An instant tool and the AI writing the same layer would silently overwrite each other's edits.
  private aiIsDrawingOn(sprite: number | undefined): boolean {
    if (!this.current) return false;
    if (sprite === undefined || this.claimed === undefined) return true;
    return this.claimed.has(sprite);
  }

  private push(update: ChatUpdate): void {
    this.deps.events.notify({ event: "chat", ...update });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
