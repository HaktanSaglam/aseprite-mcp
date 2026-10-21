export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface LlmImage {
  mediaType: "image/png";
  base64: string;
}

export interface RunStats {
  durationMs: number;
  turns?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** What a model run reports while it works; the chat UI renders these as they arrive. */
export type LlmEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string }
  | { type: "retry"; attempt: number; reason: string }
  | { type: "done"; ok: boolean; error?: string; stats?: RunStats };

export interface LlmRunRequest {
  prompt: string;
  /** Attached to the first user message (e.g. a preview of the canvas). */
  images?: LlmImage[];
  /** Continue an earlier conversation so follow-ups ("make it darker") have context. */
  sessionId?: string;
  model?: string;
  effort?: Effort;
  /** MCP endpoint this run must use: the bridge's own, or a scoped one for parallel jobs. */
  mcpUrl: string;
  /** Appended to the provider's own system prompt. */
  systemPrompt: string;
  signal?: AbortSignal;
}

/**
 * The seam between "chat" and "how a model is reached": a CLI with the user's own
 * subscription (Claude Code, Codex, Gemini) or an HTTP API with a key.
 */
export interface ILlmRunner {
  run(request: LlmRunRequest): AsyncIterable<LlmEvent>;
}

export interface ProviderInfo {
  /** Stable id used by the UI: "claude-code", "codex", "gemini-cli", "openai", "anthropic". */
  id: string;
  label: string;
  models: { id: string; label: string }[];
  /** Empty when the provider has no effort/reasoning control. */
  efforts: Effort[];
  /** False when its CLI is missing or it has no API key; `note` says what to do. */
  available: boolean;
  note?: string;
  supportsImages: boolean;
}

export interface IProviderRegistry {
  readonly defaultId: string;
  list(): Promise<ProviderInfo[]>;
  /** Throws a user-readable error for unknown or unavailable providers. */
  runner(id: string): ILlmRunner;
}
