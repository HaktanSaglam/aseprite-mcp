import { type AgentOptions, ToolCallingAgent } from "./agent/ToolCallingAgent.js";
import type { CompactContext, CompletionRequest, IChatModel, ModelTurn, ToolCall, ToolResult } from "./agent/types.js";
import { ensureOk, ProviderHttpError, requestJson } from "./http/httpJson.js";
import type { LlmImage } from "./LlmRunner.js";

export interface AnthropicSettings {
  apiKey: string;
  /** Without the /v1 suffix, e.g. "https://api.anthropic.com". */
  baseUrl: string;
  defaultModel: string;
  authHint?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

type Block = Record<string, any>;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: Block[];
}

const API_VERSION = "2023-06-01";
// Images older than the last few are replaced once a conversation carries this many.
const MAX_IMAGES = 8;
const KEEP_IMAGES = 2;

/**
 * Request extras that make long tool loops cheaper or more robust. Each one is dropped
 * for the rest of the bridge's life if the API rejects it (older model, proxy, API drift),
 * so a stale optional feature can never take the whole provider down.
 */
interface OptionalFeature {
  id: string;
  beta?: string;
  rejected: RegExp;
  applies(model: string, request: CompletionRequest<AnthropicMessage>): boolean;
  apply(body: Record<string, any>, request: CompletionRequest<AnthropicMessage>): void;
}

const FEATURES: OptionalFeature[] = [
  {
    // Server-side clearing of old tool results: unlike editing the history ourselves it
    // keeps the prompt cache and the model's thinking blocks valid.
    id: "context_management",
    beta: "context-management-2025-06-27",
    rejected: /context.?management|clear_tool_uses/i,
    applies: () => true,
    apply(body) {
      body.context_management = {
        edits: [
          {
            type: "clear_tool_uses_20250919",
            trigger: { type: "input_tokens", value: 80_000 },
            keep: { type: "tool_uses", value: 4 },
            clear_at_least: { type: "input_tokens", value: 20_000 },
          },
        ],
      };
    },
  },
  {
    // A safety-classifier decline is retried server-side on the recommended model.
    id: "fallbacks",
    beta: "server-side-fallback-2026-07-01",
    rejected: /fallback/i,
    applies: (model) => /^claude-(fable-5|opus-5|sonnet-5-5)/.test(model),
    apply(body) {
      body.fallbacks = "default";
    },
  },
  {
    id: "cache_control",
    rejected: /cache_control/i,
    applies: () => true,
    apply(body) {
      body.cache_control = { type: "ephemeral" };
      body.system = [{ ...body.system[0], cache_control: { type: "ephemeral" } }];
    },
  },
  {
    id: "effort",
    rejected: /effort|output_config/i,
    applies: (_model, request) => request.effort !== undefined,
    apply(body, request) {
      body.output_config = { effort: request.effort };
    },
  },
];

function imageBlock(image: LlmImage): Block {
  return { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } };
}

const IMAGE_REMOVED: Block = { type: "text", text: "[earlier image removed to save context]" };

/** Thinking blocks are bound to the exact history before them; after an edit they must go. */
function withoutThinking(history: AnthropicMessage[]): AnthropicMessage[] {
  return history.map((message) => {
    if (message.role !== "assistant") return message;
    const content = message.content.filter((block) => block.type !== "thinking" && block.type !== "redacted_thinking");
    if (content.length === message.content.length) return message;
    return { role: "assistant", content: content.length ? content : [{ type: "text", text: "(no text)" }] };
  });
}

/** Replaces all but the newest `keep` images (top-level or inside tool results). */
function dropOldImages(history: AnthropicMessage[], keep: number): { history: AnthropicMessage[]; dropped: number } {
  let seen = 0;
  let dropped = 0;
  const replace = (blocks: Block[]): Block[] => {
    const out = [...blocks];
    for (let i = out.length - 1; i >= 0; i--) {
      const block = out[i]!;
      if (block.type === "image") {
        if (++seen > keep) {
          out[i] = IMAGE_REMOVED;
          dropped++;
        }
      } else if (block.type === "tool_result" && Array.isArray(block.content)) {
        const inner = replace(block.content);
        if (inner.some((b, j) => b !== block.content[j])) out[i] = { ...block, content: inner };
      }
    }
    return out;
  };
  const out = [...history];
  for (let i = out.length - 1; i >= 0; i--) {
    const message = out[i]!;
    if (message.role !== "user") continue;
    const content = replace(message.content);
    if (content.some((block, j) => block !== message.content[j])) out[i] = { role: "user", content };
  }
  return { history: out, dropped };
}

function countImages(history: AnthropicMessage[]): number {
  const count = (blocks: Block[]): number =>
    blocks.reduce((n, b) => n + (b.type === "image" ? 1 : b.type === "tool_result" && Array.isArray(b.content) ? count(b.content) : 0), 0);
  return history.reduce((n, message) => n + (message.role === "user" ? count(message.content) : 0), 0);
}

