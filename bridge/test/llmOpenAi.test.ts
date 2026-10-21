import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sanitizeSchema, toToolOutcome } from "../src/llm/agent/McpToolHost.js";
import type { LlmEvent, LlmRunRequest } from "../src/llm/LlmRunner.js";
import { OpenAiChatModel, type OpenAiMessage, OpenAiCompatibleRunner, type OpenAiSettings } from "../src/llm/OpenAiCompatibleRunner.js";
import {
  MCP_INSTRUCTIONS,
  type McpTestServer,
  type MockHttpServer,
  startMcpTestServer,
  startMockHttpServer,
  TINY_PNG,
} from "./fixtures/llm/testServers.js";

async function collect(events: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function last(events: LlmEvent[]) {
  return events[events.length - 1]!;
}

function sessionOf(events: LlmEvent[]): string {
  const event = events.find((e) => e.type === "session");
  if (event?.type !== "session") throw new Error("no session");
  return event.sessionId;
}

const toolCall = (name: string, args: string, id = "call_1") => ({
  choices: [
    {
      finish_reason: "tool_calls",
      message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] },
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 10 },
});

const answer = (text: string) => ({
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }],
  usage: { prompt_tokens: 150, completion_tokens: 5 },
});

describe("OpenAiCompatibleRunner (mock server + real MCP server)", () => {
  let mcp: McpTestServer;
  let api: MockHttpServer;

  const settings = (overrides: Partial<OpenAiSettings> = {}): OpenAiSettings => ({
    label: "OpenAI",
    baseUrl: `${api.url}/v1`,
    apiKey: "sk-test",
    defaultModel: "gpt-test",
    reasoningEffort: false,
    maxReasoningEffort: "high",
    vision: true,
    authHint: "Set OPENAI_API_KEY.",
    ...overrides,
  });
  const runner = (overrides: Partial<OpenAiSettings> = {}) =>
    new OpenAiCompatibleRunner(settings(overrides), { retryDelayMs: () => 1 });
  const request = (overrides: Partial<LlmRunRequest> = {}): LlmRunRequest => ({
    prompt: "paint it red",
    mcpUrl: mcp.url,
    systemPrompt: "REQUEST SYSTEM PROMPT",
    ...overrides,
  });

  beforeAll(async () => {
    mcp = await startMcpTestServer();
    api = await startMockHttpServer();
  });
  afterAll(async () => {
    await mcp.close();
    await api.close();
  });
  beforeEach(() => {
    api.requests.length = 0;
    mcp.calls.length = 0;
  });

  it("loops model → MCP tool → model and streams events", async () => {
    api.reply({ json: toolCall("paint", '{"color":"red"}') }, { json: answer("Painted it red.") });
    const events = await collect(runner().run(request()));

    expect(events.map((e) => e.type)).toEqual(["session", "tool", "text", "done"]);
    expect(events[1]).toEqual({ type: "tool", name: "paint" });
    expect(events[2]).toEqual({ type: "text", text: "Painted it red." });
    expect(last(events)).toMatchObject({ ok: true, stats: { turns: 2, inputTokens: 250, outputTokens: 15 } });
    expect(mcp.calls).toEqual([{ name: "paint", args: { color: "red" } }]);

    const [first, second] = api.requests;
    expect(first!.path).toBe("/v1/chat/completions");
    expect(first!.headers.authorization).toBe("Bearer sk-test");
    expect(first!.body.model).toBe("gpt-test");
    expect(first!.body.reasoning_effort).toBeUndefined();
    const system = first!.body.messages[0];
    expect(system.role).toBe("system");
    expect(system.content).toContain(MCP_INSTRUCTIONS);
    expect(system.content).toContain("REQUEST SYSTEM PROMPT");
    const paint = first!.body.tools.find((t: any) => t.function.name === "paint");
    expect(paint.function.parameters.type).toBe("object");
    expect(paint.function.parameters.properties.color.type).toBe("string");
    expect(JSON.stringify(first!.body.tools)).not.toContain("$schema");
    expect(JSON.stringify(first!.body.tools)).not.toContain("propertyNames");

    const messages = second!.body.messages;
    expect(messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(messages[2].tool_calls[0]).toEqual({ id: "call_1", type: "function", function: { name: "paint", arguments: '{"color":"red"}' } });
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "painted red" });
    expect(messages[4].content[1]).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${TINY_PNG}` } });
  });

  it("remembers the conversation for follow-ups", async () => {
    const r = runner();
    api.reply({ json: answer("Hi!") });
    const sessionId = sessionOf(await collect(r.run(request({ prompt: "hello" }))));
    api.reply({ json: answer("Darker now.") });
    const events = await collect(r.run(request({ prompt: "make it darker", sessionId })));
    expect(sessionOf(events)).toBe(sessionId);
    const messages = api.requests[1]!.body.messages;
    expect(messages.map((m: any) => m.content)).toEqual([expect.any(String), "hello", "Hi!", "make it darker"]);
  });

  it("attaches request images to the user message", async () => {
    api.reply({ json: answer("I see it.") });
    await collect(runner().run(request({ images: [{ mediaType: "image/png", base64: TINY_PNG }] })));
    const user = api.requests[0]!.body.messages[1];
    expect(user.content.map((p: any) => p.type)).toEqual(["image_url", "text"]);
  });

  it("maps effort to reasoning_effort, clamped, and drops it when the model rejects it", async () => {
    const r = runner({ reasoningEffort: true, maxReasoningEffort: "high" });
    api.reply(
      { status: 400, json: { error: { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model." } } },
      { json: answer("ok") },
    );
    const events = await collect(r.run(request({ effort: "max" })));
    expect(last(events)).toMatchObject({ ok: true });
    expect(api.requests[0]!.body.reasoning_effort).toBe("high");
    expect(api.requests[1]!.body.reasoning_effort).toBeUndefined();

    api.reply({ json: answer("ok") });
    await collect(r.run(request({ effort: "low" })));
    expect(api.requests[2]!.body.reasoning_effort).toBeUndefined();
  });

  it("sends supported efforts as-is", async () => {
    api.reply({ json: answer("ok") });
    await collect(runner({ reasoningEffort: true, maxReasoningEffort: "max" }).run(request({ effort: "xhigh" })));
    expect(api.requests[0]!.body.reasoning_effort).toBe("xhigh");
  });

  it("shows HTTP status, provider message and the key hint", async () => {
    api.reply({ status: 401, json: { error: { message: "Incorrect API key provided: sk-test." } } });
    const events = await collect(runner().run(request()));
    expect(last(events)).toMatchObject({
      ok: false,
      error: "OpenAI error (HTTP 401): Incorrect API key provided: sk-test. Set OPENAI_API_KEY.",
    });
  });

  it("retries rate limits and reports the retry", async () => {
    api.reply({ status: 429, json: { error: { message: "Rate limit reached" } } }, { json: answer("ok") });
    const events = await collect(runner().run(request()));
    expect(events.map((e) => e.type)).toEqual(["session", "retry", "text", "done"]);
    expect(events[1]).toMatchObject({ attempt: 1, reason: expect.stringContaining("HTTP 429") });
    expect(last(events)).toMatchObject({ ok: true });
  });

  it("returns invalid arguments and unknown tools to the model as errors", async () => {
    api.reply(
      { json: toolCall("paint", "{not json") },
      { json: toolCall("nope", "{}", "call_2") },
      { json: answer("giving up") },
    );
    const events = await collect(runner().run(request()));
    expect(last(events)).toMatchObject({ ok: true });
    expect(mcp.calls).toHaveLength(0);
    expect(api.requests[1]!.body.messages[3].content).toMatch(/^Error: tool arguments are not valid JSON/);
    expect(api.requests[2]!.body.messages[5].content).toBe('Error: there is no tool named "nope".');
  });

  it("passes tool failures back to the model", async () => {
    api.reply({ json: toolCall("explode", "{}") }, { json: answer("That failed.") });
    await collect(runner().run(request()));
    expect(api.requests[1]!.body.messages[3].content).toMatch(/^Error: .*kaboom/);
  });

  it("keeps images out of the conversation for models without vision", async () => {
    api.reply({ json: toolCall("paint", '{"color":"blue"}') }, { json: answer("done") });
    await collect(runner({ vision: false }).run(request({ images: [{ mediaType: "image/png", base64: TINY_PNG }] })));
    const messages = api.requests[1]!.body.messages;
    expect(messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(messages[1].content).toBe("paint it red");
    expect(messages[3].content).toContain("cannot view");
  });

  it("stops after the step limit", async () => {
    api.reply({ json: toolCall("paint", '{"color":"red"}') });
    const r = new OpenAiCompatibleRunner(settings(), { maxSteps: 2 });
    const events = await collect(r.run(request()));
    expect(last(events)).toMatchObject({ ok: false, error: expect.stringMatching(/after 2 steps.*continue/) });
    expect(mcp.calls).toHaveLength(2);
  });

  it("can be stopped while waiting for the model", async () => {
    api.reply({ json: answer("late"), delayMs: 2000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const events = await collect(runner().run(request({ signal: controller.signal })));
    expect(last(events)).toMatchObject({ ok: false, error: "Stopped." });
  });

  it("fails clearly when the tool server is unreachable", async () => {
    const events = await collect(runner().run(request({ mcpUrl: "http://127.0.0.1:1/mcp" })));
    expect(last(events)).toMatchObject({ ok: false, error: expect.stringContaining("Cannot reach the Aseprite tools") });
  });

  it("asks for a model when none is configured", async () => {
    const events = await collect(runner({ defaultModel: undefined }).run(request()));
    expect(last(events)).toMatchObject({ ok: false, error: expect.stringContaining("no model selected") });
  });

  it("refuses a second message while one is running in the same conversation", async () => {
    const r = runner();
    api.reply({ json: answer("first") });
    const sessionId = sessionOf(await collect(r.run(request())));
    api.reply({ json: answer("slow"), delayMs: 300 });
    const slow = collect(r.run(request({ sessionId })));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const busy = await collect(r.run(request({ sessionId })));
    expect(last(busy)).toMatchObject({ ok: false, error: expect.stringContaining("still working") });
    expect(last(await slow)).toMatchObject({ ok: true });
  });
});

describe("OpenAiChatModel", () => {
  const model = new OpenAiChatModel({
    label: "Test",
    baseUrl: "http://unused",
    reasoningEffort: false,
    maxReasoningEffort: "high",
    vision: true,
  });

  it("keeps only the newest images when compacting", () => {
    const image = { type: "image_url" as const, image_url: { url: "data:image/png;base64,AAA" } };
    const history: OpenAiMessage[] = Array.from({ length: 5 }, () => ({ role: "user" as const, content: [image] }));
    const compacted = model.compact(history, { phase: "step", contextChanged: false });
    const kinds = compacted.map((m) => (Array.isArray(m.content) ? (m.content[0] as { type: string }).type : "text"));
    expect(kinds).toEqual(["text", "text", "image_url", "image_url", "image_url"]);
    // The original history is not mutated.
    expect((history[0]!.content as { type: string }[])[0]!.type).toBe("image_url");
  });

  it("puts tool images in one user message after all tool messages", () => {
    const img = { mediaType: "image/png" as const, base64: "AAA" };
    const turn = model.toolResultTurn([
      { call: { id: "a", name: "view", input: {} }, outcome: { text: "", images: [img], isError: false } },
      { call: { id: "b", name: "fail", input: {} }, outcome: { text: "bad input", images: [], isError: true } },
    ]);
    expect(turn.map((m) => m.role)).toEqual(["tool", "tool", "user"]);
    expect(turn[0]).toMatchObject({ content: "(image attached below)" });
    expect(turn[1]).toMatchObject({ content: "Error: bad input" });
  });
});

describe("MCP conversion helpers", () => {
  it("cleans JSON schemas for strict providers", () => {
    expect(
      sanitizeSchema({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { p: { type: "object", propertyNames: { type: "string" }, additionalProperties: { type: "string" } } },
      }),
    ).toEqual({ type: "object", properties: { p: { type: "object", additionalProperties: { type: "string" } } } });
    expect(sanitizeSchema(undefined)).toEqual({ type: "object", properties: {} });
  });

  it("splits MCP content into text and PNG images", () => {
    expect(
      toToolOutcome({
        content: [
          { type: "text", text: "a" },
          { type: "image", data: "AAA", mimeType: "image/png" },
          { type: "image", data: "BBB", mimeType: "image/jpeg" },
        ],
        isError: true,
      }),
    ).toEqual({ text: "a\n[image of type image/jpeg omitted]", images: [{ mediaType: "image/png", base64: "AAA" }], isError: true });
  });
});
