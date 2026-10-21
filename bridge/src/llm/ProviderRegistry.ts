import { dirname, join } from "node:path";
import type { BridgeConfig } from "../config.js";
import type { AgentOptions } from "./agent/ToolCallingAgent.js";
import { AnthropicApiRunner } from "./AnthropicApiRunner.js";
import { ClaudeCliRunner } from "./ClaudeCliRunner.js";
import { which as defaultWhich } from "./cli/which.js";
import { CODEX_INSTALL_HINT, CodexCliRunner } from "./CodexCliRunner.js";
import { GEMINI_INSTALL_HINT, GeminiCliRunner } from "./GeminiCliRunner.js";
import { EFFORTS, type Effort, type ILlmRunner, type IProviderRegistry, type ProviderInfo } from "./LlmRunner.js";
import {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_MODELS,
  CLAUDE_CODE_MODELS,
  CODEX_MODELS,
  GEMINI_MODELS,
  modelOptions,
  OPENAI_MODELS,
  RemoteModelLister,
  supportsReasoningEffort,
} from "./modelCatalog.js";
import { OpenAiCompatibleRunner, type OpenAiSettings } from "./OpenAiCompatibleRunner.js";
import { ConfigFileSource, resolveSettings, type ResolvedSettings } from "./providerSettings.js";

export const PROVIDER_IDS = ["claude-code", "codex", "gemini-cli", "openai", "anthropic", "ollama"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

const DEFAULT_PROVIDER: ProviderId = "claude-code";
const CLAUDE_INSTALL_HINT =
  "Install it with `npm install -g @anthropic-ai/claude-code` and run `claude auth login`, or set CLAUDE_PATH.";

interface Dependencies {
  env?: NodeJS.ProcessEnv;
  /** Resolves a CLI name to its path; injectable so tests do not depend on the machine. */
  which?: (command: string) => string | undefined;
  models?: RemoteModelLister;
  agentOptions?: AgentOptions;
}

function isProviderId(id: string | undefined): id is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(id ?? "");
}

function effortsUpTo(max: Effort): Effort[] {
  return EFFORTS.slice(0, EFFORTS.indexOf(max) + 1);
}

