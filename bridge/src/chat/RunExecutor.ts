import type { LlmImage } from "../llm/LlmRunner.js";
import type { ChatSink } from "./chatUpdates.js";
import type { ResolvedProvider } from "./providerResolver.js";

export interface JobRequest {
  prompt: string;
  systemPrompt: string;
  /** MCP endpoint of this job: scoped to its sprite whenever there is one. */
  mcpUrl: string;
  images?: LlmImage[];
  sessionId?: string;
  /** False for jobs nobody will follow up on (one of N variations), so no warm process lingers. */
  keepAlive?: boolean;
}

export interface JobPresentation {
  /** Prefixed to the model's replies, so parallel jobs stay distinguishable ("Variation 2: ..."). */
  label?: string;
  /** Parallel jobs would interleave dozens of tool calls; progress events replace them. */
  quietTools?: boolean;
}

export interface JobOutcome {
  ok: boolean;
  /** Set when the run failed for a reason other than the user pressing Stop. */
  error?: string;
  aborted: boolean;
  sessionId?: string;
  durationMs: number;
  turns?: number;
  costUsd?: number;
}

/**
 * Runs one model job to completion and streams its events to the chat. Never throws:
 * parallel callers need every job's outcome, not the first failure.
 */
export async function executeRun(
  provider: ResolvedProvider,
  job: JobRequest,
  sink: ChatSink,
  signal: AbortSignal,
  presentation: JobPresentation = {},
): Promise<JobOutcome> {
  const started = Date.now();
  const prefix = presentation.label ? `${presentation.label}: ` : "";
  const outcome: JobOutcome = { ok: false, aborted: false, durationMs: 0 };

  if (signal.aborted) return { ...outcome, aborted: true };

  try {
    const events = provider.runner.run({
      prompt: job.prompt,
      systemPrompt: job.systemPrompt,
      mcpUrl: job.mcpUrl,
      images: provider.info.supportsImages && job.images?.length ? job.images : undefined,
      sessionId: job.sessionId,
      model: provider.model,
      effort: provider.effort,
      keepAlive: job.keepAlive,
      signal,
    });
    let finished = false;
    let lastText: string | undefined;
    // Text between tool calls is the model thinking aloud ("frame 3 is good, now frame 2"),
    // and after the last one it often checks its work before answering: only the last
    // block, the actual reply in the user's language, reaches the chat.
    for await (const event of events) {
      switch (event.type) {
        case "session":
          outcome.sessionId = event.sessionId;
          break;
        case "text":
          lastText = event.text;
          break;
        case "tool":
          if (!presentation.quietTools) sink({ kind: "tool", name: event.name });
          break;
        case "retry":
          sink({ kind: "status", text: `${prefix}Model is busy, retrying (attempt ${event.attempt})...` });
          break;
        case "done":
          finished = true;
          outcome.ok = event.ok;
          if (!event.ok) outcome.error = event.error ?? "The model run failed.";
          outcome.turns = event.stats?.turns;
          outcome.costUsd = event.stats?.costUsd;
          break;
      }
    }
    if (lastText && outcome.ok) sink({ kind: "text", text: prefix + lastText });
    if (!finished && !outcome.ok) outcome.error ??= "The model run ended without a result.";
  } catch (error) {
    outcome.ok = false;
    outcome.error = error instanceof Error ? error.message : String(error);
  }

  outcome.durationMs = Date.now() - started;
  if (signal.aborted && !outcome.ok) {
    // The provider reports a kill as a failure; for the user it is just "stopped".
    return { ...outcome, aborted: true, error: undefined };
  }
  return outcome;
}
