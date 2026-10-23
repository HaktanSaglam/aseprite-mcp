import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { ToolCallingAgent } from "../src/llm/agent/ToolCallingAgent.js";
import type { CompactContext, CompletionRequest, IChatModel, IToolHost, ModelTurn, ToolResult } from "../src/llm/agent/types.js";
import { ensureOk, providerMessage, ProviderHttpError, requestJson } from "../src/llm/http/httpJson.js";
import type { LlmEvent, LlmImage, LlmRunRequest } from "../src/llm/LlmRunner.js";

type Msg = { role: string; text: string };

/** Scripted model: each `complete` call takes the next scripted turn (or throws it). */
class FakeModel implements IChatModel<Msg> {
  readonly label = "Fake";
  readonly vision = true;
  readonly requests: CompletionRequest<Msg>[] = [];
  readonly compactions: CompactContext[] = [];
  constructor(private readonly script: (ModelTurn<Msg> | Error)[]) {}

  userTurn(text: string, _images: LlmImage[]): Msg[] {
    return [{ role: "user", text }];
  }
  async complete(request: CompletionRequest<Msg>): Promise<ModelTurn<Msg>> {
    this.requests.push({ ...request, history: [...request.history] });
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    return next;
  }
  toolResultTurn(results: ToolResult[]): Msg[] {
    return results.map((r) => ({ role: "tool", text: `${r.call.id}:${r.outcome.text}` }));
  }
  compact(history: Msg[], context: CompactContext): Msg[] {
    this.compactions.push(context);
    return history;
  }
}

const say = (text: string): ModelTurn<Msg> => ({ message: { role: "assistant", text }, texts: [text], toolCalls: [] });
const callTools = (...names: string[]): ModelTurn<Msg> => ({
  message: { role: "assistant", text: `calls ${names.join(",")}` },
  texts: [],
  toolCalls: names.map((name, i) => ({ id: `c${i + 1}`, name, input: {} })),
});

function host(call: IToolHost["call"], instructions = "INSTR"): IToolHost {
  return {
    instructions,
    tools: [{ name: "slow", description: "", inputSchema: { type: "object", properties: {} } }, { name: "fast", description: "", inputSchema: { type: "object", properties: {} } }],
    call,
    close: async () => {},
  };
}

