import { describe, expect, it, vi } from "vitest";
import { ChatService } from "../src/chat/ChatService.js";
import { GenerationService } from "../src/chat/GenerationService.js";
import type { InstantToolRequest } from "../src/chat/InstantToolService.js";
import { SessionStore } from "../src/chat/SessionStore.js";
import { SingleRunService } from "../src/chat/SingleRunService.js";
import type { LlmEvent, ProviderInfo } from "../src/llm/LlmRunner.js";
import { mcpUrls } from "../src/mcp/httpServer.js";
import {
  CLAUDE_INFO,
  defaultScript,
  FakeEvents,
  FakeGateway,
  FakeRegistry,
  FakeRunner,
  hangingScript,
  until,
} from "./chatFakes.js";

const URLS = mcpUrls("127.0.0.1", 7800);

function harness(providers: ProviderInfo[] = [CLAUDE_INFO]) {
  const gateway = new FakeGateway();
  const events = new FakeEvents();
  const runner = new FakeRunner();
  const codex = new FakeRunner(defaultScript("codex-1"));
  const registry = new FakeRegistry(providers, { "claude-code": runner, codex });
  const sessions = new SessionStore();
  const instantTools = { run: vi.fn(async (_request: InstantToolRequest) => ({ ok: true, text: "Outlined." })) };
  const service = new ChatService({
    events,
    registry,
    singleRun: new SingleRunService({ gateway, mcpUrls: URLS, sessions }),
    generation: new GenerationService({ gateway, mcpUrlFor: URLS.forSprite, sessions, maxParallelRuns: 2 }),
    instantTools,
    sessions,
    version: "9.9.9",
  });
  service.attach();

  let finishedRuns = 0;
  /** Sends a request and waits for its busy:false. */
  const send = async (fields: Record<string, unknown>) => {
    const target = events.chat("busy").filter((e) => e.busy === false).length + 1;
    events.emit({ event: "chat_send", ...fields });
    await until(() => events.chat("busy").filter((e) => e.busy === false).length >= target);
    finishedRuns = target;
  };
  return { gateway, events, runner, codex, registry, sessions, instantTools, send, finished: () => finishedRuns };
}

describe("ChatService: bridge_info", () => {
  it("answers hello with version, providers and the default provider", async () => {
    const { events } = harness();
    events.emit({ event: "hello", asepriteVersion: "1.3.18" });
    await until(() => events.sent.some((e) => e.event === "bridge_info"));
    expect(events.sent.find((e) => e.event === "bridge_info")).toEqual({
      event: "bridge_info",
      version: "9.9.9",
      providers: [CLAUDE_INFO],
      defaultProvider: "claude-code",
    });
  });

  it("forgets conversations on hello (sprite ids restart with Aseprite)", async () => {
    const { events, sessions } = harness();
    sessions.set("claude-code", 1, "old");
    events.emit({ event: "hello" });
    expect(sessions.get("claude-code", 1)).toBeUndefined();
  });

  it("keeps conversations when the same Aseprite instance reconnects", async () => {
    const { events, sessions } = harness();
    events.emit({ event: "hello", instance: "a" });
    sessions.set("claude-code", 1, "kept");
    events.emit({ event: "hello", instance: "a" });
    expect(sessions.get("claude-code", 1)).toBe("kept");
    events.emit({ event: "hello", instance: "b" });
    expect(sessions.get("claude-code", 1)).toBeUndefined();
  });
});

