import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexArgs, codexErrorMessage, parseCodexLine } from "./codexEvents.js";
import { fetchMcpInstructions, firstTurnPrompt, type InstructionsSource } from "./cli/firstTurnPrompt.js";
import { JsonLineProcess } from "./cli/JsonLineProcess.js";
import { which } from "./cli/which.js";
import type { ILlmRunner, LlmEvent, LlmRunRequest, RunStats } from "./LlmRunner.js";

interface Options {
  /** Executable name or path of the OpenAI Codex CLI. */
  codexPath: string;
  /** Empty working directory for runs; attached images are written below it. */
  workDir: string;
  instructions?: InstructionsSource;
}

export const CODEX_INSTALL_HINT = "Install it with `npm install -g @openai/codex` and run `codex login`, or set CODEX_PATH.";

/**
 * EXPERIMENTAL. Runs the OpenAI Codex CLI (`codex exec --json`) with the user's ChatGPT
 * login, pointed at this bridge's MCP endpoint. Each message is one process; follow-ups
 * use `codex exec resume <thread id>`.
 */
export class CodexCliRunner implements ILlmRunner {
  private readonly sessions = new Set<string>();
  private readonly instructions: InstructionsSource;

  constructor(private readonly options: Options) {
    mkdirSync(options.workDir, { recursive: true });
    this.instructions = options.instructions ?? fetchMcpInstructions;
  }

  async *run(request: LlmRunRequest): AsyncIterable<LlmEvent> {
    const started = Date.now();
    // Thread ids from another provider (or an earlier bridge run) cannot be resumed here.
    const resumeId = request.sessionId && this.sessions.has(request.sessionId) ? request.sessionId : undefined;
    const prompt = resumeId
      ? request.prompt
      : firstTurnPrompt(request.systemPrompt, await this.instructions(request.mcpUrl), request.prompt);
    const imagePaths = this.writeImages(request);

    const proc = new JsonLineProcess(
      which(this.options.codexPath) ?? this.options.codexPath,
      codexArgs({ prompt, mcpUrl: request.mcpUrl, model: request.model, effort: request.effort, resumeId, imagePaths }),
      { cwd: this.options.workDir, env: process.env, stdin: "ignore" },
    );

    let completed: Omit<RunStats, "durationMs"> | undefined;
    let failure: string | undefined;
    let lastError: string | undefined;
    try {
      for (;;) {
        const item = await proc.next(request.signal);
        if (item.kind === "aborted") {
          yield { type: "done", ok: false, error: "Stopped." };
          return;
        }
        if (item.kind === "exit") {
          const durationMs = Date.now() - started;
          if (completed && !failure) {
            yield { type: "done", ok: true, stats: { durationMs, ...completed } };
          } else if (item.spawnError?.code === "ENOENT") {
            yield { type: "done", ok: false, error: `Codex CLI not found ("${this.options.codexPath}"). ${CODEX_INSTALL_HINT}` };
          } else {
            const error = failure ?? (lastError ? codexErrorMessage(lastError) : undefined) ??
              codexErrorMessage(proc.diagnostics.slice(-600) || `codex exited with code ${item.code}`);
            yield { type: "done", ok: false, error, stats: { durationMs } };
          }
          return;
        }
        const line = parseCodexLine(item.value);
        if (!line) continue;
        switch (line.kind) {
          case "events":
            for (const event of line.events) {
              if (event.type === "session") this.sessions.add(event.sessionId);
              yield event;
            }
            break;
          case "turn_completed":
            completed = { turns: 1, inputTokens: line.inputTokens, outputTokens: line.outputTokens };
            break;
          case "turn_failed":
            failure = line.error;
            break;
          case "error":
            lastError = line.message;
            break;
        }
      }
    } finally {
      proc.kill();
      for (const path of imagePaths) rmSync(path, { force: true });
    }
  }

  private writeImages(request: LlmRunRequest): string[] {
    if (!request.images?.length) return [];
    const dir = join(this.options.workDir, "images");
    mkdirSync(dir, { recursive: true });
    return request.images.map((image) => {
      const path = join(dir, `${randomUUID()}.png`);
      writeFileSync(path, Buffer.from(image.base64, "base64"));
      return path;
    });
  }
}