/** Builds every provider the bridge knows about from config + environment. */
export function createProviderRegistry(config: BridgeConfig, deps: Dependencies = {}): IProviderRegistry {
  const env = deps.env ?? process.env;
  const which = deps.which ?? ((command: string) => defaultWhich(command, env));
  const lister = deps.models ?? new RemoteModelLister();
  const source = new ConfigFileSource(config.configFile);
  const workRoot = dirname(config.claudeWorkDir);
  const runners = new Map<ProviderId, { fingerprint: string; runner: ILlmRunner }>();

  const settings = (): ResolvedSettings => resolveSettings(source.current().file, env, config.claudePath);
  const keyHint = (envVar: string, key: string) =>
    `Set ${envVar} or add providers.${key}.apiKey to ${config.configFile}, then reopen the chat.`;

  const openAiSettings = (s: ResolvedSettings): OpenAiSettings => {
    const o = s.openai;
    const model = o.model ?? o.models?.[0] ?? (o.official ? OPENAI_MODELS[0]!.id : undefined);
    return {
      label: o.label ?? (o.official ? "OpenAI" : "OpenAI-compatible API"),
      baseUrl: o.baseUrl,
      apiKey: o.apiKey,
      defaultModel: model,
      reasoningEffort: o.reasoningEffort ?? (o.official && supportsReasoningEffort(model)),
      maxReasoningEffort: o.maxReasoningEffort ?? "high",
      vision: o.vision ?? true,
      authHint: keyHint("OPENAI_API_KEY", "openai"),
      resolveDefaultModel: o.official ? undefined : async () => (await lister.list(o.baseUrl, o.apiKey))?.[0],
    };
  };

  const ollamaSettings = (s: ResolvedSettings): OpenAiSettings => ({
    label: "Ollama",
    baseUrl: s.ollama.baseUrl,
    defaultModel: s.ollama.model ?? s.ollama.models?.[0],
    resolveDefaultModel: async () => (await lister.list(s.ollama.baseUrl))?.[0],
    reasoningEffort: false,
    maxReasoningEffort: "high",
    vision: s.ollama.vision ?? false,
    // Local models are slower; give a long tool step room.
    timeoutMs: 30 * 60_000,
  });

  /** Reuses a runner (and its conversations) until its settings change. */
  const cached = (id: ProviderId, fingerprint: unknown, build: () => ILlmRunner): ILlmRunner => {
    const key = JSON.stringify(fingerprint);
    const existing = runners.get(id);
    if (existing?.fingerprint === key) return existing.runner;
    if (existing?.runner instanceof ClaudeCliRunner) existing.runner.dispose();
    const runner = build();
    runners.set(id, { fingerprint: key, runner });
    return runner;
  };

  /** Throws the provider's own "how to fix" note when it cannot run right now. */
  const unavailable = (id: ProviderId, s: ResolvedSettings): string | undefined => {
    switch (id) {
      case "claude-code":
        return which(s.claude.path) ? undefined : `Claude Code CLI not found ("${s.claude.path}"). ${CLAUDE_INSTALL_HINT}`;
      case "codex":
        return which(s.codex.path) ? undefined : `Codex CLI not found ("${s.codex.path}"). ${CODEX_INSTALL_HINT}`;
      case "gemini-cli":
        return which(s.gemini.path) ? undefined : `Gemini CLI not found ("${s.gemini.path}"). ${GEMINI_INSTALL_HINT}`;
      case "openai":
        return s.openai.apiKey || !s.openai.official ? undefined : keyHint("OPENAI_API_KEY", "openai");
      case "anthropic":
        return s.anthropic.apiKey ? undefined : keyHint("ANTHROPIC_API_KEY", "anthropic");
      case "ollama":
        // Reachability needs a network round trip; the run reports "connection refused" itself.
        return undefined;
    }
  };

  const build = (id: ProviderId, s: ResolvedSettings): ILlmRunner => {
    switch (id) {
      case "claude-code":
        return cached(id, s.claude, () => new ClaudeCliRunner({ claudePath: s.claude.path, workDir: config.claudeWorkDir }));
      case "codex":
        return cached(id, s.codex.path, () => new CodexCliRunner({ codexPath: s.codex.path, workDir: join(workRoot, "aseprite-mcp-codex") }));
      case "gemini-cli":
        return cached(id, s.gemini.path, () => new GeminiCliRunner({ geminiPath: s.gemini.path, workDir: join(workRoot, "aseprite-mcp-gemini") }));
      case "openai": {
        const o = openAiSettings(s);
        return cached(id, o, () => new OpenAiCompatibleRunner(o, deps.agentOptions));
      }
      case "anthropic": {
        const a = {
          apiKey: s.anthropic.apiKey!,
          baseUrl: s.anthropic.baseUrl,
          defaultModel: s.anthropic.model ?? ANTHROPIC_DEFAULT_MODEL,
          authHint: keyHint("ANTHROPIC_API_KEY", "anthropic"),
        };
        return cached(id, a, () => new AnthropicApiRunner(a, deps.agentOptions));
      }
      case "ollama": {
        const o = ollamaSettings(s);
        return cached(id, o, () => new OpenAiCompatibleRunner(o, deps.agentOptions));
      }
    }
  };

  const describe = async (id: ProviderId, s: ResolvedSettings, configError?: string): Promise<ProviderInfo> => {
    const problem = unavailable(id, s);
    const withConfigError = (note?: string) =>
      configError && problem ? `${note ?? ""} (Config file ignored: ${configError})`.trim() : note;
    switch (id) {
      case "claude-code":
        return {
          id,
          label: "Claude Code (your subscription)",
          models: CLAUDE_CODE_MODELS,
          efforts: [...EFFORTS],
          available: !problem,
          note: withConfigError(problem),
          supportsImages: true,
          defaultModel: "opus",
        };
      case "codex": {
        const models = modelOptions(s.codex.models, undefined, CODEX_MODELS);
        return {
          id,
          label: "Codex (ChatGPT subscription)",
          models,
          efforts: ["low", "medium", "high", "xhigh"],
          available: !problem,
          note: withConfigError(problem ?? "Experimental: runs the OpenAI Codex CLI with your ChatGPT login."),
          supportsImages: true,
          defaultModel: models[0]?.id,
        };
      }
      case "gemini-cli": {
        const models = modelOptions(s.gemini.models, undefined, GEMINI_MODELS);
        return {
          id,
          label: "Gemini CLI (Google account)",
          models,
          efforts: [],
          available: !problem,
          note: withConfigError(problem ?? "Experimental: runs the Google Gemini CLI with your Google login."),
          supportsImages: false,
          defaultModel: models[0]?.id,
        };
      }
      case "openai": {
        const o = openAiSettings(s);
        let models = modelOptions(s.openai.models, s.openai.model, s.openai.official ? OPENAI_MODELS : []);
        let note = problem;
        if (!s.openai.official && !s.openai.models?.length && !problem) {
          const remote = await lister.list(o.baseUrl, o.apiKey);
          if (remote?.length) models = modelOptions(remote, s.openai.model, []);
          else if (!remote && models.length === 0) note = `Cannot reach ${o.baseUrl}. Is the server running?`;
        }
        if (!note && models.length === 0) note = `No model configured: set providers.openai.model in ${config.configFile} or OPENAI_MODEL.`;
        return {
          id,
          label: o.label,
          models,
          efforts: o.reasoningEffort ? effortsUpTo(o.maxReasoningEffort) : [],
          available: !problem && models.length > 0,
          note: withConfigError(note),
          supportsImages: o.vision,
          defaultModel: o.defaultModel ?? models[0]?.id,
        };
      }
      case "anthropic": {
        const models = modelOptions(s.anthropic.models, s.anthropic.model, ANTHROPIC_MODELS);
        return {
          id,
          label: "Anthropic API (API key)",
          models,
          efforts: [...EFFORTS],
          available: !problem,
          note: withConfigError(problem),
          supportsImages: true,
          defaultModel: s.anthropic.model ?? ANTHROPIC_DEFAULT_MODEL,
        };
      }
      case "ollama": {
        const remote = await lister.list(s.ollama.baseUrl);
        const models = remote ? modelOptions(s.ollama.models ?? remote, s.ollama.model, []) : [];
        const note = !remote
          ? `Ollama is not running at ${s.ollama.baseUrl}. Install it from https://ollama.com, then run \`ollama pull qwen3\`.`
          : models.length === 0
            ? "No local models yet: run `ollama pull qwen3` (any model with tool support works)."
            : "Local models must support tool calling; small models draw poorly.";
        return {
          id,
          label: "Ollama (local models)",
          models,
          efforts: [],
          available: !!remote && models.length > 0,
          note,
          supportsImages: s.ollama.vision ?? false,
          defaultModel: s.ollama.model ?? models[0]?.id,
        };
      }
    }
  };

  return {
    get defaultId(): string {
      const configured = settings().defaultProvider;
      return isProviderId(configured) ? configured : DEFAULT_PROVIDER;
    },

    async list() {
      const loaded = source.current();
      const s = resolveSettings(loaded.file, env, config.claudePath);
      return Promise.all(PROVIDER_IDS.map((id) => describe(id, s, loaded.error)));
    },

    runner(id: string): ILlmRunner {
      if (!isProviderId(id)) {
        throw new Error(`Unknown AI provider "${id}". Available: ${PROVIDER_IDS.join(", ")}.`);
      }
      const s = settings();
      const problem = unavailable(id, s);
      if (problem) throw new Error(problem);
      return build(id, s);
    },

    dispose() {
      for (const { runner } of runners.values()) {
        if (runner instanceof ClaudeCliRunner) runner.dispose();
      }
    },
  };
}
