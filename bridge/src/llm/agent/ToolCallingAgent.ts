import { createHash, randomUUID } from "node:crypto";
import { ProviderHttpError } from "../http/httpJson.js";
import type { ILlmRunner, LlmEvent, LlmRunRequest } from "../LlmRunner.js";
import { connectMcpToolHost } from "./McpToolHost.js";
import type { IChatModel, IToolHost, ModelTurn, ToolCall, ToolHostFactory, ToolOutcome, ToolResult } from "./types.js";

export interface AgentOptions {
  connect?: ToolHostFactory;
  /** Model calls per user message before the loop stops and asks the user to continue. */
  maxSteps?: number;
  /** Conversations kept in memory; the least recently used are forgotten first. */
  maxSessions?: number;
  /** Retries for rate limits, overload and network hiccups. */
  maxRetries?: number;
  /** Test seam: how long to wait before retry number `attempt` (1-based). */
  retryDelayMs?: (attempt: number, error: ProviderHttpError) => number;
}

interface Session<M> {
  id: string;
  history: M[];
  /** Hash of the system prompt + tool list the history was built with. */
  contextHash?: string;
  busy: boolean;
}

// The CLIs bring their own agent prompt; API models start from nothing.
const AGENT_PROMPT = `
You are a pixel-art assistant working directly inside the user's Aseprite through the tools
you have. Do the work with the tools instead of describing it, check your result with a
preview tool when one is available, and keep replies short and plain.
`.trim();

const CANCELLED: ToolOutcome = { text: "Cancelled: the user stopped the run.", images: [], isError: true };

