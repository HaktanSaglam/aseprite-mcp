import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AnthropicApiRunner, AnthropicChatModel, type AnthropicMessage, type AnthropicSettings } from "../src/llm/AnthropicApiRunner.js";
import type { LlmEvent, LlmRunRequest } from "../src/llm/LlmRunner.js";
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

const THINKING = { type: "thinking", thinking: "", signature: "sig-1" };
const usage = { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 7 };

const toolUse = (input: Record<string, unknown>, name = "paint") => ({
  id: "msg_1",
  role: "assistant",
  stop_reason: "tool_use",
  content: [THINKING, { type: "text", text: "Painting." }, { type: "tool_use", id: "toolu_1", name, input }],
  usage,
});

const answer = (text: string) => ({
  id: "msg_2",
  role: "assistant",
  stop_reason: "end_turn",
  content: [{ type: "text", text }],
  usage,
});

const apiError = (message: string) => ({ type: "error", error: { type: "invalid_request_error", message } });

describe("AnthropicApiRunner (mock server + real MCP server)", () => {
  let mcp: McpTestServer;
  let api: MockHttpServer;

  const runner = (overrides: Partial<AnthropicSettings> = {}) =>
    new AnthropicApiRunner(
      { apiKey: "sk-ant-test", baseUrl: api.url, defaultModel: "claude-opus-5-5", authHint: "Set ANTHROPIC_API_KEY.", ...overrides },
      { retryDelayMs: () => 1 },
    );
  const request = (overrides: Partial<LlmRunRequest> = {}): LlmRunRequest => ({
    prompt: "paint it blue",
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

  it("runs the tool loop with image tool results and replays assistant turns verbatim", async () => {
    api.reply({ json: toolUse({ color: "blue" }) }, { json: answer("Done.") });
    const events = await collect(runner().run(request({ effort: "xhigh" })));

    expect(events.map((e) => e.type)).toEqual(["session", "text", "tool", "text", "done"]);
    expect(last(events)).toMatchObject({ ok: true, stats: { turns: 2, inputTokens: 200, outputTokens: 14 } });
    expect(mcp.calls).toEqual([{ name: "paint", args: { color: "blue" } }]);

    const [first, second] = api.requests;
    expect(first!.path).toBe("/v1/messages");
    expect(first!.headers["x-api-key"]).toBe("sk-ant-test");
    expect(first!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(String(first!.headers["anthropic-beta"]).split(",")).toEqual([
      "context-management-2025-06-27",
      "server-side-fallback-2026-07-01",
    ]);
    expect(first!.body).toMatchObject({
      model: "claude-opus-5-5",
      output_config: { effort: "xhigh" },
      cache_control: { type: "ephemeral" },
      fallbacks: "default",
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    });
    expect(first!.body.thinking).toBeUndefined();
    expect(first!.body.system[0].text).toContain(MCP_INSTRUCTIONS);
    expect(first!.body.system[0].text).toContain("REQUEST SYSTEM PROMPT");
    expect(first!.body.tools.find((t: any) => t.name === "paint").input_schema.properties.color.type).toBe("string");

    const messages: AnthropicMessage[] = second!.body.messages;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[1]!.content[0]).toEqual(THINKING);
    expect(messages[2]!.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: [
          { type: "text", text: "painted blue" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: TINY_PNG } },
        ],
      },
    ]);
  });

  it("drops an optional feature the API rejects and keeps it off", async () => {
    const r = runner();
    api.reply({ status: 400, json: apiError("context_management: Extra inputs are not permitted") }, { json: answer("ok") });
    const events = await collect(r.run(request()));
    expect(last(events)).toMatchObject({ ok: true });
    expect(api.requests).toHaveLength(2);
    expect(api.requests[1]!.body.context_management).toBeUndefined();
    expect(api.requests[1]!.headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");

    await collect(r.run(request()));
    expect(api.requests[2]!.body.context_management).toBeUndefined();
  });

  it("does not ask for server-side fallbacks on models without them", async () => {
    api.reply({ json: answer("ok") });
    await collect(runner().run(request({ model: "claude-haiku-5-5" })));
    expect(api.requests[0]!.body.fallbacks).toBeUndefined();
    expect(api.requests[0]!.headers["anthropic-beta"]).toBe("context-management-2025-06-27");
  });

  it("strips thinking blocks and retries when their signature no longer matches", async () => {
    const r = runner();
    api.reply({ json: toolUse({ color: "red" }) }, { json: answer("first done") });
    const sessionId = sessionOf(await collect(r.run(request())));
    api.reply(
      { status: 400, json: apiError("messages.1.content.0: Invalid `signature` in `thinking` block.") },
      { json: answer("second done") },
    );
    const events = await collect(r.run(request({ sessionId, prompt: "again" })));
    expect(last(events)).toMatchObject({ ok: true });
    const retried: AnthropicMessage[] = api.requests[3]!.body.messages;
    expect(retried[1]!.content.map((b) => b.type)).toEqual(["text", "tool_use"]);
  });

  it("reports refusals without replaying the declined answer", async () => {
    const r = runner();
    api.reply({ json: { content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" }, usage } });
    const events = await collect(r.run(request()));
    expect(last(events)).toMatchObject({ ok: false, error: expect.stringContaining("declined this request (cyber)") });

    api.reply({ json: answer("ok") });
    await collect(r.run(request({ sessionId: sessionOf(events), prompt: "draw a tree" })));
    // The declined message is not sent again with the follow-up.
    const messages: AnthropicMessage[] = api.requests[1]!.body.messages;
    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: "draw a tree" }] }]);
  });

  it("shows HTTP status and message with the key hint", async () => {
    api.reply({ status: 401, json: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } });
    const events = await collect(runner().run(request()));
    expect(last(events)).toMatchObject({
      ok: false,
      error: "Anthropic API error (HTTP 401): invalid x-api-key Set ANTHROPIC_API_KEY.",
    });
  });

  it("retries overload errors", async () => {
    api.reply({ status: 529, json: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }, { json: answer("ok") });
    const events = await collect(runner().run(request()));
    expect(events.map((e) => e.type)).toEqual(["session", "retry", "text", "done"]);
  });
});

