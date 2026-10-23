import type { ChatSendRequest } from "./chatSchema.js";
import type { ResolvedProvider } from "./providerResolver.js";

/** docs/PROTOCOL.md `chat` updates: what the Lua chat window renders as they arrive. */
export interface DoneStats {
  durationMs: number;
  turns?: number;
  costUsd?: number;
  /** Undo steps the run added to `sprite`: "Undo AI run" sends tool_run undo {steps} for it. */
  undoSteps?: number;
  /** The sprite undoSteps belong to (not always the tab the request was sent from). */
  sprite?: number;
}

export type ChatUpdate =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string }
  | { kind: "status"; text: string }
  | { kind: "error"; text: string }
  | { kind: "busy"; busy: boolean }
  | { kind: "done"; stats: DoneStats }
  | { kind: "progress"; done: number; total: number; label?: string };

export type ChatSink = (update: ChatUpdate) => void;

/** What a request handler gets from the request lifecycle that ChatService owns. */
export interface RequestRun {
  provider: ResolvedProvider;
  sink: ChatSink;
  signal: AbortSignal;
  /**
   * Called for every sprite the request draws into, as soon as it is known. Until then
   * (and for a run that works on whatever tab is active) any sprite may be its target,
   * so the Tools tab's instant tools are held off everywhere.
   */
  claimSprite?: (sprite: number) => void;
}

export interface RequestOutcome {
  /** True when at least part of the work succeeded (ChatService then reports `done`). */
  ok: boolean;
  turns?: number;
  costUsd?: number;
  /**
   * Set only for a run that changed one sprite the user already had: a sprite the bridge
   * created is simply closed, and one number can't undo several sprites.
   */
  undo?: { sprite: number; steps: number };
}

/** Handles one kind of chat_send (single model run, or parallel generation jobs). */
export interface IChatRequestHandler {
  execute(request: ChatSendRequest, run: RequestRun): Promise<RequestOutcome>;
}

/**
 * Errors whose message is written for the user ("Select an area first"). ChatService shows
 * every error's message, but only logs the unexpected ones.
 */
export class UserFacingError extends Error {}
