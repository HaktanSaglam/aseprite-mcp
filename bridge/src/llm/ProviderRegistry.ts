import type { BridgeConfig } from "../config.js";
import { ClaudeCliRunner } from "./ClaudeCliRunner.js";
import type { ILlmRunner, IProviderRegistry, ProviderInfo } from "./LlmRunner.js";

const CLAUDE_CODE: ProviderInfo = {
  id: "claude-code",
  label: "Claude Code (your subscription)",
  models: [
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
  ],
  efforts: ["low", "medium", "high", "xhigh", "max"],
  available: true,
  supportsImages: true,
};

/** Builds every provider the bridge knows about from config + environment. */
export function createProviderRegistry(config: BridgeConfig): IProviderRegistry {
  const claude = new ClaudeCliRunner({ claudePath: config.claudePath, workDir: config.claudeWorkDir });
  return {
    defaultId: CLAUDE_CODE.id,
    async list() {
      return [CLAUDE_CODE];
    },
    runner(id: string): ILlmRunner {
      if (id !== CLAUDE_CODE.id) throw new Error(`Unknown AI provider "${id}"`);
      return claude;
    },
  };
}
