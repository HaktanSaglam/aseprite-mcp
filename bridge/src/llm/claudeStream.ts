import type { LlmEvent, LlmImage, RunStats } from "./LlmRunner.js";

export const CLAUDE_MCP_SERVER = "aseprite";
const TOOL_PREFIX = `mcp__${CLAUDE_MCP_SERVER}__`;

/** One `--input-format stream-json` line: the prompt and its images as a single user turn. */
export function claudeUserMessage(prompt: string, images: LlmImage[] = []) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        // Images first: the model reads the canvas before the instruction about it.
        ...images.map((image) => ({
          type: "image",
          source: { type: "base64", media_type: image.mediaType, data: image.base64 },
        })),
        { type: "text", text: prompt },
      ],
    },
  };
}

/** What a `result` line says about the finished turn. */
export interface ClaudeResult {
  ok: boolean;
  error?: string;
  stats: Omit<RunStats, "costUsd">;
  /** Cumulative for the whole session (it even survives --resume), not per turn. */
  totalCostUsd?: number;
}

export type ClaudeLine =
  | { kind: "session"; sessionId: string }
  | { kind: "events"; events: LlmEvent[] }
  | { kind: "result"; sessionId?: string; result: ClaudeResult };

const LOGIN_HINT = "Claude Code is not logged in (or the login expired). Run `claude auth login` in Terminal, then try again.";

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Turns the CLI's error results into something the user can act on. */
export function claudeErrorMessage(msg: any, diagnostics = ""): string {
  const text = String(msg?.result ?? msg?.errors?.[0] ?? msg?.subtype ?? "").trim();
  const haystack = `${text}\n${diagnostics}`;
  if (msg?.api_error_status === 401 || /invalid api key|please run \/login|not logged in|oauth token (has )?expired|authentication_error/i.test(haystack)) {
    return LOGIN_HINT;
  }
  if (msg?.api_error_status === 429 || /usage limit|rate.?limit|limit reached|5-hour limit|weekly limit/i.test(haystack)) {
    return `Claude usage limit reached${text ? `: ${text}` : ""}. Wait for the limit to reset or pick a smaller model.`;
  }
  if (msg?.subtype === "error_max_turns") return "Stopped: the run reached its turn limit. Send \"continue\" to keep going.";
  if (msg?.api_error_status === 529 || /overloaded/i.test(haystack)) {
    return "Claude is overloaded right now. Try again in a minute.";
  }
  return text || "Claude run failed";
}

/**
 * Maps one stdout line of `claude -p --output-format stream-json` to what the runner
 * needs. Unknown line types are ignored so newer CLI versions keep working.
 */
export function parseClaudeLine(msg: any): ClaudeLine | undefined {
  if (!msg || typeof msg !== "object") return undefined;
  if (msg.type === "system" && msg.subtype === "init" && typeof msg.session_id === "string") {
    return { kind: "session", sessionId: msg.session_id };
  }
  if (msg.type === "system" && msg.subtype === "api_retry") {
    return {
      kind: "events",
      events: [{ type: "retry", attempt: num(msg.attempt), reason: String(msg.error ?? msg.error_status ?? "API error") }],
    };
  }
  // "<synthetic>" messages are the CLI echoing its own errors; the result line reports those.
  if (msg.type === "assistant" && msg.message?.model !== "<synthetic>" && !msg.parent_tool_use_id) {
    const events: LlmEvent[] = [];
    for (const block of msg.message?.content ?? []) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        events.push({ type: "text", text: block.text });
      }
      if (block?.type === "tool_use" && typeof block.name === "string") {
        events.push({ type: "tool", name: block.name.replace(TOOL_PREFIX, "") });
      }
    }
    return events.length ? { kind: "events", events } : undefined;
  }
  if (msg.type === "result") {
    const usage = msg.usage ?? {};
    const stats: ClaudeResult["stats"] = {
      durationMs: num(msg.duration_ms),
      turns: typeof msg.num_turns === "number" ? msg.num_turns : undefined,
      // Cached prompt tokens are still prompt tokens; showing only `input_tokens` would read as ~0.
      inputTokens: num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens),
      outputTokens: num(usage.output_tokens),
    };
    const totalCostUsd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined;
    const sessionId = typeof msg.session_id === "string" ? msg.session_id : undefined;
    // Some failures ("error_max_turns", "error_during_execution") only show in the subtype.
    const failed = msg.is_error === true || String(msg.subtype ?? "").startsWith("error");
    const result: ClaudeResult = failed
      ? { ok: false, error: claudeErrorMessage(msg), stats, totalCostUsd }
      : { ok: true, stats, totalCostUsd };
    return { kind: "result", sessionId, result };
  }
  return undefined;
}
