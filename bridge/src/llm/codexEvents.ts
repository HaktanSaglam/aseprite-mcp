import type { Effort, LlmEvent } from "./LlmRunner.js";
import { singleLineOnWindows } from "./cli/argv.js";

export const CODEX_MCP_SERVER = "aseprite";

/** What one `codex exec --json` line means for the run. */
export type CodexLine =
  | { kind: "events"; events: LlmEvent[] }
  | { kind: "turn_completed"; inputTokens: number; outputTokens: number }
  | { kind: "turn_failed"; error: string }
  | { kind: "error"; message: string };

const LOGIN_HINT = "Codex is not signed in. Run `codex login` in Terminal (ChatGPT account or API key), then try again.";

/** Turns Codex errors into something the user can act on. */
export function codexErrorMessage(message: string): string {
  if (/401|unauthori[sz]ed|not logged in|login required|codex login|invalid api key|token.*expired/i.test(message)) return LOGIN_HINT;
  if (/usage limit|rate.?limit|429|quota/i.test(message)) {
    return `Codex usage limit reached: ${message.trim()}`;
  }
  return message.trim() || "Codex run failed";
}

function itemType(item: any): string {
  // Before v0.44 the field was `item_type` and agent messages were "assistant_message".
  const type = String(item?.type ?? item?.item_type ?? "");
  return type === "assistant_message" ? "agent_message" : type;
}

/**
 * Maps one line of `codex exec --json` (thread.* / turn.* / item.* / error events).
 * Unknown events and item types are ignored so newer Codex versions keep working.
 */
export function parseCodexLine(msg: any): CodexLine | undefined {
  switch (msg?.type) {
    case "thread.started":
      return typeof msg.thread_id === "string"
        ? { kind: "events", events: [{ type: "session", sessionId: msg.thread_id }] }
        : undefined;
    case "item.started": {
      const item = msg.item;
      if (itemType(item) === "mcp_tool_call" && typeof item.tool === "string") {
        return { kind: "events", events: [{ type: "tool", name: item.tool }] };
      }
      if (itemType(item) === "command_execution") return { kind: "events", events: [{ type: "tool", name: "shell" }] };
      return undefined;
    }
    case "item.completed": {
      const item = msg.item;
      if (itemType(item) === "agent_message" && typeof item.text === "string" && item.text.trim()) {
        return { kind: "events", events: [{ type: "text", text: item.text.trim() }] };
      }
      if (itemType(item) === "error" && typeof item.message === "string") return { kind: "error", message: item.message };
      return undefined;
    }
    case "turn.completed": {
      const usage = msg.usage ?? {};
      return { kind: "turn_completed", inputTokens: Number(usage.input_tokens) || 0, outputTokens: Number(usage.output_tokens) || 0 };
    }
    case "turn.failed":
      return { kind: "turn_failed", error: codexErrorMessage(String(msg.error?.message ?? "Codex turn failed")) };
    case "error": {
      const message = String(msg.message ?? "");
      // Transient stream errors ("Reconnecting... 2/5") are retries, not failures.
      const retry = /reconnecting.*?(\d+)\s*\/\s*\d+/i.exec(message);
      if (retry) return { kind: "events", events: [{ type: "retry", attempt: Number(retry[1]), reason: message }] };
      return { kind: "error", message };
    }
    default:
      return undefined;
  }
}

/** Codex's `model_reasoning_effort`; it has no "max", so the UI's max maps to its highest. */
export function codexEffort(effort: Effort): string {
  return effort === "max" ? "xhigh" : effort;
}

function toml(value: string): string {
  return JSON.stringify(value);
}

/** clap would read a prompt that starts with "-" as a flag; a leading space is harmless. */
function positional(text: string): string {
  const line = singleLineOnWindows(text);
  return line.startsWith("-") ? ` ${line}` : line;
}

export interface CodexArgsInput {
  prompt: string;
  mcpUrl: string;
  model?: string;
  effort?: Effort;
  resumeId?: string;
  imagePaths?: string[];
}

/**
 * `codex [-c overrides] exec --json ... [resume <id>] [-i img] <prompt>`.
 * Config overrides go before the subcommand, where every Codex version accepts them.
 */
export function codexArgs(input: CodexArgsInput): string[] {
  const server = `mcp_servers.${CODEX_MCP_SERVER}`;
  const args = [
    "-c", `${server}.url=${toml(input.mcpUrl)}`,
    // Tool calls must not wait for an approval nobody can give in headless mode.
    "-c", `${server}.default_tools_approval_mode="approve"`,
    "-c", `${server}.startup_timeout_sec=30`,
    "-c", `${server}.tool_timeout_sec=600`,
    "-c", `approval_policy="never"`,
  ];
  if (input.effort) args.push("-c", `model_reasoning_effort=${toml(codexEffort(input.effort))}`);
  args.push("exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only");
  if (input.model) args.push("-m", input.model);
  if (input.resumeId) args.push("resume", input.resumeId);
  for (const path of input.imagePaths ?? []) args.push("-i", path);
  args.push(positional(input.prompt));
  return args;
}