describe("ChatService: chat", () => {
  it("runs bound to the sprite and streams busy, tool, text and done with stats", async () => {
    const { gateway, events, runner, send } = harness();
    const sprite = gateway.addSprite({ id: 4 }, true);
    await send({ text: "make it darker", sprite: sprite.id });

    const kinds = events.chat().map((e) => e.kind);
    expect(kinds).toEqual(["busy", "tool", "text", "done", "busy"]);
    const done = events.chat("done")[0];
    expect(done.stats).toMatchObject({ turns: 3, costUsd: 0.01 });
    expect(typeof (done.stats as { durationMs: number }).durationMs).toBe("number");

    const request = runner.requests[0];
    expect(request.mcpUrl).toBe("http://127.0.0.1:7800/mcp/sprite/4");
    expect(request.model).toBe("opus");
    expect(request.effort).toBe("medium");
    expect(request.prompt).toMatch(/^make it darker/);
    expect(request.prompt).toMatch(/Current canvas: sprite #4/);
    expect(request.images).toHaveLength(1);
    expect(request.systemPrompt).toMatch(/pixel art/);
  });

  it("uses the active sprite when the UI sends none, and skips the preview of an empty canvas", async () => {
    const { gateway, runner, send } = harness();
    gateway.addSprite({ id: 6 });
    await send({ text: "hello" });
    expect(runner.requests[0].mcpUrl).toBe(URLS.forSprite(6));
    expect(runner.requests[0].images).toBeUndefined();
  });

  it("passes provider, model and effort choices through", async () => {
    const providers = [CLAUDE_INFO, { ...CLAUDE_INFO, id: "codex", label: "Codex", models: [{ id: "gpt-5", label: "GPT-5" }], efforts: ["low" as const, "high" as const], supportsImages: false }];
    const { gateway, runner, codex, send } = harness(providers);
    gateway.addSprite({ id: 1 }, true);
    await send({ text: "x", options: { model: "sonnet", effort: "max" } });
    expect(runner.requests[0]).toMatchObject({ model: "sonnet", effort: "max" });

    await send({ text: "x", options: { provider: "codex", effort: "medium" } });
    expect(codex.requests[0]).toMatchObject({ model: "gpt-5", effort: "low" });
    expect(codex.requests[0].images).toBeUndefined();
  });

  it("continues the conversation per sprite and provider; chat_reset starts over", async () => {
    const providers = [CLAUDE_INFO, { ...CLAUDE_INFO, id: "codex", label: "Codex" }];
    const { gateway, events, runner, codex, send } = harness(providers);
    gateway.addSprite({ id: 1 });
    gateway.addSprite({ id: 2 });

    await send({ text: "a", sprite: 1 });
    await send({ text: "b", sprite: 1 });
    await send({ text: "c", sprite: 2 });
    expect(runner.requests.map((r) => r.sessionId)).toEqual([undefined, "s-1", undefined]);

    await send({ text: "d", sprite: 1, options: { provider: "codex" } });
    expect(codex.requests[0].sessionId).toBeUndefined();
    await send({ text: "e", sprite: 1 });
    expect(runner.requests[3].sessionId).toBeUndefined(); // codex took over sprite 1's conversation

    events.emit({ event: "chat_reset" });
    expect(events.chat("status").at(-1)?.text).toBe("New conversation.");
    await send({ text: "f", sprite: 2 });
    expect(runner.requests[4].sessionId).toBeUndefined();
  });

  it("works without any open sprite through the unscoped endpoint and keys the session to the new sprite", async () => {
    const { gateway, runner, send } = harness();
    runner.script = async function* () {
      gateway.addSprite({ id: 11 }); // the model called create_sprite
      yield { type: "session", sessionId: "created" } satisfies LlmEvent;
      yield { type: "done", ok: true } satisfies LlmEvent;
    };
    await send({ text: "draw a tree", options: { size: { width: 48, height: 48 } } });
    expect(runner.requests[0].mcpUrl).toBe(URLS.unscoped);
    expect(runner.requests[0].prompt).toMatch(/No sprite is open.*48x48/);

    runner.script = defaultScript();
    await send({ text: "add apples", sprite: 11 });
    expect(runner.requests[1].sessionId).toBe("created");
  });

  it("reports a failed run as an error without done", async () => {
    const { gateway, events, runner, send } = harness();
    gateway.addSprite();
    runner.script = async function* () {
      yield { type: "done", ok: false, error: "Claude CLI login expired." } satisfies LlmEvent;
    };
    await send({ text: "x" });
    expect(events.chat("error").map((e) => e.text)).toEqual(["Claude CLI login expired."]);
    expect(events.chat("done")).toHaveLength(0);
  });
});

describe("ChatService: validation", () => {
  it("rejects invalid and incomplete requests before going busy", async () => {
    const { events, runner } = harness();
    events.emit({ event: "chat_send", text: "x", options: { count: 99 } });
    events.emit({ event: "chat_send", text: "   " });
    events.emit({ event: "chat_send", action: "batch", options: { items: [] } });
    await until(() => events.chat("error").length === 3);
    expect(events.chat("error").map((e) => e.text)).toEqual([
      expect.stringMatching(/^Invalid chat request \(options\.count/),
      "Type a message first.",
      "Add the items to draw (one per line) for a batch.",
    ]);
    expect(events.chat("busy")).toHaveLength(0);
    expect(runner.requests).toHaveLength(0);
  });

  it("explains unknown providers", async () => {
    const { gateway, events, send } = harness();
    gateway.addSprite();
    await send({ text: "x", options: { provider: "gemini" } });
    expect(events.chat("error")[0].text).toBe('Unknown AI provider "gemini". Available: claude-code.');
  });

  it("needs an open sprite for edits", async () => {
    const { events, send } = harness();
    await send({ action: "review" });
    expect(events.chat("error")[0].text).toBe("Open or create a sprite first.");
  });

  it("needs a selection for edit_selection and something to review", async () => {
    const { gateway, events, runner, send } = harness();
    gateway.addSprite({ id: 1 });
    await send({ action: "edit_selection", sprite: 1 });
    await send({ action: "review", sprite: 1 });
    expect(events.chat("error").map((e) => e.text)).toEqual([
      "Select an area first (Rectangular Marquee tool, M), then try again.",
      "The sprite is empty: there is nothing to review yet.",
    ]);
    expect(runner.requests).toHaveLength(0);
  });
});

describe("ChatService: actions", () => {
  it("creates the sprite for generate before the run and binds the run to it", async () => {
    const { gateway, runner, send, sessions } = harness();
    gateway.addSprite({ id: 1 }, true);
    let existedAtStart = false;
    runner.script = async function* (request) {
      existedAtStart = gateway.sprites.has(2);
      yield* defaultScript("gen")(request);
    };
    await send({ action: "generate", text: "a red potion", sprite: 1, options: { size: { width: 24, height: 16 }, style: "pico8" } });
    expect(existedAtStart).toBe(true);

    expect(gateway.callsOf("createSprite")[0].args[0]).toEqual({ width: 24, height: 16, colorMode: "rgb", name: "red potion" });
    const request = runner.requests[0];
    expect(request.mcpUrl).toBe(URLS.forSprite(2));
    expect(request.prompt).toMatch(/^Create pixel art: a red potion/);
    expect(request.prompt).toMatch(/new empty 24x16 sprite/);
    expect(request.prompt).toMatch(/PICO-8/);
    expect(request.images).toBeUndefined();
    expect(sessions.get("claude-code", 2)).toBe("gen");
  });

  it("generates into the current sprite for target new_layer", async () => {
    const { gateway, runner, send } = harness();
    gateway.addSprite({ id: 1 }, true);
    await send({ action: "generate", text: "a cloud", sprite: 1, options: { target: "new_layer" } });
    expect(gateway.callsOf("createSprite")).toHaveLength(0);
    expect(runner.requests[0].mcpUrl).toBe(URLS.forSprite(1));
    expect(runner.requests[0].prompt).toMatch(/new layer named after the subject/);
    expect(runner.requests[0].images).toHaveLength(1);
  });

  it("edits the selection with a preview attached", async () => {
    const { gateway, runner, send } = harness();
    gateway.addSprite({ id: 1 });
    await send({ action: "edit_selection", text: "add a hat", sprite: 1, selection: { x: 1, y: 1, width: 8, height: 8 } });
    expect(runner.requests[0].prompt).toMatch(/Redraw the selected area \(x=1, y=1, 8x8\): add a hat/);
    expect(runner.requests[0].images).toHaveLength(1); // edits always see the canvas
  });

  it("prepares frames, durations and the tag before an animation run", async () => {
    const { gateway, runner, send } = harness();
    gateway.addSprite({ id: 1 }, true);
    await send({ action: "animate", sprite: 1, options: { animation: { preset: "idle", frames: 4, frameMs: 150, loop: true } } });

    expect(gateway.callsOf("frameOp").map((c) => c.args[0])).toEqual([
      { op: "add", after: 1, count: 3, copy: true },
      { op: "duration", durationMs: 150 },
    ]);
    expect(gateway.callsOf("tagOp")[0].args[0]).toEqual({ op: "add", name: "idle", from: 1, to: 4, direction: "forward", repeats: 0 });
    const prompt = runner.requests[0].prompt;
    expect(prompt).toMatch(/Frames 1-4 are already set up/);
    expect(prompt).toMatch(/frames: 4 \(150 ms each\)/);
    expect(prompt).toMatch(/preview of frames 1-4/);
  });

  it("leaves frame setup to the model when the sprite is already animated", async () => {
    const { gateway, runner, send } = harness();
    gateway.addSprite({ id: 1, frames: [{ index: 1, durationMs: 100 }, { index: 2, durationMs: 100 }] }, true);
    await send({ action: "animate", text: "jump", sprite: 1, options: { animation: { preset: "jump" } } });
    expect(gateway.callsOf("frameOp")).toHaveLength(0);
    expect(runner.requests[0].prompt).toMatch(/Add the frames you need with manage_frames/);
  });

  it("routes variations to parallel generation", async () => {
    const { gateway, events, runner, send } = harness();
    await send({ action: "variations", text: "a slime", options: { count: 2 } });
    expect(gateway.callsOf("createSprite")).toHaveLength(2);
    expect(runner.requests.map((r) => r.mcpUrl).sort()).toEqual([URLS.forSprite(1), URLS.forSprite(2)]);
    expect(events.chat("progress").map((e) => e.done)).toEqual([0, 1, 2]);
    expect(events.chat("done")[0].stats).toMatchObject({ turns: 6, costUsd: 0.02 });
  });
});

describe("ChatService: lifecycle", () => {
  it("refuses a second request while busy", async () => {
    const { gateway, events, runner } = harness();
    gateway.addSprite();
    let started = false;
    runner.script = hangingScript(() => (started = true));
    events.emit({ event: "chat_send", text: "first" });
    await until(() => started);
    events.emit({ event: "chat_send", text: "second" });
    expect(events.chat("error").at(-1)?.text).toMatch(/Still working on the previous request/);
    events.emit({ event: "chat_cancel" });
    await until(() => events.chat("busy").length === 2);
    expect(runner.requests).toHaveLength(1);
  });

  it("chat_cancel stops the run: Stopped status, no error, no done", async () => {
    const { gateway, events, runner } = harness();
    gateway.addSprite();
    let started = false;
    runner.script = hangingScript(() => (started = true));
    events.emit({ event: "chat_send", text: "x" });
    await until(() => started);
    events.emit({ event: "chat_cancel" });
    await until(() => events.chat("busy").length === 2);
    expect(runner.requests[0].signal?.aborted).toBe(true);
    expect(events.chat().map((e) => [e.kind, e.text ?? e.busy])).toEqual([
      ["busy", true],
      ["status", "Stopped."],
      ["busy", false],
    ]);
  });

  it("chat_cancel stops every parallel job", async () => {
    const { events, runner } = harness();
    let started = 0;
    runner.script = hangingScript(() => started++);
    events.emit({ event: "chat_send", action: "variations", text: "x", options: { count: 4 } });
    await until(() => started === 2); // maxParallelRuns = 2
    events.emit({ event: "chat_cancel" });
    await until(() => events.chat("busy").length === 2);
    expect(runner.requests).toHaveLength(2); // queued jobs never started
    expect(runner.requests.every((r) => r.signal?.aborted)).toBe(true);
    expect(events.chat("error")).toHaveLength(0);
    expect(events.chat("status").at(-1)?.text).toBe("Stopped.");
  });

  it("a reset during a run also drops the session that run stores when it ends", async () => {
    const { gateway, events, runner, sessions } = harness();
    gateway.addSprite({ id: 1 });
    let started = false;
    runner.script = hangingScript(() => (started = true));
    events.emit({ event: "chat_send", text: "x", sprite: 1 });
    await until(() => started);
    events.emit({ event: "chat_reset" });
    await until(() => events.chat("busy").length === 2);
    expect(sessions.get("claude-code", 1)).toBeUndefined();
  });

  it("stops running jobs when Aseprite disconnects", async () => {
    const { gateway, events, runner } = harness();
    gateway.addSprite();
    let started = false;
    runner.script = hangingScript(() => (started = true));
    events.emit({ event: "chat_send", text: "x" });
    await until(() => started);
    events.setConnected(false);
    await until(() => events.chat("busy").length === 2);
    expect(runner.requests[0].signal?.aborted).toBe(true);
  });
});

describe("ChatService: tool_run", () => {
  it("runs instant tools and answers with the request id", async () => {
    const { events, instantTools } = harness();
    events.emit({ event: "tool_run", requestId: 7, tool: "add_outline", params: { color: "#000000" }, sprite: 3 });
    await until(() => events.sent.some((e) => e.event === "tool_result"));
    expect(instantTools.run).toHaveBeenCalledWith({ tool: "add_outline", params: { color: "#000000" }, sprite: 3 });
    expect(events.sent.find((e) => e.event === "tool_result")).toEqual({ event: "tool_result", requestId: 7, ok: true, text: "Outlined." });
  });

  it("answers malformed tool requests instead of leaving the UI waiting", async () => {
    const { events, instantTools } = harness();
    events.emit({ event: "tool_run", requestId: "r1", params: {} });
    await until(() => events.sent.some((e) => e.event === "tool_result"));
    expect(events.sent.find((e) => e.event === "tool_result")).toMatchObject({ requestId: "r1", ok: false });
    expect(instantTools.run).not.toHaveBeenCalled();
  });

  it("runs instant tools even while a chat request is busy", async () => {
    const { gateway, events, runner } = harness();
    gateway.addSprite();
    let started = false;
    runner.script = hangingScript(() => (started = true));
    events.emit({ event: "chat_send", text: "x" });
    await until(() => started);
    events.emit({ event: "tool_run", requestId: 1, tool: "undo", params: {} });
    await until(() => events.sent.some((e) => e.event === "tool_result"));
    events.emit({ event: "chat_cancel" });
    await until(() => events.chat("busy").length === 2);
  });
});
