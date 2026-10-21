import { requestJson } from "./http/httpJson.js";

/*
 * Default model lists (October 2026). Each one is only a starting point: the config file's
 * `models` / `model` keys replace them, so new model ids never need a bridge release.
 */

export interface ModelOption {
  id: string;
  label: string;
}

/** Claude Code CLI aliases; the CLI resolves them to the newest model of each family. */
export const CLAUDE_CODE_MODELS: ModelOption[] = [
  { id: "fable", label: "Fable (newest)" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

export const ANTHROPIC_MODELS: ModelOption[] = [
  { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
];
export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

/** Chat Completions models with tool calling (gpt-6-astra needs the Responses API for tools). */
export const OPENAI_MODELS: ModelOption[] = [
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
  { id: "gpt-6-luna", label: "GPT-6 Luna (fast)" },
  { id: "gpt-5.5", label: "GPT-5.5" },
];

export const CODEX_MODELS: ModelOption[] = [
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
  { id: "gpt-6-luna", label: "GPT-6 Luna (fast)" },
  { id: "gpt-6-astra", label: "GPT-6 Astra" },
];

/** Gemini CLI aliases; the CLI maps them to the current Gemini generation. */
export const GEMINI_MODELS: ModelOption[] = [
  { id: "auto", label: "Auto" },
  { id: "pro", label: "Gemini Pro" },
  { id: "flash", label: "Gemini Flash (fast)" },
  { id: "flash-lite", label: "Gemini Flash-Lite" },
];

/** OpenAI reasoning models accept `reasoning_effort`; chat-only models reject it. */
export function supportsReasoningEffort(model: string | undefined): boolean {
  return !!model && /^(o\d|gpt-5|gpt-6)/i.test(model);
}

/** Ids from config (keeping `model` first) or the given defaults. */
export function modelOptions(configured: string[] | undefined, model: string | undefined, defaults: ModelOption[]): ModelOption[] {
  const ids = configured?.length ? [...configured] : defaults.map((m) => m.id);
  if (model && !ids.includes(model)) ids.unshift(model);
  return ids.map((id) => defaults.find((m) => m.id === id) ?? { id, label: id });
}

const LIST_CACHE_MS = 30_000;
const MAX_LISTED = 40;

/**
 * Asks an OpenAI-compatible server which models it serves (Ollama, LM Studio, vLLM, ...).
 * Cached briefly: the UI asks on every connect and a local server rarely changes.
 */
export class RemoteModelLister {
  private readonly cache = new Map<string, { at: number; ids: string[] | undefined }>();

  constructor(private readonly timeoutMs = 1500) {}

  /** Model ids, or undefined when the server cannot be reached. */
  async list(baseUrl: string, apiKey?: string): Promise<string[] | undefined> {
    const cached = this.cache.get(baseUrl);
    if (cached && Date.now() - cached.at < LIST_CACHE_MS) return cached.ids;
    let ids: string[] | undefined;
    try {
      const response = await requestJson(`${baseUrl}/models`, {
        method: "GET",
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        timeoutMs: this.timeoutMs,
      });
      if (response.status >= 200 && response.status < 300) {
        const data: unknown[] = Array.isArray(response.json?.data) ? response.json.data : [];
        ids = data
          .map((entry: any) => entry?.id)
          .filter((id): id is string => typeof id === "string")
          .sort()
          .slice(0, MAX_LISTED);
      }
    } catch {
      ids = undefined;
    }
    this.cache.set(baseUrl, { at: Date.now(), ids });
    return ids;
  }
}