describe("AnthropicChatModel.compact", () => {
  const model = new AnthropicChatModel({ apiKey: "k", baseUrl: "http://unused", defaultModel: "claude-opus-5-5" });
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } };
  const thinkingTurn: AnthropicMessage = { role: "assistant", content: [THINKING, { type: "text", text: "ok" }] };

  it("leaves a small history untouched, thinking included", () => {
    const history: AnthropicMessage[] = [{ role: "user", content: [image, { type: "text", text: "hi" }] }, thinkingTurn];
    expect(model.compact(history, { phase: "run_start", contextChanged: false })).toBe(history);
  });

  it("drops old images and every thinking block once the history carries too many images", () => {
    const history: AnthropicMessage[] = [];
    for (let i = 0; i < 10; i++) {
      history.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: [image] }] }, thinkingTurn);
    }
    const out = model.compact(history, { phase: "run_start", contextChanged: false });
    const images = out.flatMap((m) => m.content).filter((b) => b.type === "tool_result" && b.content[0].type === "image");
    expect(images).toHaveLength(2);
    expect(out.flatMap((m) => m.content).some((b) => b.type === "thinking")).toBe(false);
    // The newest images are the ones kept.
    expect(out[out.length - 2]!.content[0]!.content[0].type).toBe("image");
  });

  it("drops thinking blocks when the system prompt or tools changed", () => {
    const out = model.compact([{ role: "user", content: [{ type: "text", text: "x" }] }, thinkingTurn], {
      phase: "run_start",
      contextChanged: true,
    });
    expect(out[1]!.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("never edits history mid-run", () => {
    const history: AnthropicMessage[] = Array.from({ length: 12 }, () => ({ role: "user" as const, content: [image] }));
    expect(model.compact(history, { phase: "step", contextChanged: false })).toBe(history);
  });
});
