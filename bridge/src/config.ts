import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface BridgeConfig {
  /** Loopback only: nothing outside this machine should be able to drive Aseprite. */
  host: string;
  mcpPort: number;
  asepritePort: number;
  requestTimeoutMs: number;
  claudePath: string;
  /** Empty working directory for CLI runs (keeps project files and CLAUDE.md out). */
  claudeWorkDir: string;
  /** Optional JSON file with provider settings (API keys, base URLs, default models). */
  configFile: string;
  /** How many model runs may draw at the same time (parallel variations / batches). */
  maxParallelRuns: number;
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  return {
    host: "127.0.0.1",
    mcpPort: intFromEnv(env.ASEPRITE_MCP_PORT, 7800),
    asepritePort: intFromEnv(env.ASEPRITE_WS_PORT, 7801),
    requestTimeoutMs: intFromEnv(env.ASEPRITE_REQUEST_TIMEOUT_MS, 30_000),
    claudePath: env.CLAUDE_PATH ?? "claude",
    claudeWorkDir: env.ASEPRITE_CLAUDE_WORKDIR ?? join(tmpdir(), "aseprite-mcp-claude"),
    configFile: env.ASEPRITE_MCP_CONFIG ?? join(homedir(), ".aseprite-mcp", "config.json"),
    maxParallelRuns: Math.max(1, intFromEnv(env.ASEPRITE_MAX_PARALLEL, 4)),
  };
}
