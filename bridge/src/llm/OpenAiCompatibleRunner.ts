import { randomUUID } from "node:crypto";
import { type AgentOptions, ToolCallingAgent } from "./agent/ToolCallingAgent.js";
import type { CompactContext, CompletionRequest, IChatModel, ModelTurn, ToolCall, ToolResult } from "./agent/types.js";
import { ensureOk, ProviderHttpError, requestJson } from "./http/httpJson.js";
import { EFFORTS, type Effort, type LlmImage } from "./LlmRunner.js";

export interface OpenAiSettings {
  /** Shown in errors: "OpenAI", "OpenRouter", "Ollama", ... */
  label: string;
  /** Up to and including the version segment, e.g. "https://api.openai.com/v1". */
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
  /** Asked when neither the request nor `defaultModel` names a model (e.g. first local model). */
  resolveDefaultModel?: () => Promise<string | undefined>;
  /** Send `reasoning_effort` (only for models that accept it, e.g. OpenAI reasoning models). */
  reasoningEffort: boolean;
  /** Highest value the endpoint accepts; higher UI efforts are clamped to it. */
  maxReasoningEffort: Effort;
  /** Whether the model can look at images (tool previews, attached canvas). */
  vision: boolean;
  /** Appended to 401/403 errors, e.g. which env var or config key holds the key. */
  authHint?: string;
  timeoutMs?: number;
}

type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type OpenAiMessage =
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string; tool_calls?: WireToolCall[]; reasoning_content?: string }
  | { role: "tool"; tool_call_id: string; content: string };

// Every preview re-sent on every step costs ~1k tokens; the latest few are what matter.
const KEEP_IMAGES = 3;
const IMAGE_REMOVED: ContentPart = { type: "text", text: "[earlier image removed to save context]" };

