import type { Effort, LlmImage } from "../LlmRunner.js";

export type JsonSchema = Record<string, unknown>;

/** A tool the model may call, in provider-neutral form (straight from MCP `tools/list`). */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Set when the model produced arguments that are not a JSON object; the tool is not run. */
  inputError?: string;
}

export interface ToolOutcome {
  text: string;
  images: LlmImage[];
  isError: boolean;
}

export interface ToolResult {
  call: ToolCall;
  outcome: ToolOutcome;
}

/** One model response, already split into what the loop needs. */
export interface ModelTurn<M> {
  /** Appended to the history verbatim; absent when the response must not be replayed. */
  message?: M;
  texts: string[];
  toolCalls: ToolCall[];
  /** Set when the model stopped abnormally (refusal, output limit, ...). */
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface CompletionRequest<M> {
  /** May be repaired in place by the model (e.g. dropping replay-invalid blocks). */
  history: M[];
  tools: ToolSpec[];
  systemPrompt: string;
  model?: string;
  effort?: Effort;
  signal?: AbortSignal;
}

export interface CompactContext {
  /** "run_start": before a new user message; "step": after each round of tool results. */
  phase: "run_start" | "step";
  /** True when the system prompt or the tool list differ from the previous run of this session. */
  contextChanged: boolean;
}

/**
 * A provider's wire format. The shared loop in ToolCallingAgent only ever talks to this,
 * so adding a provider means writing one of these and nothing else.
 */
export interface IChatModel<M> {
  /** Human name used in error messages ("OpenAI", "Anthropic API", ...). */
  readonly label: string;
  /** Whether image outputs of tools can be shown to the model. */
  readonly vision: boolean;
  userTurn(text: string, images: LlmImage[]): M[];
  complete(request: CompletionRequest<M>): Promise<ModelTurn<M>>;
  toolResultTurn(results: ToolResult[]): M[];
  /** Bounds memory and tokens, e.g. by dropping old image payloads. */
  compact(history: M[], context: CompactContext): M[];
}

/** The tools of one MCP endpoint, connected for one run. */
export interface IToolHost {
  readonly instructions?: string;
  readonly tools: ToolSpec[];
  call(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome>;
  close(): Promise<void>;
}

export type ToolHostFactory = (mcpUrl: string) => Promise<IToolHost>;
