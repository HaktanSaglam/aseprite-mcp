import type { ChatSendRequest } from "./chatSchema.js";
import type { ResolvedProvider } from "./providerResolver.js";

/** docs/PROTOCOL.md `chat` updates: what the Lua chat window renders as they arrive. */
export interface DoneStats {
  durationMs: number;
  turns?: number;
  costUsd?: number;
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
}

export interface RequestOutcome {
  /** True when at least part of the work succeeded (ChatService then reports `done`). */
  ok: boolean;
  turns?: number;
  costUsd?: number;
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