function imagePart(image: LlmImage): ContentPart {
  return { type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.base64}` } };
}

/** Local reasoning models (qwen3, deepseek-r1 on Ollama) put their thoughts in the answer. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
  }
  return "";
}

function parseArguments(raw: unknown): { input: Record<string, unknown>; inputError?: string } {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { input: raw as Record<string, unknown> };
  if (typeof raw !== "string" || !raw.trim()) return { input: {} };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { input: parsed };
    return { input: {}, inputError: "tool arguments must be a JSON object" };
  } catch (error) {
    return { input: {}, inputError: `tool arguments are not valid JSON (${(error as Error).message}); send them again` };
  }
}

function clampEffort(effort: Effort, max: Effort): Effort {
  return EFFORTS[Math.min(EFFORTS.indexOf(effort), EFFORTS.indexOf(max))]!;
}

/** Chat Completions wire format: OpenAI, OpenRouter, Ollama, LM Studio, Groq, DeepSeek, ... */
export class OpenAiChatModel implements IChatModel<OpenAiMessage> {
  readonly label: string;
  readonly vision: boolean;
  /** Models that answered 400 to `reasoning_effort`; asked without it from then on. */
  private readonly noEffortModels = new Set<string>();

  constructor(private readonly settings: OpenAiSettings) {
    this.label = settings.label;
    this.vision = settings.vision;
  }

  userTurn(text: string, images: LlmImage[]): OpenAiMessage[] {
    if (!this.vision || images.length === 0) return [{ role: "user", content: text }];
    return [{ role: "user", content: [...images.map(imagePart), { type: "text", text }] }];
  }

  async complete(request: CompletionRequest<OpenAiMessage>): Promise<ModelTurn<OpenAiMessage>> {
    const model = request.model || this.settings.defaultModel || (await this.settings.resolveDefaultModel?.());
    if (!model) {
      throw new ProviderHttpError(`${this.label}: no model selected. Pick one in the chat options or set a default model in the config.`, undefined, false);
    }
    const effort = this.effortFor(model, request.effort);
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "system", content: request.systemPrompt }, ...request.history],
    };
    if (request.tools.length) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      }));
    }
    if (effort) body.reasoning_effort = effort;

    try {
      return this.parse(await this.post(body, request.signal));
    } catch (error) {
      // Not every model behind an endpoint takes reasoning_effort; retry once without it.
      if (effort && error instanceof ProviderHttpError && error.status === 400 && /reasoning/i.test(error.detail)) {
        this.noEffortModels.add(model);
        delete body.reasoning_effort;
        return this.parse(await this.post(body, request.signal));
      }
      throw error;
    }
  }

  toolResultTurn(results: ToolResult[]): OpenAiMessage[] {
    const messages: OpenAiMessage[] = results.map(({ call, outcome }) => {
      let text = outcome.text || (outcome.images.length ? "(image attached below)" : "(no output)");
      if (outcome.isError && !/^error/i.test(text)) text = `Error: ${text}`;
      return { role: "tool", tool_call_id: call.id, content: text };
    });
    // Tool messages must be text, so images ride along in one user message after them.
    const withImages = results.filter((result) => result.outcome.images.length > 0);
    if (this.vision && withImages.length) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: `Images returned by ${withImages.map((r) => r.call.name).join(", ")}:` },
          ...withImages.flatMap((r) => r.outcome.images.map(imagePart)),
        ],
      });
    }
    return messages;
  }

  compact(history: OpenAiMessage[], _context: CompactContext): OpenAiMessage[] {
    let kept = 0;
    const out = [...history];
    for (let i = out.length - 1; i >= 0; i--) {
      const message = out[i]!;
      if (message.role !== "user" || typeof message.content === "string") continue;
      if (!message.content.some((part) => part.type === "image_url")) continue;
      const content = message.content.map((part) => {
        if (part.type !== "image_url") return part;
        return ++kept <= KEEP_IMAGES ? part : IMAGE_REMOVED;
      });
      out[i] = { role: "user", content };
    }
    return out;
  }

  private effortFor(model: string, effort: Effort | undefined): Effort | undefined {
    if (!effort || !this.settings.reasoningEffort || this.noEffortModels.has(model)) return undefined;
    return clampEffort(effort, this.settings.maxReasoningEffort);
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal) {
    const headers: Record<string, string> = {};
    if (this.settings.apiKey) headers.authorization = `Bearer ${this.settings.apiKey}`;
    if (this.settings.baseUrl.includes("openrouter.ai")) {
      // OpenRouter attributes traffic by these; harmless elsewhere but kept specific.
      headers["http-referer"] = "https://github.com/aseprite-mcp";
      headers["x-title"] = "Aseprite MCP";
    }
    const response = await requestJson(`${this.settings.baseUrl}/chat/completions`, {
      body,
      headers,
      signal,
      timeoutMs: this.settings.timeoutMs,
    });
    return ensureOk(this.label, response, this.settings.authHint).json;
  }

  private parse(json: any): ModelTurn<OpenAiMessage> {
    const choice = json?.choices?.[0];
    const message = choice?.message;
    if (!message) {
      throw new ProviderHttpError(`${this.label} returned no answer: ${JSON.stringify(json).slice(0, 200)}`, undefined, true);
    }
    const toolCalls: ToolCall[] = [];
    const wireCalls: WireToolCall[] = [];
    for (const raw of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const name = raw?.function?.name;
      if (typeof name !== "string" || !name) continue;
      // Some local servers omit ids; results are matched by id, so invent one.
      const id = typeof raw.id === "string" && raw.id ? raw.id : `call_${randomUUID().slice(0, 8)}`;
      const args = raw.function.arguments;
      toolCalls.push({ id, name, ...parseArguments(args) });
      wireCalls.push({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) } });
    }

    const text = stripThinking(contentText(message.content));
    const usage = json.usage
      ? { inputTokens: Number(json.usage.prompt_tokens) || 0, outputTokens: Number(json.usage.completion_tokens) || 0 }
      : undefined;

    if (choice.finish_reason === "length" && toolCalls.length) {
      // Arguments may be cut mid-JSON; replaying the call would only confuse the model.
      return { texts: [text], toolCalls: [], usage, error: `${this.label} hit its output limit in the middle of a tool call.` };
    }
    const assistant: OpenAiMessage = { role: "assistant", content: text };
    if (wireCalls.length) assistant.tool_calls = wireCalls;
    // DeepSeek's thinking mode requires its reasoning back during a tool loop.
    if (typeof message.reasoning_content === "string") assistant.reasoning_content = message.reasoning_content;

    let error: string | undefined;
    if (choice.finish_reason === "length") error = `${this.label} hit its output limit; the answer is incomplete.`;
    if (choice.finish_reason === "content_filter") error = `${this.label}'s content filter blocked the answer.`;
    return { message: assistant, texts: [text], toolCalls, usage, error };
  }
}

/** Any Chat Completions endpoint with tool calling, driven by the shared agent loop. */
export class OpenAiCompatibleRunner extends ToolCallingAgent<OpenAiMessage> {
  constructor(settings: OpenAiSettings, options?: AgentOptions) {
    super(new OpenAiChatModel(settings), options);
  }
}
