import { mkdirSync } from "node:fs";
import { CLAUDE_MCP_SERVER, claudeErrorMessage, claudeUserMessage, parseClaudeLine } from "./claudeStream.js";
import { JsonLineProcess, type ProcessOutput } from "./cli/JsonLineProcess.js";
import { which } from "./cli/which.js";
import type { ILlmRunner, LlmEvent, LlmRunRequest } from "./LlmRunner.js";

interface Options {
  /** Executable name or path of the Claude Code CLI. */
  claudePath: string;
  /** Empty working directory: keeps project CLAUDE.md files and file tools out of the run. */
  workDir: string;
  /** Keep the CLI process of a conversation alive between messages (default true). */
  warm?: boolean;
  /** A warm process with no new message for this long is stopped (default 10 min). */
  idleTimeoutMs?: number;
  /** Each warm process holds a few hundred MB, so only the most recent ones stay. */
  maxWarmProcesses?: number;
}

const TOOL_PATTERN = `mcp__${CLAUDE_MCP_SERVER}__*`;
const DEFAULT_IDLE_MS = 10 * 60_000;
const INSTALL_HINT =
  "Install it with `npm install -g @anthropic-ai/claude-code` and run `claude auth login`, or set CLAUDE_PATH to its full path.";

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

/** A CLI process can only continue a conversation started with the same flags. */
function processKey(request: LlmRunRequest): string {
  return JSON.stringify([request.model ?? "", request.effort ?? "", request.mcpUrl, request.systemPrompt]);
}

/** One running `claude -p --input-format stream-json` process. */
interface LiveProcess {
  proc: JsonLineProcess;
  key: string;
  sessionId?: string;
  /** Session cost already counted before this process's next turn. */
  costBaseline?: number;
  idleTimer?: NodeJS.Timeout;
}

/**
 * Runs the user's Claude Code CLI headless, restricted to this bridge's Aseprite tools.
 *
 * Speed: starting the CLI (Node boot, login check, MCP handshake) costs a second or more
 * per message. With stream-json input the process can take the next user message on
 * stdin, so each conversation keeps its process warm until it idles out; an aborted or
 * evicted conversation continues later with `--resume`.
 */
export class ClaudeCliRunner implements ILlmRunner {
  private readonly warmPool = new Map<string, LiveProcess>();
  /** Sessions this runner created, with their last known cumulative cost. */
  private readonly sessions = new Map<string, { totalCostUsd?: number }>();
  private readonly running = new Set<string>();

  constructor(private readonly options: Options) {
    mkdirSync(options.workDir, { recursive: true });
  }

  async *run(request: LlmRunRequest): AsyncIterable<LlmEvent> {
    // Session ids from another provider (or a previous bridge run) cannot be resumed here.
    const resumeId = request.sessionId && this.sessions.has(request.sessionId) ? request.sessionId : undefined;
    if (resumeId && this.running.has(resumeId)) {
      yield { type: "done", ok: false, error: "This conversation is still working on the previous message." };
      return;
    }
    const key = processKey(request);
    let live = resumeId ? this.takeWarm(resumeId, key) : undefined;
    if (!live) {
      if (resumeId) this.evict(resumeId);
      live = this.spawn(request, resumeId);
    }
    if (resumeId) this.running.add(resumeId);
    try {
      yield* this.turn(live, request);
    } finally {
      if (resumeId) this.running.delete(resumeId);
    }
  }

  /** Stops every warm process (bridge shutdown). */
  dispose(): void {
    for (const sessionId of [...this.warmPool.keys()]) this.evict(sessionId);
  }

  private spawn(request: LlmRunRequest, resumeId: string | undefined): LiveProcess {
    const mcpConfig = { mcpServers: { [CLAUDE_MCP_SERVER]: { type: "http", url: request.mcpUrl } } };
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--mcp-config", JSON.stringify(mcpConfig),
      "--strict-mcp-config",
      // No built-in tools (Bash, Edit, ...): the run may only touch Aseprite.
      "--tools", "",
      "--allowedTools", TOOL_PATTERN,
      "--setting-sources", "",
      "--append-system-prompt", request.systemPrompt,
    ];
    if (request.model) args.push("--model", request.model);
    if (request.effort) args.push("--effort", request.effort);
    if (resumeId) args.push("--resume", resumeId);

