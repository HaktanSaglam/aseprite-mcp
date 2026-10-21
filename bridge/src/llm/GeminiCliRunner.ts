import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchMcpInstructions, firstTurnPrompt, type InstructionsSource } from "./cli/firstTurnPrompt.js";
import { JsonLineProcess } from "./cli/JsonLineProcess.js";
import { which } from "./cli/which.js";
import { geminiArgs, geminiErrorMessage, geminiSettings, GeminiStreamParser } from "./geminiEvents.js";
import type { ILlmRunner, LlmEvent, LlmRunRequest } from "./LlmRunner.js";

interface Options {
  /** Executable name or path of the Google Gemini CLI. */
  geminiPath: string;
  /** Stable working directory: Gemini stores sessions per project folder. */
  workDir: string;
  instructions?: InstructionsSource;
}

export const GEMINI_INSTALL_HINT =
  "Install it with `npm install -g @google/gemini-cli` and run `gemini` once to sign in, or set GEMINI_PATH.";

/**
 * EXPERIMENTAL. Runs the Google Gemini CLI headless (`--output-format stream-json`) with
 * the user's Google login, limited to this bridge's MCP server. Follow-ups use `--resume`.
 */
export class GeminiCliRunner implements ILlmRunner {
  private readonly sessions = new Set<string>();
  private readonly instructions: InstructionsSource;

  constructor(private readonly options: Options) {
    mkdirSync(options.workDir, { recursive: true });
    this.instructions = options.instructions ?? fetchMcpInstructions;
  }

  async *run(request: LlmRunRequest): AsyncIterable<LlmEvent> {
    const started = Date.now();
    const resumeId = request.sessionId && this.sessions.has(request.sessionId) ? request.sessionId : undefined;
    const prompt = resumeId
      ? request.prompt
      : firstTurnPrompt(request.systemPrompt, await this.instructions(request.mcpUrl), request.prompt);

    // One settings file per run: parallel jobs use different MCP endpoints.
    const settingsDir = join(this.options.workDir, ".runs");
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, `${randomUUID()}.json`);
    writeFileSync(settingsPath, JSON.stringify(geminiSettings(request.mcpUrl), null, 2));

    const proc = new JsonLineProcess(
      which(this.options.geminiPath) ?? this.options.geminiPath,
      geminiArgs({ prompt, model: request.model, resumeId }),
      {
        cwd: this.options.workDir,
        env: { ...process.env, GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath, GEMINI_CLI_TRUST_WORKSPACE: "true" },
        stdin: "ignore",
      },
    );

    const parser = new GeminiStreamParser();
    let lastError: string | undefined;
    let finished = false;
    try {
      for (;;) {
        const item = await proc.next(request.signal);
        if (item.kind === "aborted") {
          yield { type: "done", ok: false, error: "Stopped." };
          return;
        }
        if (item.kind === "exit") {
          for (const line of parser.flush()) if (line.kind === "events") yield* line.events;
          if (item.spawnError?.code === "ENOENT") {
            yield { type: "done", ok: false, error: `Gemini CLI not found ("${this.options.geminiPath}"). ${GEMINI_INSTALL_HINT}` };
          } else {
            const detail = lastError ?? (proc.diagnostics.slice(-600) || `gemini exited with code ${item.code}`);
            yield { type: "done", ok: false, error: geminiErrorMessage(detail), stats: { durationMs: Date.now() - started } };
          }
          return;
        }
        for (const line of parser.push(item.value)) {
          if (line.kind === "events") {
            for (const event of line.events) {
              if (event.type === "session") this.sessions.add(event.sessionId);
              yield event;
            }
          } else if (line.kind === "error") {
            lastError = line.message;
          } else {
            const stats = { ...line.stats, durationMs: line.stats.durationMs ?? Date.now() - started };
            finished = true;
            yield line.ok
              ? { type: "done", ok: true, stats }
              : { type: "done", ok: false, error: line.error ?? geminiErrorMessage(lastError ?? ""), stats };
            return;
          }
        }
      }
    } finally {
      // After its result the CLI still writes the session that a follow-up resumes.
      if (finished) await proc.waitForExit(3000);
      proc.kill();
      rmSync(settingsPath, { force: true });
    }
  }
}
