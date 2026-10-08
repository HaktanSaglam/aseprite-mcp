import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import type { ILlmRunner, LlmEvent, LlmRunRequest } from "./LlmRunner.js";

interface Options {
  /** Executable name or path of the Claude Code CLI. */
  claudePath: string;
  /** MCP endpoint of this bridge, so the headless run can draw in Aseprite. */
  mcpUrl: string;
  /** Empty working directory: keeps project CLAUDE.md files and file tools out of the run. */
  workDir: string;
  systemPrompt: string;
}

const MCP_SERVER_NAME = "aseprite";
const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/**
 * Variables that mark "running inside another Claude Code session". Inheriting them
 * (e.g. when the bridge is started from a Claude terminal) makes the child use the
 * parent's short-lived credentials instead of the user's own login.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) delete env[key];
  }
  return env;
}

/** One line of `claude -p --output-format stream-json` mapped to zero or more UI events. */
function mapStreamLine(msg: any): LlmEvent[] {
  if (msg.type === "system" && msg.subtype === "init") {
    return [{ type: "session", sessionId: msg.session_id }];
  }
  if (msg.type === "system" && msg.subtype === "api_retry") {
    return [{ type: "retry", attempt: msg.attempt, reason: String(msg.error ?? msg.error_status) }];
  }
  // "<synthetic>" messages are the CLI echoing its own errors; the result line reports those.
  if (msg.type === "assistant" && msg.message?.model !== "<synthetic>") {
    const events: LlmEvent[] = [];
    for (const block of msg.message?.content ?? []) {
      if (block.type === "text" && block.text.trim()) events.push({ type: "text", text: block.text });
      if (block.type === "tool_use") {
        events.push({ type: "tool", name: String(block.name).replace(TOOL_PREFIX, "") });
      }
    }
    return events;
  }
  if (msg.type === "result") {
    if (!msg.is_error) return [{ type: "done", ok: true }];
    const error =
      msg.api_error_status === 401
        ? "Claude CLI login expired. Run `claude auth login` in Terminal, then try again."
        : String(msg.result ?? msg.subtype ?? "Claude run failed");
    return [{ type: "done", ok: false, error }];
  }
  return [];
}

/** Runs the user's Claude Code CLI headless, restricted to this bridge's Aseprite tools. */
export class ClaudeCliRunner implements ILlmRunner {
  constructor(private readonly options: Options) {
    mkdirSync(options.workDir, { recursive: true });
  }

  async *run(request: LlmRunRequest): AsyncIterable<LlmEvent> {
    const mcpConfig = { mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: this.options.mcpUrl } } };
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--mcp-config", JSON.stringify(mcpConfig),
      "--strict-mcp-config",
      // No built-in tools (Bash, Edit, ...): the run may only touch Aseprite.
      "--tools", "",
      "--allowedTools", `${TOOL_PREFIX}*`,
      "--setting-sources", "",
      "--append-system-prompt", this.options.systemPrompt,
    ];
    if (request.model) args.push("--model", request.model);
    if (request.sessionId) args.push("--resume", request.sessionId);

    const child = spawn(this.options.claudePath, args, {
      cwd: this.options.workDir,
      env: childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const onAbort = () => child.kill("SIGTERM");
    request.signal?.addEventListener("abort", onAbort, { once: true });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
      child.on("error", (error: NodeJS.ErrnoException) => {
        stderr +=
          error.code === "ENOENT"
            ? `Claude Code CLI not found ("${this.options.claudePath}"). Install it or set CLAUDE_PATH.`
            : error.message;
        resolve(null);
      });
    });

    // Prompt via stdin rather than argv: no quoting issues, no length limits.
    child.stdin.end(request.prompt);

    let finished = false;
    try {
      for await (const line of createInterface({ input: child.stdout })) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        for (const event of mapStreamLine(parsed)) {
          if (event.type === "done") finished = true;
          yield event;
        }
      }
      const code = await exited;
      if (!finished) {
        yield {
          type: "done",
          ok: false,
          error: request.signal?.aborted
            ? "Stopped."
            : `claude exited with code ${code}: ${stderr.trim() || "no output"}`,
        };
      }
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null) child.kill("SIGTERM");
    }
  }
}