/** Anthropic Messages API wire format (tool_use / tool_result with image blocks). */
export class AnthropicChatModel implements IChatModel<AnthropicMessage> {
  readonly label = "Anthropic API";
  readonly vision = true;
  private readonly rejectedFeatures = new Set<string>();

  constructor(private readonly settings: AnthropicSettings) {}

  userTurn(text: string, images: LlmImage[]): AnthropicMessage[] {
    return [{ role: "user", content: [...images.map(imageBlock), { type: "text", text }] }];
  }

  async complete(request: CompletionRequest<AnthropicMessage>): Promise<ModelTurn<AnthropicMessage>> {
    const model = request.model || this.settings.defaultModel;
    let repairedThinking = false;
    for (;;) {
      const { body, betas, applied } = this.buildRequest(model, request);
      try {
        return this.parse(await this.post(body, betas, request.signal));
      } catch (error) {
        if (!(error instanceof ProviderHttpError) || error.status !== 400) throw error;
        const feature = applied.find((f) => f.rejected.test(error.detail));
        if (feature) {
          this.rejectedFeatures.add(feature.id);
          continue;
        }
        if (!repairedThinking && /signature|thinking/i.test(error.detail)) {
          // Documented recovery: drop every thinking block and send the history again.
          repairedThinking = true;
          request.history.splice(0, request.history.length, ...withoutThinking(request.history));
          continue;
        }
        throw error;
      }
    }
  }

  toolResultTurn(results: ToolResult[]): AnthropicMessage[] {
    // All results of one assistant turn go back in a single user message.
    const content = results.map(({ call, outcome }) => {
      const blocks: Block[] = [];
      if (outcome.text) blocks.push({ type: "text", text: outcome.text });
      blocks.push(...outcome.images.map(imageBlock));
      if (blocks.length === 0) blocks.push({ type: "text", text: "(no output)" });
      const result: Block = { type: "tool_result", tool_use_id: call.id, content: blocks };
      if (outcome.isError) result.is_error = true;
      return result;
    });
    return [{ role: "user", content }];
  }

  compact(history: AnthropicMessage[], context: CompactContext): AnthropicMessage[] {
    // Mid-run the history stays append-only; server-side context editing trims tokens.
    if (context.phase === "step") return history;
    let out = history;
    let edited = context.contextChanged;
    if (countImages(out) > MAX_IMAGES) {
      const result = dropOldImages(out, KEEP_IMAGES);
      out = result.history;
      edited ||= result.dropped > 0;
    }
    return edited ? withoutThinking(out) : out;
  }

  private buildRequest(model: string, request: CompletionRequest<AnthropicMessage>) {
    const body: Record<string, any> = {
      model,
      max_tokens: this.settings.maxTokens ?? 32_000,
      system: [{ type: "text", text: request.systemPrompt }],
      messages: request.history,
    };
    if (request.tools.length) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }
    const applied = FEATURES.filter((f) => !this.rejectedFeatures.has(f.id) && f.applies(model, request));
    for (const feature of applied) feature.apply(body, request);
    const betas = applied.flatMap((f) => (f.beta ? [f.beta] : []));
    return { body, betas, applied };
  }

  private async post(body: Record<string, unknown>, betas: string[], signal?: AbortSignal) {
    const headers: Record<string, string> = {
      "x-api-key": this.settings.apiKey,
      "anthropic-version": API_VERSION,
    };
    if (betas.length) headers["anthropic-beta"] = betas.join(",");
    const response = await requestJson(`${this.settings.baseUrl}/v1/messages`, {
      body,
      headers,
      signal,
      timeoutMs: this.settings.timeoutMs,
    });
    return ensureOk(this.label, response, this.settings.authHint).json;
  }

  private parse(json: any): ModelTurn<AnthropicMessage> {
    const content: Block[] = Array.isArray(json?.content) ? json.content : [];
    const texts = content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string);
    const toolCalls: ToolCall[] = content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: String(b.id), name: String(b.name), input: b.input && typeof b.input === "object" ? b.input : {} }));
    const u = json?.usage ?? {};
    const usage = {
      inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      outputTokens: u.output_tokens ?? 0,
    };

    if (json?.stop_reason === "refusal") {
      // A partial answer before a decline must not be replayed as if it were complete.
      const category = json.stop_details?.category;
      return { texts: [], toolCalls: [], usage, error: `Claude declined this request${category ? ` (${category})` : ""}. Try rephrasing it.` };
    }
    if (json?.stop_reason === "max_tokens" && toolCalls.length) {
      return { texts, toolCalls: [], usage, error: "The model hit its output limit in the middle of a tool call." };
    }
    const message: AnthropicMessage | undefined = content.length ? { role: "assistant", content } : undefined;
    const error = json?.stop_reason === "max_tokens" ? "The model hit its output limit; the answer is incomplete." : undefined;
    return { message, texts, toolCalls, usage, error };
  }
}

/** Claude through the Messages API with the user's API key, driven by the shared agent loop. */
export class AnthropicApiRunner extends ToolCallingAgent<AnthropicMessage> {
  constructor(settings: AnthropicSettings, options?: AgentOptions) {
    super(new AnthropicChatModel(settings), options);
  }
}
