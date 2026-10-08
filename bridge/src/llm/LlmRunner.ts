/** What a model run reports while it works; the chat UI renders these as they arrive. */
export type LlmEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string }
  | { type: "retry"; attempt: number; reason: string }
  | { type: "done"; ok: boolean; error?: string };

export interface LlmRunRequest {
  prompt: string;
  /** Continue an earlier conversation so follow-ups ("make it darker") have context. */
  sessionId?: string;
  model?: string;
  signal?: AbortSignal;
}

/**
 * The seam between "chat" and "how a model is reached". Today: the user's Claude Code
 * login. A paid/distributed build would add an API-key runner behind the same interface.
 */
export interface ILlmRunner {
  run(request: LlmRunRequest): AsyncIterable<LlmEvent>;
}