async function collect(events: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const request = (overrides: Partial<LlmRunRequest> = {}): LlmRunRequest => ({
  prompt: "go",
  mcpUrl: "http://unused/mcp",
  systemPrompt: "SYS",
  ...overrides,
});

function sessionOf(events: LlmEvent[]): string {
  const e = events.find((x) => x.type === "session");
  if (e?.type !== "session") throw new Error("no session");
  return e.sessionId;
}

describe("ToolCallingAgent", () => {
  it("cancels the remaining tool calls on abort but keeps the history valid", async () => {
    const controller = new AbortController();
    const model = new FakeModel([callTools("slow", "fast"), say("after")]);
    const agent = new ToolCallingAgent(model, {
      connect: async () =>
        host(
          (_name, _input, signal) =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
              setTimeout(() => controller.abort(), 10);
            }),
        ),
    });
    const events = await collect(agent.run(request({ signal: controller.signal })));
    expect(events.map((e) => e.type)).toEqual(["session", "tool", "done"]);
    expect(events[2]).toMatchObject({ ok: false, error: "Stopped." });

    // The follow-up sends tool results for both calls, so the provider accepts the history.
    await collect(agent.run(request({ sessionId: sessionOf(events), prompt: "next" })));
    expect(model.requests[1]!.history.map((m) => m.text)).toEqual([
      "go",
      "calls slow,fast",
      "c1:Cancelled: the user stopped the run.",
      "c2:Cancelled: the user stopped the run.",
      "next",
    ]);
  });

  it("retries retryable errors a bounded number of times", async () => {
    const overloaded = () => new ProviderHttpError("Fake error (HTTP 529): Overloaded", 529, true);
    const model = new FakeModel([overloaded(), overloaded(), overloaded()]);
    const agent = new ToolCallingAgent(model, { connect: async () => host(async () => ({ text: "", images: [], isError: false })), maxRetries: 2, retryDelayMs: () => 1 });
    const events = await collect(agent.run(request()));
    expect(events.filter((e) => e.type === "retry")).toHaveLength(2);
    expect(events[events.length - 1]).toMatchObject({ ok: false, error: "Fake error (HTTP 529): Overloaded" });
  });

  it("does not retry other errors", async () => {
    const model = new FakeModel([new ProviderHttpError("Fake error (HTTP 400): bad", 400, false)]);
    const agent = new ToolCallingAgent(model, { connect: async () => host(async () => ({ text: "", images: [], isError: false })) });
    const events = await collect(agent.run(request()));
    expect(events.map((e) => e.type)).toEqual(["session", "done"]);
  });

  it("tells the model when the system prompt or tools changed between messages", async () => {
    const model = new FakeModel([say("a"), say("b"), say("c")]);
    let instructions = "v1";
    const agent = new ToolCallingAgent(model, { connect: async () => host(async () => ({ text: "", images: [], isError: false }), instructions) });
    const sessionId = sessionOf(await collect(agent.run(request())));
    await collect(agent.run(request({ sessionId })));
    instructions = "v2";
    await collect(agent.run(request({ sessionId })));
    expect(model.compactions.filter((c) => c.phase === "run_start").map((c) => c.contextChanged)).toEqual([false, false, true]);
  });

  it("forgets the least recently used conversations", async () => {
    const model = new FakeModel([say("a"), say("b"), say("c")]);
    const agent = new ToolCallingAgent(model, { connect: async () => host(async () => ({ text: "", images: [], isError: false })), maxSessions: 1 });
    const first = sessionOf(await collect(agent.run(request())));
    await collect(agent.run(request()));
    const again = sessionOf(await collect(agent.run(request({ sessionId: first }))));
    expect(again).not.toBe(first);
  });

  it("drops a message that was declined before any answer", async () => {
    const model = new FakeModel([{ texts: [], toolCalls: [], error: "declined" }, say("ok")]);
    const agent = new ToolCallingAgent(model, { connect: async () => host(async () => ({ text: "", images: [], isError: false })) });
    const events = await collect(agent.run(request({ prompt: "bad" })));
    expect(events[events.length - 1]).toMatchObject({ ok: false, error: "declined" });
    await collect(agent.run(request({ sessionId: sessionOf(events), prompt: "good" })));
    expect(model.requests[1]!.history.map((m) => m.text)).toEqual(["good"]);
  });
});

describe("httpJson", () => {
  it("explains refused connections without retrying them", async () => {
    const error = await requestJson("http://127.0.0.1:1/v1/models").catch((e) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ retryable: false, message: expect.stringContaining("connection refused") });
  });

  it("times out slow servers with a retryable error", async () => {
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const error = await requestJson(url, { timeoutMs: 50 }).catch((e) => e);
    server.closeAllConnections();
    server.close();
    expect(error).toMatchObject({ retryable: true, message: expect.stringContaining("No response") });
  });

  it("reads provider error shapes", () => {
    const response = (json: unknown, text = "") => ({ status: 400, json, text, headers: {} });
    expect(providerMessage(response({ error: { message: "openai style" } }))).toBe("openai style");
    expect(providerMessage(response({ type: "error", error: { type: "x", message: "anthropic style" } }))).toBe("anthropic style");
    expect(providerMessage(response({ error: "ollama style" }))).toBe("ollama style");
    expect(providerMessage(response([{ error: { message: "google style" } }]))).toBe("google style");
    expect(providerMessage(response(undefined, "<html>Bad gateway</html>"))).toBe("<html>Bad gateway</html>");
  });

  it("marks overload as retryable and honours retry-after", () => {
    const error = (() => {
      try {
        ensureOk("Fake", { status: 503, json: { error: { message: "busy" } }, text: "", headers: { "retry-after": "7" } });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toMatchObject({ status: 503, retryable: true, retryAfterMs: 7000, message: "Fake error (HTTP 503): busy" });
  });
});