    const command = which(this.options.claudePath) ?? this.options.claudePath;
    const proc = new JsonLineProcess(command, args, { cwd: this.options.workDir, env: childEnv() });
    return {
      proc,
      key: processKey(request),
      sessionId: resumeId,
      costBaseline: resumeId ? this.sessions.get(resumeId)?.totalCostUsd : 0,
    };
  }

  private async *turn(live: LiveProcess, request: LlmRunRequest): AsyncGenerator<LlmEvent> {
    const keepWarm = (this.options.warm ?? true) && request.keepAlive !== false;
    live.proc.ref();
    live.proc.send(claudeUserMessage(request.prompt, request.images));
    // Without stdin EOF the CLI waits for another message; a one-shot run must close it.
    if (!keepWarm) live.proc.endInput();

    let reusable = false;
    try {
      for (;;) {
        const item = await live.proc.next(request.signal);
        if (item.kind === "aborted") {
          yield { type: "done", ok: false, error: "Stopped." };
          return;
        }
        if (item.kind === "exit") {
          yield { type: "done", ok: false, error: this.exitError(item, live.proc) };
          return;
        }
        const parsed = parseClaudeLine(item.value);
        if (!parsed) continue;
        if (parsed.kind === "session") {
          live.sessionId = parsed.sessionId;
          if (!this.sessions.has(parsed.sessionId)) this.sessions.set(parsed.sessionId, {});
          yield { type: "session", sessionId: parsed.sessionId };
          continue;
        }
        if (parsed.kind === "events") {
          yield* parsed.events;
          continue;
        }

        const { result } = parsed;
        const sessionId = parsed.sessionId ?? live.sessionId;
        let costUsd: number | undefined;
        if (result.totalCostUsd !== undefined) {
          if (live.costBaseline !== undefined && result.totalCostUsd >= live.costBaseline) {
            // Rounded: the difference of two cumulative floats carries noise like 0.000193309999.
            costUsd = Math.round((result.totalCostUsd - live.costBaseline) * 1e6) / 1e6;
          }
          live.costBaseline = result.totalCostUsd;
          if (sessionId) this.sessions.set(sessionId, { totalCostUsd: result.totalCostUsd });
        }
        reusable = result.ok;
        yield result.ok
          ? { type: "done", ok: true, stats: { ...result.stats, costUsd } }
          : { type: "done", ok: false, error: result.error, stats: { ...result.stats, costUsd } };
        return;
      }
    } finally {
      if (reusable && keepWarm && live.sessionId && !live.proc.exited) {
        this.parkWarm(live);
      } else {
        // A one-shot run closed stdin, so the CLI exits by itself once the session is saved.
        if (reusable && !keepWarm) await live.proc.waitForExit(3000);
        live.proc.kill();
      }
    }
  }

  private exitError(item: Extract<ProcessOutput, { kind: "exit" }>, proc: JsonLineProcess): string {
    if (item.spawnError?.code === "ENOENT") {
      return `Claude Code CLI not found ("${this.options.claudePath}"). ${INSTALL_HINT}`;
    }
    if (item.spawnError) return `Could not start Claude Code: ${item.spawnError.message}`;
    const diagnostics = proc.diagnostics;
    const friendly = claudeErrorMessage({}, diagnostics);
    if (friendly !== "Claude run failed") return friendly;
    return `claude exited with code ${item.code}: ${diagnostics.slice(-600) || "no output"}`;
  }

  private takeWarm(sessionId: string, key: string): LiveProcess | undefined {
    const live = this.warmPool.get(sessionId);
    if (!live || live.key !== key || live.proc.exited) return undefined;
    this.warmPool.delete(sessionId);
    clearTimeout(live.idleTimer);
    return live;
  }

  private parkWarm(live: LiveProcess): void {
    const sessionId = live.sessionId!;
    this.evict(sessionId);
    this.warmPool.set(sessionId, live);
    live.proc.unref();
    live.idleTimer = setTimeout(() => this.evict(sessionId), this.options.idleTimeoutMs ?? DEFAULT_IDLE_MS);
    live.idleTimer.unref();
    const max = this.options.maxWarmProcesses ?? 3;
    // Map iteration order is insertion order, so the first entries are the least recently used.
    for (const oldest of this.warmPool.keys()) {
      if (this.warmPool.size <= max) break;
      this.evict(oldest);
    }
  }

  private evict(sessionId: string): void {
    const live = this.warmPool.get(sessionId);
    if (!live) return;
    this.warmPool.delete(sessionId);
    clearTimeout(live.idleTimer);
    live.proc.kill();
  }
}
