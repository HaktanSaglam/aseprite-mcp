import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import type { Effort } from "./LlmRunner.js";

/*
 * ~/.aseprite-mcp/config.json (path: ASEPRITE_MCP_CONFIG). Every key is optional; values in
 * this file win over environment variables, which are only fallbacks. Example:
 *
 * {
 *   "defaultProvider": "claude-code",
 *   "providers": {
 *     "claude-code": { "path": "/opt/homebrew/bin/claude" },
 *     "codex":       { "path": "codex", "models": ["gpt-6.1-sol", "gpt-6-luna"] },
 *     "gemini-cli":  { "path": "gemini", "models": ["auto", "pro", "flash"] },
 *     "openai": {
 *       "baseUrl": "https://openrouter.ai/api/v1",
 *       "apiKey": "sk-or-...",
 *       "model": "openai/gpt-6.1-sol",
 *       "models": ["openai/gpt-6.1-sol", "google/gemini-3-pro"],
 *       "reasoningEffort": true,
 *       "maxReasoningEffort": "high",
 *       "vision": true,
 *       "label": "OpenRouter"
 *     },
 *     "anthropic": { "apiKey": "sk-ant-...", "model": "claude-opus-5-5" },
 *     "ollama":    { "baseUrl": "http://127.0.0.1:11434/v1", "model": "qwen3", "vision": false }
 *   }
 * }
 */

const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
const ModelList = z.array(z.string().min(1));

const OpenAiSchema = z.object({
  baseUrl: z.url().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  models: ModelList.optional(),
  reasoningEffort: z.boolean().optional(),
  maxReasoningEffort: EffortSchema.optional(),
  vision: z.boolean().optional(),
  label: z.string().optional(),
});

const AnthropicSchema = z.object({
  baseUrl: z.url().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  models: ModelList.optional(),
});

const CliSchema = z.object({
  path: z.string().optional(),
  models: ModelList.optional(),
});

const OllamaSchema = z.object({
  baseUrl: z.url().optional(),
  model: z.string().optional(),
  models: ModelList.optional(),
  vision: z.boolean().optional(),
});

export const ConfigFileSchema = z.object({
  defaultProvider: z.string().optional(),
  providers: z
    .object({
      "claude-code": z.object({ path: z.string().optional() }).optional(),
      codex: CliSchema.optional(),
      "gemini-cli": CliSchema.optional(),
      openai: OpenAiSchema.optional(),
      anthropic: AnthropicSchema.optional(),
      ollama: OllamaSchema.optional(),
    })
    .optional(),
});

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export interface LoadedConfig {
  file: ConfigFile;
  /** Why the file was ignored (bad JSON, wrong types); undefined when fine or absent. */
  error?: string;
}

/** Reads and validates the config file; a missing file is simply an empty config. */
export function readConfigFile(path: string): LoadedConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file: {} };
    return { file: {}, error: `Cannot read ${path}: ${(error as Error).message}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { file: {}, error: `${path} is not valid JSON: ${(error as Error).message}` };
  }
  const parsed = ConfigFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { file: {}, error: `${path}: ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid"}` };
  }
  return { file: parsed.data };
}

/** Re-reads the config file only when it changed, so edits apply without a bridge restart. */
export class ConfigFileSource {
  private cached?: { mtimeMs: number; loaded: LoadedConfig };

  constructor(private readonly path: string) {}

  current(): LoadedConfig {
    let mtimeMs = -1;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      // Missing file: mtime -1 caches the empty config until the file appears.
    }
    if (this.cached?.mtimeMs !== mtimeMs) {
      this.cached = { mtimeMs, loaded: readConfigFile(this.path) };
      if (this.cached.loaded.error) console.error(`[bridge] Ignoring AI provider config: ${this.cached.loaded.error}`);
    }
    return this.cached.loaded;
  }
}

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";

export interface OpenAiProviderSettings {
  baseUrl: string;
  official: boolean;
  apiKey?: string;
  model?: string;
  models?: string[];
  reasoningEffort?: boolean;
  maxReasoningEffort?: Effort;
  vision?: boolean;
  label?: string;
}

export interface ResolvedSettings {
  defaultProvider?: string;
  claude: { path: string };
  codex: { path: string; models?: string[] };
  gemini: { path: string; models?: string[] };
  openai: OpenAiProviderSettings;
  anthropic: { baseUrl: string; apiKey?: string; model?: string; models?: string[] };
  ollama: { baseUrl: string; model?: string; models?: string[]; vision?: boolean };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value.trim() : undefined;
}

/** Merges the config file with environment fallbacks into one settings object. */
export function resolveSettings(file: ConfigFile, env: NodeJS.ProcessEnv, claudePath: string): ResolvedSettings {
  const p = file.providers ?? {};
  const openAiBase = trimSlash(p.openai?.baseUrl ?? nonEmpty(env.OPENAI_BASE_URL) ?? OPENAI_BASE_URL);
  const ollamaHost = nonEmpty(env.OLLAMA_HOST);
  return {
    defaultProvider: file.defaultProvider,
    claude: { path: p["claude-code"]?.path ?? claudePath },
    codex: { path: p.codex?.path ?? nonEmpty(env.CODEX_PATH) ?? "codex", models: p.codex?.models },
    gemini: { path: p["gemini-cli"]?.path ?? nonEmpty(env.GEMINI_PATH) ?? "gemini", models: p["gemini-cli"]?.models },
    openai: {
      ...p.openai,
      baseUrl: openAiBase,
      official: openAiBase === OPENAI_BASE_URL,
      apiKey: nonEmpty(p.openai?.apiKey) ?? nonEmpty(env.OPENAI_API_KEY),
      model: nonEmpty(p.openai?.model) ?? nonEmpty(env.OPENAI_MODEL),
    },
    anthropic: {
      // ANTHROPIC_BASE_URL is deliberately not read: a bridge started from a Claude Code
      // terminal inherits that session's internal proxy URL.
      baseUrl: trimSlash(p.anthropic?.baseUrl ?? ANTHROPIC_BASE_URL),
      apiKey: nonEmpty(p.anthropic?.apiKey) ?? nonEmpty(env.ANTHROPIC_API_KEY),
      model: nonEmpty(p.anthropic?.model) ?? nonEmpty(env.ANTHROPIC_MODEL),
      models: p.anthropic?.models,
    },
    ollama: {
      ...p.ollama,
      baseUrl: trimSlash(
        p.ollama?.baseUrl ?? (ollamaHost ? `${/^https?:\/\//.test(ollamaHost) ? ollamaHost : `http://${ollamaHost}`}/v1` : OLLAMA_BASE_URL),
      ),
    },
  };
}