function hashContext(systemPrompt: string, tools: unknown): string {
  return createHash("sha256").update(systemPrompt).update(JSON.stringify(tools)).digest("hex");
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function composeSystemPrompt(serverInstructions: string | undefined, requestPrompt: string): string {
  return [AGENT_PROMPT, serverInstructions?.trim(), requestPrompt.trim()].filter(Boolean).join("\n\n");
}

/**
 * API providers have no agent of their own (unlike the Claude Code / Codex / Gemini CLIs),
 * so this is the agent: it gives the model the bridge's MCP tools and loops
 * model → tool calls → results until the model answers without calling a tool.
 * Conversations live in memory, keyed by the session id it reports, so follow-ups work.
 */
export class ToolCallingAgent<M> implements ILlmRunner {
  private readonly sessions = new Map<string, Session<M>>();
  private readonly connect: ToolHostFactory;

  constructor(
    private readonly model: IChatModel<M>,
    private readonly options: AgentOptions = {},
  ) {
    this.connect = options.connect ?? connectMcpToolHost;
  }

  async *run(request: LlmRunRequest): AsyncIterable<LlmEvent> {
    const started = Date.now();
    const session = this.openSession(request.sessionId);
    yield { type: "session", sessionId: session.id };
    if (session.busy) {
      yield { type: "done", ok: false, error: "This conversation is still working on the previous message." };
      return;
    }

    session.busy = true;
    const usage = { inputTokens: 0, outputTokens: 0 };
    let steps = 0;
    let host: IToolHost | undefined;
    const stats = () => ({ durationMs: Date.now() - started, turns: steps, ...usage });
    try {
      host = await this.connect(request.mcpUrl);
      const systemPrompt = composeSystemPrompt(host.instructions, request.systemPrompt);
      const contextHash = hashContext(systemPrompt, host.tools);
      const contextChanged = session.contextHash !== undefined && session.contextHash !== contextHash;
      session.contextHash = contextHash;
      session.history = this.model.compact(session.history, { phase: "run_start", contextChanged });
      const historyBeforeRun = session.history.length;
      session.history.push(...this.model.userTurn(request.prompt, request.images ?? []));

      const maxSteps = this.options.maxSteps ?? 40;
      for (;;) {
        if (request.signal?.aborted) throw request.signal.reason ?? new Error("Stopped.");
        if (steps >= maxSteps) {
          yield {
            type: "done",
            ok: false,
            error: `Stopped after ${maxSteps} steps to keep the run bounded. Say "continue" to keep going.`,
            stats: stats(),
          };
          return;
        }
        steps++;
        const turn: ModelTurn<M> = yield* this.completeWithRetry(session, host, systemPrompt, request);
        if (turn.message !== undefined) session.history.push(turn.message);
        if (turn.usage) {
          usage.inputTokens += turn.usage.inputTokens;
          usage.outputTokens += turn.usage.outputTokens;
        }
        for (const text of turn.texts) if (text.trim()) yield { type: "text", text: text.trim() };

        if (turn.toolCalls.length === 0 || turn.message === undefined) {
          // A message declined outright would be declined again inside every follow-up.
          if (turn.message === undefined && turn.error && steps === 1) session.history.length = historyBeforeRun;
          yield turn.error
            ? { type: "done", ok: false, error: turn.error, stats: stats() }
            : { type: "done", ok: true, stats: stats() };
          return;
        }

        const results: ToolResult[] = [];
        for (const call of turn.toolCalls) {
          if (request.signal?.aborted) {
            results.push({ call, outcome: CANCELLED });
            continue;
          }
          yield { type: "tool", name: call.name };
          results.push({ call, outcome: await this.execute(host, call, request.signal) });
        }
        // Every tool call needs its result in the history, or the next request is rejected.
        session.history.push(...this.model.toolResultTurn(results));
        session.history = this.model.compact(session.history, { phase: "step", contextChanged: false });
      }
    } catch (error) {
      yield {
        type: "done",
        ok: false,
        error: isAbort(error, request.signal) ? "Stopped." : error instanceof Error ? error.message : String(error),
        stats: stats(),
      };
    } finally {
      session.busy = false;
      await host?.close().catch(() => {});
    }
  }

  private openSession(id: string | undefined): Session<M> {
    const existing = id ? this.sessions.get(id) : undefined;
    const session = existing ?? { id: randomUUID(), history: [], busy: false };
    // Re-inserting keeps the Map in least-recently-used order.
    this.sessions.delete(session.id);
    this.sessions.set(session.id, session);
    const max = this.options.maxSessions ?? 20;
    for (const [key, value] of this.sessions) {
      if (this.sessions.size <= max) break;
      if (!value.busy) this.sessions.delete(key);
    }
    return session;
  }

  private async *completeWithRetry(
    session: Session<M>,
    host: IToolHost,
    systemPrompt: string,
    request: LlmRunRequest,
  ): AsyncGenerator<LlmEvent, ModelTurn<M>> {
    const maxRetries = this.options.maxRetries ?? 3;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.model.complete({
          history: session.history,
          tools: host.tools,
          systemPrompt,
          model: request.model,
          effort: request.effort,
          signal: request.signal,
        });
      } catch (error) {
        if (!(error instanceof ProviderHttpError) || !error.retryable || attempt > maxRetries || request.signal?.aborted) {
          throw error;
        }
        yield { type: "retry", attempt, reason: error.message };
        const delay = this.options.retryDelayMs?.(attempt, error) ?? Math.min(error.retryAfterMs ?? 1000 * 2 ** attempt, 60_000);
        await sleep(delay, request.signal);
      }
    }
  }

  private async execute(host: IToolHost, call: ToolCall, signal?: AbortSignal): Promise<ToolOutcome> {
    if (call.inputError) return { text: `Error: ${call.inputError}`, images: [], isError: true };
    if (!host.tools.some((tool) => tool.name === call.name)) {
      return { text: `Error: there is no tool named "${call.name}".`, images: [], isError: true };
    }
    try {
      const outcome = await host.call(call.name, call.input, signal);
      if (this.model.vision || outcome.images.length === 0) return outcome;
      const note = "[The tool also returned an image, which this model cannot view.]";
      return { ...outcome, images: [], text: outcome.text ? `${outcome.text}\n${note}` : note };
    } catch (error) {
      if (isAbort(error, signal)) return CANCELLED;
      return { text: `Error: ${error instanceof Error ? error.message : String(error)}`, images: [], isError: true };
    }
  }
}
