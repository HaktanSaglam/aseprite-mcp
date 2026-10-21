import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface BridgeConfig {
  /** Reported to the Aseprite UI in bridge_info. */
  version: string;
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
  /** Port of the development endpoint (src/dev), or undefined when ASEPRITE_MCP_DEV is off. */
  devPort?: number;
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** package.json sits one level above both src/ (tsx) and dist/ (node), so one path serves both. */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  return {
    version: packageVersion(),
    host: "127.0.0.1",
    mcpPort: intFromEnv(env.ASEPRITE_MCP_PORT, 7800),
    asepritePort: intFromEnv(env.ASEPRITE_WS_PORT, 7801),
    requestTimeoutMs: intFromEnv(env.ASEPRITE_REQUEST_TIMEOUT_MS, 30_000),
    claudePath: env.CLAUDE_PATH ?? "claude",
    claudeWorkDir: env.ASEPRITE_CLAUDE_WORKDIR ?? join(tmpdir(), "aseprite-mcp-claude"),
    configFile: env.ASEPRITE_MCP_CONFIG ?? join(homedir(), ".aseprite-mcp", "config.json"),
    // Each run is a model process of its own; dozens at once only hit rate limits and memory.
    maxParallelRuns: Math.min(8, Math.max(1, intFromEnv(env.ASEPRITE_MAX_PARALLEL, 4))),
    devPort: env.ASEPRITE_MCP_DEV === "1" ? intFromEnv(env.ASEPRITE_MCP_DEV_PORT, 7802) : undefined,
  };
}
