import type { AsepriteEvent, IAsepriteEvents } from "../aseprite/AsepriteSocket.js";
import type { IProviderRegistry } from "../llm/LlmRunner.js";
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
}

const STILL_BUSY = "Still working on the previous request. Press Stop to cancel it first.";

/**
 * Routes Aseprite's chat events and owns the request lifecycle: one request at a time
 * (which may run several jobs), busy/done/stopped reporting and cancellation. What a
 * request actually does lives in the handlers.
 */
export class ChatService {
  private current?: AbortController;
  /** A reset during a run: the run may still store its session while it winds down. */
  private resetWhenIdle = false;
  /** hello.instance of the connected Aseprite, to tell reconnects from restarts. */
  private asepriteInstance?: string;

  constructor(private readonly deps: ChatServiceDeps) {}

  attach(): void {
    this.deps.events.onEvent((event) => this.handle(event));
    this.deps.events.onConnectionChange((connected) => {
      // Nobody is left to see the result, and every tool call would fail anyway.
      if (!connected) this.current?.abort();
    });
  }

  private handle(event: AsepriteEvent): void {
    switch (event.event) {
      case "hello": {
        // Sprite ids restart with Aseprite, so old conversations could attach to the wrong
        // sprite; a reconnect of the same Aseprite (same instance) keeps them.
        const instance = typeof event.instance === "string" ? event.instance : undefined;
        if (instance === undefined || instance !== this.asepriteInstance) this.forgetSessions();
        this.asepriteInstance = instance;
        void this.sendBridgeInfo();
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
        void this.runInstantTool(event);
        return;
    }
  }

  private forgetSessions(): void {
    this.deps.sessions.clear();
    if (this.current) this.resetWhenIdle = true;
  }

  private async sendBridgeInfo(): Promise<void> {
    const { registry, version, events } = this.deps;
    try {
      const providers = await registry.list();
      events.notify({ event: "bridge_info", version, providers, defaultProvider: registry.defaultId });
    } catch (error) {
      events.notify({ event: "bridge_info", version, providers: [], defaultProvider: registry.defaultId });
      this.push({ kind: "error", text: `Could not list AI providers: ${message(error)}` });
    }
  }

  private async start(request: ChatSendRequest): Promise<void> {
    if (this.current) return this.push({ kind: "error", text: STILL_BUSY });
    const invalid = checkRequest(request);
    if (invalid) return this.push({ kind: "error", text: invalid });

    const controller = new AbortController();
    this.current = controller;
    const started = Date.now();
    this.push({ kind: "busy", busy: true });
    try {
      const provider = await resolveProvider(this.deps.registry, request.options);
      const handler = PARALLEL_ACTIONS.has(request.action) ? this.deps.generation : this.deps.singleRun;
      const sink = (update: ChatUpdate) => this.push(update);
      const outcome = await handler.execute(request, { provider, sink, signal: controller.signal });

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
      if (this.resetWhenIdle) {
        this.resetWhenIdle = false;
        this.deps.sessions.clear();
      }
      this.push({ kind: "busy", busy: false });
    }
  }

  private async runInstantTool(event: AsepriteEvent): Promise<void> {
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
    const result = await this.deps.instantTools.run(request);
    this.deps.events.notify({ event: "tool_result", requestId, ...result });
  }

  private push(update: ChatUpdate): void {
    this.deps.events.notify({ event: "chat", ...update });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
