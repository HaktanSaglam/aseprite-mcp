import type { LlmEvent, RunStats } from "./LlmRunner.js";
import { singleLineOnWindows } from "./cli/argv.js";

export const GEMINI_MCP_SERVER = "aseprite";

/**
 * Built-in tools that could touch files, run commands or browse; a run may only draw.
 * Names differ between Gemini CLI versions, so both spellings are listed.
 */
const BUILTIN_TOOLS = [
  "run_shell_command", "ShellTool",
  "write_file", "WriteFileTool",
  "replace", "edit", "EditTool",
  "read_file", "ReadFileTool",
  "read_many_files", "ReadManyFilesTool",
  "list_directory", "LSTool",
  "glob", "GlobTool",
  "search_file_content", "grep", "GrepTool",
  "web_fetch", "WebFetchTool",
  "google_web_search", "WebSearchTool",
  "save_memory", "MemoryTool",
  "write_todos",
];

/**
 * Settings for one run, passed as the "system" settings file so they win over the user's
 * own settings and apply even though the run's folder is not a trusted workspace.
 */
export function geminiSettings(mcpUrl: string) {
  return {
    mcpServers: {
      [GEMINI_MCP_SERVER]: { httpUrl: mcpUrl, trust: true, timeout: 600_000 },
    },
    mcp: { allowed: [GEMINI_MCP_SERVER] },
    tools: { exclude: BUILTIN_TOOLS },
    general: { checkpointing: { enabled: false } },
  };
}

export interface GeminiArgsInput {
  prompt: string;
  model?: string;
  resumeId?: string;
}

export function geminiArgs(input: GeminiArgsInput): string[] {
  // `--prompt=` keeps a prompt that starts with "-" from being read as a flag.
  const args = [
    `--prompt=${singleLineOnWindows(input.prompt)}`,
    "--output-format", "stream-json",
    "--approval-mode", "yolo",
    "--allowed-mcp-server-names", GEMINI_MCP_SERVER,
  ];
  if (input.model) args.push("--model", input.model);
  if (input.resumeId) args.push("--resume", input.resumeId);
  return args;
}

const LOGIN_HINT =
  "Gemini CLI is not signed in. Run `gemini` once in Terminal and choose \"Login with Google\" (or set GEMINI_API_KEY), then try again.";

export function geminiErrorMessage(message: string): string {
  if (/auth method|not authenticated|login|GEMINI_API_KEY|401|unauthenticated|credentials/i.test(message)) return LOGIN_HINT;
  if (/quota|rate.?limit|429|resource.?exhausted/i.test(message)) return `Gemini usage limit reached: ${message.trim()}`;
  return message.trim() || "Gemini run failed";
}

export type GeminiLine =
  | { kind: "events"; events: LlmEvent[] }
  | { kind: "result"; ok: boolean; error?: string; stats: Omit<RunStats, "durationMs"> & { durationMs?: number } }
  | { kind: "error"; message: string };

const TOOL_PREFIXES = [`mcp_${GEMINI_MCP_SERVER}_`, `${GEMINI_MCP_SERVER}__`];

function toolName(name: string): string {
  for (const prefix of TOOL_PREFIXES) if (name.startsWith(prefix)) return name.slice(prefix.length);
  return name;
}

/**
 * Stateful parser for `gemini --output-format stream-json`: assistant text arrives as
 * deltas, which are joined into one chat message per answer instead of one per token.
 */
export class GeminiStreamParser {
  private pendingText = "";

  /** Unknown event types are ignored so newer Gemini CLI versions keep working. */
  push(msg: any): GeminiLine[] {
    switch (msg?.type) {
      case "init":
        return typeof msg.session_id === "string"
          ? [{ kind: "events", events: [{ type: "session", sessionId: msg.session_id }] }]
          : [];
      case "message": {
        if (msg.role !== "assistant" || typeof msg.content !== "string") return [];
        if (msg.delta) {
          this.pendingText += msg.content;
          return [];
        }
        return [...this.flush(), ...this.textLine(msg.content)];
      }
      case "tool_use":
        return [...this.flush(), { kind: "events", events: [{ type: "tool", name: toolName(String(msg.tool_name ?? "tool")) }] }];
      case "error":
        return msg.severity === "error" && typeof msg.message === "string" ? [{ kind: "error", message: msg.message }] : [];
      case "result": {
        const stats = msg.stats ?? {};
        const line: GeminiLine = {
          kind: "result",
          ok: msg.status === "success",
          error: msg.status === "success" ? undefined : geminiErrorMessage(String(msg.error?.message ?? "Gemini run failed")),
          stats: {
            durationMs: typeof stats.duration_ms === "number" ? stats.duration_ms : undefined,
            inputTokens: Number(stats.input_tokens) || 0,
            outputTokens: Number(stats.output_tokens) || 0,
          },
        };
        return [...this.flush(), line];
      }
      default:
        return [];
    }
  }

  /** Text still buffered when the stream ends without a result line. */
  flush(): GeminiLine[] {
    const text = this.pendingText;
    this.pendingText = "";
    return this.textLine(text);
  }

  private textLine(text: string): GeminiLine[] {
    return text.trim() ? [{ kind: "events", events: [{ type: "text", text: text.trim() }] }] : [];
  }
}
